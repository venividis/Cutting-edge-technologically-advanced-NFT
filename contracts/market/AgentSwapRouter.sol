// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ExactERC20} from "../libraries/ExactERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAnima, AgentStatus} from "../interfaces/IAnima.sol";

interface IAnimaSwapView {
    function accountOf(uint256 agentId) external view returns (address);
    function statusOf(uint256 agentId) external view returns (AgentStatus);
    function guardianOf(uint256 agentId) external view returns (address);
}

/**
 * @title AgentSwapRouter — the only door an agent should be allowed to trade through
 * @notice Executes swaps on behalf of an agent against any allowlisted venue, under
 *         per-token budgets its owner set, verifying the result by balance delta.
 *
 * @dev This contract exists because of a gap in every "give the AI a spending limit" design,
 *      including the one in {AgentAccount}: those limits cap `msg.value`, i.e. *native*
 *      currency. An agent calling `swap(USDC -> anything)` moves a million dollars with
 *      `value == 0` and sails straight through a native-denominated cap. Token budgets have
 *      to be denominated in the token.
 *
 *      So an owner sets a per-token `perSwap` and `daily` allowance here, allowlists the
 *      venues, and then allowlists *only this router* in the agent's {AutonomyPolicy}. The
 *      agent's reach is now genuinely bounded rather than nominally bounded.
 *
 *      Two further properties worth stating:
 *
 *      **Output is verified, not trusted.** The router measures the recipient's balance
 *      before and after the venue call and requires the delta to clear `minOut`. A venue
 *      that lies about its return value, or a route that silently partially fills, fails
 *      here. Reading a DEX's return value instead is how integrations get drained by a
 *      venue that was later upgraded.
 *
 *      **Approvals never outlive the call.** The router approves exactly `amountIn` and
 *      zeroes it in the same transaction, so a compromised venue cannot come back later for
 *      the rest. Dangling approvals are the single most exploited pattern in DeFi.
 */
contract AgentSwapRouter is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using ExactERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct TokenLimit {
        uint128 perSwap; //   maximum single-swap input; zero means the token is not tradeable
        uint128 daily; //     rolling per-day input allowance
        uint128 spentToday;
        uint64 day;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC721 public immutable AGENTS;
    IAnimaSwapView public immutable ANIMA;

    /// @notice Venues the router will call. Governance-managed and deliberately small: an
    ///         agent trading through an unvetted contract is an agent being drained by one.
    mapping(address venue => bool) public isVenue;

    mapping(uint256 agentId => mapping(address token => TokenLimit)) private _limits;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event VenueSet(address indexed venue, bool allowed);
    event LimitSet(uint256 indexed agentId, address indexed token, uint128 perSwap, uint128 daily);
    event Swapped(
        uint256 indexed agentId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address venue
    );

    error NotAgentAccount(uint256 agentId, address caller);
    error NotAgentOwner(uint256 agentId, address caller);
    error AgentNotActive(uint256 agentId, AgentStatus status);
    error VenueNotAllowed(address venue);
    error TokenNotTradeable(uint256 agentId, address token);
    error PerSwapCapExceeded(uint256 amount, uint128 cap);
    error DailyCapExceeded(uint256 wouldBe, uint128 cap);
    error SlippageExceeded(uint256 received, uint256 minOut);
    error Expired(uint256 deadline);
    error SameToken();
    error VenueCallFailed(bytes reason);
    error ZeroAmount();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IERC721 agents_, IAnimaSwapView anima_, address owner_) Ownable(owner_) {
        AGENTS = agents_;
        ANIMA = anima_;
    }

    function setVenue(address venue, bool allowed) external onlyOwner {
        isVenue[venue] = allowed;
        emit VenueSet(venue, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                                 LIMITS
    //////////////////////////////////////////////////////////////*/

    function limitOf(uint256 agentId, address token) external view returns (TokenLimit memory) {
        return _limits[agentId][token];
    }

    /// @notice Set what an agent may trade, and how much of it. Owner only.
    function setLimit(uint256 agentId, address token, uint128 perSwap, uint128 daily) external {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        TokenLimit storage lim = _limits[agentId][token];
        lim.perSwap = perSwap;
        lim.daily = daily;
        emit LimitSet(agentId, token, perSwap, daily);
    }

    /// @notice Immediately stop an agent trading a token. Callable by the owner *or* the
    ///         guardian, so the emergency brake does not require the owner to be awake.
    function revokeToken(uint256 agentId, address token) external {
        if (msg.sender != AGENTS.ownerOf(agentId) && msg.sender != ANIMA.guardianOf(agentId)) {
            revert NotAgentOwner(agentId, msg.sender);
        }
        TokenLimit storage lim = _limits[agentId][token];
        lim.perSwap = 0;
        lim.daily = 0;
        emit LimitSet(agentId, token, 0, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                  SWAP
    //////////////////////////////////////////////////////////////*/

    struct SwapRequest {
        uint256 agentId;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint256 deadline;
        address venue;
        bytes venueCalldata;
    }

    /// @notice Swap on behalf of an agent. Callable only by that agent's ERC-6551 account,
    ///         which is where its funds live and whose session keys are already leashed.
    function swap(SwapRequest calldata r) external nonReentrant returns (uint256 amountOut) {
        address account = ANIMA.accountOf(r.agentId);
        if (msg.sender != account) revert NotAgentAccount(r.agentId, msg.sender);
        if (block.timestamp > r.deadline) revert Expired(r.deadline);
        if (r.amountIn == 0) revert ZeroAmount();
        if (r.tokenIn == r.tokenOut) revert SameToken();
        if (!isVenue[r.venue]) revert VenueNotAllowed(r.venue);

        // A paused or disputed agent must not be able to move funds, or the guardian's kill
        // switch is decorative.
        AgentStatus status = ANIMA.statusOf(r.agentId);
        if (status != AgentStatus.Active) revert AgentNotActive(r.agentId, status);

        _chargeLimit(r.agentId, r.tokenIn, r.amountIn);

        // Keep balances that predate this call segregated. Accidental transfers and venue
        // residue belong to neither this agent nor this swap and must not become a windfall.
        uint256 inputBefore = IERC20(r.tokenIn).balanceOf(address(this));
        IERC20(r.tokenIn).transferFromExact(account, address(this), r.amountIn);

        uint256 before = IERC20(r.tokenOut).balanceOf(address(this));

        IERC20(r.tokenIn).forceApprove(r.venue, r.amountIn);
        (bool ok, bytes memory reason) = r.venue.call(r.venueCalldata);
        if (!ok) revert VenueCallFailed(reason);
        // Zero it unconditionally: a venue that consumed less than the allowance would
        // otherwise keep a standing claim on this router's balance.
        IERC20(r.tokenIn).forceApprove(r.venue, 0);

        // Trust the ledger, not the venue's return value.
        amountOut = IERC20(r.tokenOut).balanceOf(address(this)) - before;
        if (amountOut < r.minOut) revert SlippageExceeded(amountOut, r.minOut);

        IERC20(r.tokenOut).transferExact(account, amountOut);

        // Return only this swap's unconsumed input, never a balance that was already here.
        uint256 dust = IERC20(r.tokenIn).balanceOf(address(this)) - inputBefore;
        if (dust != 0) IERC20(r.tokenIn).transferExact(account, dust);

        emit Swapped(r.agentId, r.tokenIn, r.tokenOut, r.amountIn, amountOut, r.venue);
    }

    function _chargeLimit(uint256 agentId, address token, uint256 amountIn) private {
        TokenLimit storage lim = _limits[agentId][token];
        if (lim.perSwap == 0) revert TokenNotTradeable(agentId, token);
        if (amountIn > lim.perSwap) revert PerSwapCapExceeded(amountIn, lim.perSwap);

        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = lim.day == today ? lim.spentToday : 0;
        uint256 wouldBe = spent + amountIn;
        if (wouldBe > lim.daily) revert DailyCapExceeded(wouldBe, lim.daily);

        lim.day = today;
        lim.spentToday = wouldBe.toUint128();
    }

    /// @notice How much more of `token` this agent may trade today.
    function remainingToday(uint256 agentId, address token) external view returns (uint256) {
        TokenLimit storage lim = _limits[agentId][token];
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = lim.day == today ? lim.spentToday : 0;
        return lim.daily > spent ? lim.daily - spent : 0;
    }
}
