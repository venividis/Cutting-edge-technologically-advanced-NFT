// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title AgentToken — a launch token with a floor under it
 * @notice The fungible token of a single ANIMA agent. Holders share in what the agent earns,
 *         and can always redeem their pro-rata slice of the treasury by burning.
 *
 * @dev The redemption mechanism is lifted from ERC-7641 (Intrinsic RevShare), and it is the
 *      reason to launch an agent here rather than on a bonding-curve casino.
 *
 *      A pump.fun-style token is backed by nothing: its price is whatever the last buyer
 *      paid, and when attention moves on it goes to zero. This token's price cannot go below
 *      `treasury / totalSupply`, because at any lower price anyone can buy tokens, burn
 *      them, and take out more than they put in. The floor is not a promise or a buyback
 *      programme someone has to remember to run — it is an arbitrage that enforces itself.
 *
 *      The treasury fills from the agent's actual revenue: escrow settlements, metered
 *      per-call fees, and a share of trading fees on its own launch curve. So the floor
 *      rises exactly insofar as the agent is genuinely useful, which is the incentive you
 *      want and the one these markets almost never have.
 *
 *      Burning is pro-rata over `totalSupply`, so redeeming never dilutes the remaining
 *      holders: the floor per token is invariant across a redemption, and strictly
 *      increasing in revenue.
 */
contract AgentToken is ERC20, ERC20Permit, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The asset the treasury is denominated in. An ERC-20 by design — supporting
    ///         native currency here would mean a payable surface on a token contract, and
    ///         every chain has a wrapped equivalent.
    IERC20 public immutable QUOTE;

    /// @notice The ANIMA agent this token represents a claim on.
    address public immutable ANIMA;
    uint256 public immutable AGENT_ID;

    /// @notice Redeemable treasury. Tracked explicitly rather than read from `balanceOf`, so
    ///         a stray transfer of the quote asset cannot silently move the floor and a
    ///         donation-based rounding attack has nothing to grip.
    uint256 public treasury;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event RevenueReceived(address indexed from, uint256 amount, uint256 treasury);
    event Redeemed(address indexed holder, uint256 burned, uint256 received, uint256 treasury);

    error ZeroAmount();
    error NothingToRedeem();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 quote_,
        address anima_,
        uint256 agentId_,
        uint256 supply_,
        address supplyRecipient_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        QUOTE = quote_;
        ANIMA = anima_;
        AGENT_ID = agentId_;
        // Fixed supply, minted once at construction. There is no mint function, so the floor
        // can never be diluted by issuing more claims against the same treasury.
        _mint(supplyRecipient_, supply_);
    }

    /*//////////////////////////////////////////////////////////////
                                 REVENUE
    //////////////////////////////////////////////////////////////*/

    /// @notice Route revenue into the treasury. Permissionless: the agent's own token bound
    ///         account, an escrow module, a sponsor, or the launch curve's fee split.
    function contribute(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        QUOTE.safeTransferFrom(msg.sender, address(this), amount);
        treasury += amount;
        emit RevenueReceived(msg.sender, amount, treasury);
    }

    /// @notice Recognise quote assets sent here by a plain transfer. Anyone may call it; the
    ///         effect is only ever to raise the floor.
    function sync() external nonReentrant returns (uint256 recognised) {
        uint256 held = QUOTE.balanceOf(address(this));
        recognised = held - treasury;
        if (recognised != 0) {
            treasury = held;
            emit RevenueReceived(address(0), recognised, held);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                REDEEM
    //////////////////////////////////////////////////////////////*/

    /// @notice Burn tokens and take the corresponding slice of the treasury.
    /// @dev The share is computed against `totalSupply` *before* the burn, which is what
    ///      makes redemption neutral for everyone else: floor per token is unchanged.
    function redeem(uint256 amount) external nonReentrant returns (uint256 payout) {
        if (amount == 0) revert ZeroAmount();

        uint256 supply = totalSupply();
        uint256 pool = treasury;
        payout = (pool * amount) / supply;
        if (payout == 0) revert NothingToRedeem();

        treasury = pool - payout;
        _burn(msg.sender, amount);

        QUOTE.safeTransfer(msg.sender, payout);
        emit Redeemed(msg.sender, amount, payout, treasury);
    }

    /// @notice Quote asset backing one whole token, scaled by 1e18. The hard floor below
    ///         which the market price cannot durably trade.
    function floorPerToken() external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 0 : (treasury * 1e18) / supply;
    }

    function previewRedeem(uint256 amount) external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 0 : (treasury * amount) / supply;
    }
}
