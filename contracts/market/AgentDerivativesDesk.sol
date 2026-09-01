// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {AgentStatus} from "../interfaces/IAnima.sol";

interface IAnimaDeskView {
    function accountOf(uint256 agentId) external view returns (address);
    function statusOf(uint256 agentId) external view returns (AgentStatus);
    function guardianOf(uint256 agentId) external view returns (address);
}

/**
 * @title IPerpVenueAdapter
 * @notice Thin read adapter over a perpetuals venue, so the desk can check what a position
 *         actually became rather than what the agent said it would be.
 * @dev The adapter validates venue-specific calldata before the desk forwards it, then reports
 *      what happened. This binds the call to the authenticated account and allowed market while
 *      still measuring the resulting position instead of trusting the call's return value.
 */
interface IPerpVenueAdapter {
    /// @notice Validate that an opaque venue call targets the authenticated account and market.
    /// @dev Implementations must reject every unsupported selector and malformed payload.
    function validateTradeCalldata(address account, bytes32 market, bytes calldata venueCalldata)
        external
        view
        returns (bool);

    /// @return Absolute notional of `account`'s open position in `market`, in quote units.
    function positionNotional(address account, bytes32 market) external view returns (uint256);
}

/**
 * @title AgentDerivativesDesk — a leash that survives leverage
 * @notice Lets an agent trade perpetual futures through allowlisted venues, under notional and
 *         leverage limits its owner published, verified against the venue after every trade.
 *
 * @dev **The gap this closes.** {AgentAccount} caps native value; {AgentSwapRouter} caps
 *      per-token spot volume. Neither bounds a leveraged position. An agent with a $1,000 daily
 *      budget can post $1,000 of margin and carry $50,000 of notional exposure, and every
 *      existing limit reports that it behaved perfectly right up until liquidation. Leverage is
 *      a separate risk axis and needs a separate cap, or "the agent has a spending limit" is a
 *      sentence that means nothing on a venue that offers 50x.
 *
 *      This matters more in 2026 than it did: agents can now reach regulated and onchain
 *      perpetuals directly — Coinbase's agent surfaces and Base's DeFi MCP both expose
 *      perpetuals trading to an agent harness, so the distance between "my agent has a wallet"
 *      and "my agent is short the AI index at 10x" is one tool call.
 *
 *      **Three quantities, and only one of them is trusted.**
 *
 *      - `marginAtRisk` is measured, not declared: quote tokens that left the agent's account
 *        for the venue, minus what came back. The desk moves the funds itself, so this is
 *        arithmetic rather than a claim.
 *      - `positionNotional` is read from an allowlisted adapter after the venue call. It is only
 *        as honest as the adapter, which is why adapters are governance-set and per-venue.
 *      - Leverage is derived from those two, so an agent cannot understate it by understating
 *        either half.
 *
 *      **What this does not do.** It does not prevent a loss, monitor a position between trades,
 *      or liquidate anything. It bounds the size of the bet at the moment it is placed and
 *      refuses to let an agent enlarge it past what its owner allowed. A position that moves
 *      against the agent afterwards is a market outcome, not a policy breach.
 */
contract AgentDerivativesDesk is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct MarketLimit {
        uint128 maxNotional; //     absolute open notional permitted, in quote units
        uint128 maxMarginAtRisk; // cumulative collateral this agent may have out on this market
        uint16 maxLeverageX100; //  300 = 3.00x; zero disallows the market entirely
        bool allowed;
    }

    struct Position {
        uint128 marginAtRisk;
        uint128 lastNotional;
        uint64 lastTradeAt;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable QUOTE;
    IERC721 public immutable AGENTS;
    IAnimaDeskView public immutable ANIMA;

    mapping(address venue => IPerpVenueAdapter) public adapterOf;

    mapping(uint256 agentId => mapping(bytes32 market => MarketLimit)) private _limits;
    mapping(uint256 agentId => mapping(bytes32 market => Position)) private _positions;
    /// @notice Total collateral this agent has out across every market, for a portfolio cap.
    mapping(uint256 agentId => uint128) public totalMarginAtRisk;
    mapping(uint256 agentId => uint128) public maxTotalMarginAtRisk;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event VenueSet(address indexed venue, address indexed adapter);
    event LimitSet(uint256 indexed agentId, bytes32 indexed market, uint128 maxNotional, uint128 maxMarginAtRisk, uint16 maxLeverageX100);
    event PortfolioLimitSet(uint256 indexed agentId, uint128 maxTotalMarginAtRisk);
    event Traded(
        uint256 indexed agentId,
        bytes32 indexed market,
        address indexed venue,
        uint256 marginIn,
        uint256 marginOut,
        uint256 notionalAfter,
        uint256 marginAtRisk
    );

    error NotAgentAccount(uint256 agentId, address caller);
    error NotAgentOwner(uint256 agentId, address caller);
    error AgentNotActive(uint256 agentId, AgentStatus status);
    error MarketNotAllowed(uint256 agentId, bytes32 market);
    error VenueNotAllowed(address venue);
    error NotionalCapExceeded(uint256 notional, uint128 cap);
    error MarginCapExceeded(uint256 marginAtRisk, uint128 cap);
    error PortfolioCapExceeded(uint256 total, uint128 cap);
    error LeverageCapExceeded(uint256 leverageX100, uint16 cap);
    error VenueCallFailed(bytes reason);
    error InvalidVenueCalldata(address venue, address account, bytes32 market);
    error Expired(uint256 deadline);
    error BadLeverage(uint16 maxLeverageX100);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 quote_, IERC721 agents_, IAnimaDeskView anima_, address owner_) Ownable(owner_) {
        QUOTE = quote_;
        AGENTS = agents_;
        ANIMA = anima_;
    }

    /// @notice Allowlist a venue and the adapter that reports its positions. Setting the adapter
    ///         to zero removes the venue.
    function setVenue(address venue, IPerpVenueAdapter adapter) external onlyOwner {
        adapterOf[venue] = adapter;
        emit VenueSet(venue, address(adapter));
    }

    /*//////////////////////////////////////////////////////////////
                                 LIMITS
    //////////////////////////////////////////////////////////////*/

    function limitOf(uint256 agentId, bytes32 market) external view returns (MarketLimit memory) {
        return _limits[agentId][market];
    }

    function positionOf(uint256 agentId, bytes32 market) external view returns (Position memory) {
        return _positions[agentId][market];
    }

    /// @notice Publish what this agent may risk on a market. Owner only.
    /// @param maxLeverageX100 Hundredths of a multiple. 100 is unleveraged; zero closes the
    ///        market. There is no unlimited setting, because there is no honest reason for one.
    function setLimit(
        uint256 agentId,
        bytes32 market,
        uint128 maxNotional,
        uint128 maxMarginAtRisk,
        uint16 maxLeverageX100
    ) external {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (maxLeverageX100 != 0 && maxLeverageX100 < 100) revert BadLeverage(maxLeverageX100);

        _limits[agentId][market] = MarketLimit({
            maxNotional: maxNotional,
            maxMarginAtRisk: maxMarginAtRisk,
            maxLeverageX100: maxLeverageX100,
            allowed: maxLeverageX100 != 0
        });
        emit LimitSet(agentId, market, maxNotional, maxMarginAtRisk, maxLeverageX100);
    }

    function setPortfolioLimit(uint256 agentId, uint128 maxTotal) external {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        maxTotalMarginAtRisk[agentId] = maxTotal;
        emit PortfolioLimitSet(agentId, maxTotal);
    }

    /// @notice Close a market to an agent immediately. Owner or guardian, so the brake does not
    ///         wait for the owner to wake up.
    function haltMarket(uint256 agentId, bytes32 market) external {
        if (msg.sender != AGENTS.ownerOf(agentId) && msg.sender != ANIMA.guardianOf(agentId)) {
            revert NotAgentOwner(agentId, msg.sender);
        }
        MarketLimit storage lim = _limits[agentId][market];
        lim.allowed = false;
        lim.maxLeverageX100 = 0;
        emit LimitSet(agentId, market, lim.maxNotional, lim.maxMarginAtRisk, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                  TRADE
    //////////////////////////////////////////////////////////////*/

    struct TradeRequest {
        uint256 agentId;
        bytes32 market;
        address venue;
        uint256 marginIn; //   collateral to post with this trade; may be zero when reducing
        uint256 deadline;
        bytes venueCalldata;
    }

    /// @notice Open, enlarge, reduce or close a position. One entry point, because the limits
    ///         that matter are evaluated on the resulting state rather than on the intent.
    function trade(TradeRequest calldata r) external nonReentrant returns (uint256 notionalAfter) {
        address account = ANIMA.accountOf(r.agentId);
        if (msg.sender != account) revert NotAgentAccount(r.agentId, msg.sender);
        if (block.timestamp > r.deadline) revert Expired(r.deadline);

        IPerpVenueAdapter adapter = adapterOf[r.venue];
        if (address(adapter) == address(0)) revert VenueNotAllowed(r.venue);

        AgentStatus status = ANIMA.statusOf(r.agentId);
        if (status != AgentStatus.Active) revert AgentNotActive(r.agentId, status);

        MarketLimit memory lim = _limits[r.agentId][r.market];
        if (!lim.allowed) revert MarketNotAllowed(r.agentId, r.market);
        if (!adapter.validateTradeCalldata(account, r.market, r.venueCalldata)) {
            revert InvalidVenueCalldata(r.venue, account, r.market);
        }

        // ---- move collateral, measuring both directions ----
        uint256 heldBefore = QUOTE.balanceOf(address(this));
        if (r.marginIn != 0) {
            QUOTE.safeTransferFrom(account, address(this), r.marginIn);
            QUOTE.forceApprove(r.venue, r.marginIn);
        }

        (bool ok, bytes memory reason) = r.venue.call(r.venueCalldata);
        if (!ok) revert VenueCallFailed(reason);
        QUOTE.forceApprove(r.venue, 0);

        // Whatever the venue did not consume, plus anything it returned, goes straight back.
        uint256 heldAfter = QUOTE.balanceOf(address(this));
        uint256 returned = heldAfter > heldBefore ? heldAfter - heldBefore : 0;
        if (returned != 0) QUOTE.safeTransfer(account, returned);

        uint256 consumed = r.marginIn > returned ? r.marginIn - returned : 0;
        uint256 refunded = returned > r.marginIn ? returned - r.marginIn : 0;

        // ---- update measured collateral at risk ----
        Position storage pos = _positions[r.agentId][r.market];
        uint256 marginAtRisk = uint256(pos.marginAtRisk) + consumed;
        marginAtRisk = marginAtRisk > refunded ? marginAtRisk - refunded : 0;

        uint256 total = uint256(totalMarginAtRisk[r.agentId]) + consumed;
        total = total > refunded ? total - refunded : 0;

        // ---- enforce against what the position ACTUALLY became ----
        notionalAfter = adapter.positionNotional(account, r.market);

        if (notionalAfter > lim.maxNotional) revert NotionalCapExceeded(notionalAfter, lim.maxNotional);
        if (marginAtRisk > lim.maxMarginAtRisk) revert MarginCapExceeded(marginAtRisk, lim.maxMarginAtRisk);
        uint128 portfolioCap = maxTotalMarginAtRisk[r.agentId];
        if (portfolioCap != 0 && total > portfolioCap) revert PortfolioCapExceeded(total, portfolioCap);

        if (notionalAfter != 0) {
            // A position with notional and no measured collateral is either cross-margined from
            // elsewhere or an adapter reporting nonsense. Either way it is unbounded leverage as
            // far as this desk can tell, so it is refused rather than divided by zero.
            if (marginAtRisk == 0) revert LeverageCapExceeded(type(uint256).max, lim.maxLeverageX100);
            uint256 observedLeverageX100 = (notionalAfter * 100) / marginAtRisk;
            if (observedLeverageX100 > lim.maxLeverageX100) revert LeverageCapExceeded(observedLeverageX100, lim.maxLeverageX100);
        }

        pos.marginAtRisk = marginAtRisk.toUint128();
        pos.lastNotional = notionalAfter.toUint128();
        pos.lastTradeAt = uint64(block.timestamp);
        totalMarginAtRisk[r.agentId] = total.toUint128();

        emit Traded(r.agentId, r.market, r.venue, r.marginIn, refunded, notionalAfter, marginAtRisk);
    }

    /// @notice Current leverage on a market, in hundredths, as this desk measures it.
    function leverageX100(uint256 agentId, bytes32 market) external view returns (uint256) {
        Position storage pos = _positions[agentId][market];
        if (pos.marginAtRisk == 0) return 0;
        return (uint256(pos.lastNotional) * 100) / pos.marginAtRisk;
    }
}
