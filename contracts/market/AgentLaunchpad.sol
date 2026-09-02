// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ExactERC20} from "../libraries/ExactERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {AgentToken} from "./AgentToken.sol";
import {ILiquidityDeployer} from "./ILiquidityDeployer.sol";

interface IAnimaAccounts {
    function accountOf(uint256 agentId) external view returns (address);
}

/**
 * @title AgentLaunchpad — a fair-ish launch that leaves something behind
 * @notice Bonding-curve issuance for an agent's {AgentToken}, graduating into locked AMM
 *         liquidity once the curve fills.
 *
 * @dev Three deliberate departures from the standard bonding-curve launchpad, each aimed at
 *      a specific way those launches extract from buyers:
 *
 *      1. **A fair window with a per-address cap.** The first blocks of a launch are where
 *         snipers take the entire cheap end of the curve and sell it back to everyone else.
 *         For a configurable opening period no address may buy more than `maxBuyInWindow`.
 *         This does not defeat a determined sybil, and pretending otherwise would be a lie —
 *         it raises the cost from "one bot, one transaction" to "many funded addresses",
 *         which is the honest amount of protection a permissionless curve can offer.
 *
 *      2. **Fees route into the token's redemption treasury.** A share of every trade goes to
 *         {AgentToken.contribute}, which raises the floor every holder can redeem at. Trading
 *         activity therefore leaves durable value in the token instead of only in the
 *         deployer's fee wallet.
 *
 *      3. **Graduation liquidity is locked by construction.** The LP recipient is fixed when
 *         the launch is created and is visible to every buyer before they buy, so "the
 *         team pulled the LP" is not a thing that can happen after the fact.
 *
 *      Curve mechanics are constant-product over augmented reserves, with every rounding
 *      decision made against the trader. A curve that rounds in the trader's favour can be
 *      drained a wei at a time by a loop.
 */
contract AgentLaunchpad is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using ExactERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Launch {
        address token;
        address creator;
        uint256 agentId;
        uint128 quoteReserve; //     augmented quote reserve (starts at the virtual amount)
        uint128 baseReserve; //      augmented base reserve
        uint128 initialQuote; //     the virtual seed, so raised = quoteReserve - initialQuote
        uint128 curveSupply; //      maximum tokens the curve may ever sell
        uint128 baseSold;
        uint128 graduationTarget; // raised amount that closes the curve
        uint64 startsAt;
        uint64 fairWindowEnds;
        uint128 maxBuyInWindow;
        /// @dev Punitive opening fee in basis points, decaying linearly to zero across the fair
        ///      window. See {_snipeTaxBps}.
        uint16 snipeTaxStartBps;
        address lpRecipient; //      fixed at creation; where graduation LP lands
        /// @dev Also fixed at creation. A mutable deployer receives approvals for the entire
        ///      raise and the whole unsold supply at graduation, so leaving it swappable would
        ///      make the LP-recipient guarantee buyers verified before buying worth nothing.
        ILiquidityDeployer deployer;
        bool graduated;
    }

    struct FeeSplit {
        uint16 protocolBps;
        uint16 treasuryBps; //  into AgentToken's redemption pool — raises the floor
        uint16 agentBps; //     into the agent's own ERC-6551 account
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint16 public constant MAX_TOTAL_FEE_BPS = 300; // 3% ceiling across all three legs
    uint64 public constant MAX_FAIR_WINDOW = 1 days;
    /// @notice Ceiling on the opening anti-snipe tax. Not 100%: a trade that returns nothing is
    ///         indistinguishable from a broken contract, and buyers should always get something.
    uint16 public constant MAX_SNIPE_TAX_BPS = 9900;

    IERC20 public immutable QUOTE;
    IERC721 public immutable AGENTS;
    IAnimaAccounts public immutable ANIMA;

    ILiquidityDeployer public liquidityDeployer;
    address public protocolFeeRecipient;
    FeeSplit public feeSplit;

    uint256 private _nextLaunchId = 1;
    mapping(uint256 launchId => Launch) private _launches;
    mapping(uint256 agentId => uint256 launchId) public launchOfAgent;
    mapping(uint256 launchId => mapping(address buyer => uint256)) public boughtInWindow;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event LaunchCreated(
        uint256 indexed launchId,
        uint256 indexed agentId,
        address indexed token,
        address creator,
        uint256 curveSupply,
        uint256 graduationTarget,
        address lpRecipient
    );
    event Bought(uint256 indexed launchId, address indexed buyer, uint256 quoteIn, uint256 baseOut, uint256 fee);
    event Sold(uint256 indexed launchId, address indexed seller, uint256 baseIn, uint256 quoteOut, uint256 fee);
    event Graduated(uint256 indexed launchId, address indexed pool, uint256 tokenAmount, uint256 quoteAmount, uint256 lpAmount);
    event FeeSplitSet(uint16 protocolBps, uint16 treasuryBps, uint16 agentBps, address recipient);
    event LiquidityDeployerSet(address indexed deployer);

    error NotAgentOwner(uint256 agentId, address caller);
    error AlreadyLaunched(uint256 agentId);
    error NoSuchLaunch(uint256 launchId);
    error NotStarted(uint64 startsAt);
    error AlreadyGraduated(uint256 launchId);
    error NotGraduatable(uint256 launchId);
    error FairWindowCapExceeded(uint256 attempted, uint256 cap);
    error CurveExhausted(uint256 requested, uint256 available);
    error SlippageExceeded(uint256 got, uint256 min);
    error FeeTooHigh(uint16 totalBps);
    error FairWindowTooLong(uint64 window);
    error BadCurveParameters();
    error SnipeTaxTooHigh(uint16 bps);
    error StartsInThePast(uint64 startsAt);
    error NoDeployerConfigured();
    error GraduationFailed();
    error ZeroAmount();
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(
        IERC20 quote_,
        IERC721 agents_,
        IAnimaAccounts anima_,
        address owner_,
        address protocolFeeRecipient_,
        FeeSplit memory split_
    ) Ownable(owner_) {
        if (address(quote_) == address(0) || address(agents_) == address(0)) revert ZeroAddress();
        QUOTE = quote_;
        AGENTS = agents_;
        ANIMA = anima_;
        _setFeeSplit(split_, protocolFeeRecipient_);
    }

    function setFeeSplit(FeeSplit calldata split_, address recipient) external onlyOwner {
        _setFeeSplit(split_, recipient);
    }

    function _setFeeSplit(FeeSplit memory split_, address recipient) private {
        uint16 total = split_.protocolBps + split_.treasuryBps + split_.agentBps;
        if (total > MAX_TOTAL_FEE_BPS) revert FeeTooHigh(total);
        if (split_.protocolBps != 0 && recipient == address(0)) revert ZeroAddress();
        feeSplit = split_;
        protocolFeeRecipient = recipient;
        emit FeeSplitSet(split_.protocolBps, split_.treasuryBps, split_.agentBps, recipient);
    }

    function setLiquidityDeployer(ILiquidityDeployer deployer) external onlyOwner {
        liquidityDeployer = deployer;
        emit LiquidityDeployerSet(address(deployer));
    }

    function launchOf(uint256 launchId) external view returns (Launch memory) {
        return _launches[launchId];
    }

    /*//////////////////////////////////////////////////////////////
                                 CREATE
    //////////////////////////////////////////////////////////////*/

    struct LaunchParams {
        uint256 agentId;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 curveSupply; //       portion sold on the curve; the rest seeds the pool
        uint256 virtualQuote; //      curve seed; sets the opening price
        uint256 graduationTarget;
        uint64 startsAt;
        uint64 fairWindow;
        uint256 maxBuyInWindow;
        uint16 snipeTaxStartBps; //  e.g. 9900 for a 99% opening tax
        address lpRecipient;
    }

    function createLaunch(LaunchParams calldata p) external nonReentrant returns (uint256 launchId, address token) {
        if (AGENTS.ownerOf(p.agentId) != msg.sender) revert NotAgentOwner(p.agentId, msg.sender);
        if (launchOfAgent[p.agentId] != 0) revert AlreadyLaunched(p.agentId);
        if (p.fairWindow > MAX_FAIR_WINDOW) revert FairWindowTooLong(p.fairWindow);
        if (p.lpRecipient == address(0)) revert ZeroAddress();
        // A backdated start puts `fairWindowEnds` in the past, so the per-address cap is never
        // consulted and the creator can take the entire cheap end of the curve in one call —
        // exactly what the fair window exists to prevent.
        if (p.startsAt != 0 && p.startsAt < block.timestamp) revert StartsInThePast(p.startsAt);
        if (p.snipeTaxStartBps > MAX_SNIPE_TAX_BPS) revert SnipeTaxTooHigh(p.snipeTaxStartBps);
        ILiquidityDeployer deployer_ = liquidityDeployer;
        if (address(deployer_) == address(0)) revert NoDeployerConfigured();
        // The curve must never be able to drain the base reserve to zero: constant product
        // sends price to infinity there, and integer division would start returning nothing.
        if (p.curveSupply == 0 || p.curveSupply >= p.totalSupply || p.virtualQuote == 0 || p.graduationTarget == 0) {
            revert BadCurveParameters();
        }

        launchId = _nextLaunchId++;

        // The launchpad holds the whole supply: the curve portion to sell, the remainder to
        // seed the pool at graduation. Nothing is pre-allocated to the creator, so there is
        // no insider bag to dump into the launch.
        token = address(
            new AgentToken{salt: bytes32(launchId)}(
                p.name, p.symbol, QUOTE, address(AGENTS), p.agentId, p.totalSupply, address(this)
            )
        );

        Launch storage l = _launches[launchId];
        l.token = token;
        l.creator = msg.sender;
        l.agentId = p.agentId;
        l.quoteReserve = p.virtualQuote.toUint128();
        l.initialQuote = p.virtualQuote.toUint128();
        l.baseReserve = p.totalSupply.toUint128();
        l.curveSupply = p.curveSupply.toUint128();
        l.graduationTarget = p.graduationTarget.toUint128();
        l.startsAt = p.startsAt == 0 ? uint64(block.timestamp) : p.startsAt;
        l.fairWindowEnds = l.startsAt + p.fairWindow;
        l.maxBuyInWindow = p.maxBuyInWindow.toUint128();
        l.snipeTaxStartBps = p.snipeTaxStartBps;
        l.lpRecipient = p.lpRecipient;
        l.deployer = deployer_;

        launchOfAgent[p.agentId] = launchId;

        emit LaunchCreated(launchId, p.agentId, token, msg.sender, p.curveSupply, p.graduationTarget, p.lpRecipient);
    }

    /*//////////////////////////////////////////////////////////////
                                 TRADING
    //////////////////////////////////////////////////////////////*/

    function buy(uint256 launchId, uint256 quoteIn, uint256 minBaseOut)
        external
        nonReentrant
        returns (uint256 baseOut)
    {
        Launch storage l = _requireLive(launchId);
        if (quoteIn == 0) revert ZeroAmount();

        QUOTE.transferFromExact(msg.sender, address(this), quoteIn);

        uint256 fee = _takeFee(l, quoteIn);
        uint256 netIn = quoteIn - fee;

        uint256 q = l.quoteReserve;
        uint256 b = l.baseReserve;
        uint256 k = q * b;
        uint256 newQuote = q + netIn;
        // Round the reserve UP so the trader receives less, never more, than the curve owes.
        uint256 newBase = Math.ceilDiv(k, newQuote);
        baseOut = b - newBase;

        uint256 sold = uint256(l.baseSold) + baseOut;
        if (sold > l.curveSupply) revert CurveExhausted(sold, l.curveSupply);
        if (baseOut < minBaseOut) revert SlippageExceeded(baseOut, minBaseOut);

        if (block.timestamp < l.fairWindowEnds) {
            uint256 already = boughtInWindow[launchId][msg.sender] + netIn;
            if (already > l.maxBuyInWindow) revert FairWindowCapExceeded(already, l.maxBuyInWindow);
            boughtInWindow[launchId][msg.sender] = already;
        }

        l.quoteReserve = newQuote.toUint128();
        l.baseReserve = newBase.toUint128();
        l.baseSold = sold.toUint128();

        IERC20(l.token).transferExact(msg.sender, baseOut);
        emit Bought(launchId, msg.sender, quoteIn, baseOut, fee);
    }

    function sell(uint256 launchId, uint256 baseIn, uint256 minQuoteOut)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        Launch storage l = _requireLive(launchId);
        if (baseIn == 0) revert ZeroAmount();

        IERC20(l.token).transferFromExact(msg.sender, address(this), baseIn);

        uint256 q = l.quoteReserve;
        uint256 b = l.baseReserve;
        uint256 k = q * b;
        uint256 newBase = b + baseIn;
        // Same direction of rounding: the reserve keeps the dust.
        uint256 newQuote = Math.ceilDiv(k, newBase);
        uint256 gross = q - newQuote;

        uint256 fee = _takeFee(l, gross);
        quoteOut = gross - fee;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        l.quoteReserve = newQuote.toUint128();
        l.baseReserve = newBase.toUint128();
        l.baseSold = (uint256(l.baseSold) - baseIn).toUint128();

        QUOTE.transferExact(msg.sender, quoteOut);
        emit Sold(launchId, msg.sender, baseIn, quoteOut, fee);
    }

    /// @notice The anti-snipe tax in force right now: `snipeTaxStartBps` at the opening block,
    ///         decaying linearly to zero at the end of the fair window.
    /// @dev Priced by time rather than by identity, which is why splitting across addresses does
    ///      not help — the defect in every per-address cap.
    function snipeTaxBps(uint256 launchId) public view returns (uint256) {
        return _snipeTaxBps(_launches[launchId]);
    }

    function _snipeTaxBps(Launch storage l) private view returns (uint256) {
        uint16 start = l.snipeTaxStartBps;
        if (start == 0 || block.timestamp >= l.fairWindowEnds) return 0;
        uint256 window = uint256(l.fairWindowEnds) - l.startsAt;
        if (window == 0) return 0;
        uint256 remaining = uint256(l.fairWindowEnds) - block.timestamp;
        return (uint256(start) * remaining) / window;
    }

    /// @dev Fees are skimmed from the quote leg and split three ways, plus the decaying opening
    ///      tax. The treasury legs are the interesting ones: they go into {AgentToken}'s
    ///      redemption pool, so both ordinary trading and sniping permanently raise the price
    ///      floor under the token.
    function _takeFee(Launch storage l, uint256 amount) private returns (uint256 fee) {
        FeeSplit memory s = feeSplit;
        uint256 protocolCut = (amount * s.protocolBps) / 10_000;
        uint256 treasuryCut = (amount * s.treasuryBps) / 10_000;
        uint256 agentCut = (amount * s.agentBps) / 10_000;

        // Clamp the opening tax so base fees plus tax can never reach 100%. Without this a 99%
        // tax on top of a 3% base would try to pay out 102% of the trade — and because launches
        // share this contract's balance, the overspill would come out of another launch's raise
        // rather than reverting cleanly.
        uint256 baseBps = uint256(s.protocolBps) + s.treasuryBps + s.agentBps;
        uint256 snipeBps = _snipeTaxBps(l);
        if (baseBps + snipeBps > MAX_SNIPE_TAX_BPS) snipeBps = MAX_SNIPE_TAX_BPS - baseBps;
        // The whole opening tax goes to the redemption treasury: value a sniper gives up should
        // land with the people they were trying to take it from.
        treasuryCut += (amount * snipeBps) / 10_000;

        fee = protocolCut + treasuryCut + agentCut;
        if (fee == 0) return 0;

        if (protocolCut != 0) QUOTE.transferExact(protocolFeeRecipient, protocolCut);
        if (treasuryCut != 0) {
            QUOTE.forceApprove(l.token, treasuryCut);
            AgentToken(l.token).contribute(treasuryCut);
        }
        if (agentCut != 0) QUOTE.transferExact(ANIMA.accountOf(l.agentId), agentCut);
    }

    /*//////////////////////////////////////////////////////////////
                                GRADUATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Close the curve and move the raise into locked AMM liquidity. Permissionless
    ///         once the target is met — graduation must not depend on the creator showing up.
    function graduate(uint256 launchId) external nonReentrant {
        Launch storage l = _launches[launchId];
        if (l.token == address(0)) revert NoSuchLaunch(launchId);
        if (l.graduated) revert AlreadyGraduated(launchId);

        uint256 raised = uint256(l.quoteReserve) - l.initialQuote;
        if (raised < l.graduationTarget && l.baseSold < l.curveSupply) revert NotGraduatable(launchId);

        l.graduated = true;

        // Everything the curve did not sell seeds the pool, alongside the entire raise.
        uint256 tokenAmount = IERC20(l.token).balanceOf(address(this));
        uint256 quoteAmount = raised;

        ILiquidityDeployer deployer = l.deployer;

        IERC20(l.token).forceApprove(address(deployer), tokenAmount);
        QUOTE.forceApprove(address(deployer), quoteAmount);

        (address pool, uint256 lpAmount) =
            deployer.deployLiquidity(l.token, address(QUOTE), tokenAmount, quoteAmount, l.lpRecipient);

        // Verify the outcome rather than trust the return. Leftover allowance would be a
        // standing claim on the next launch's raise, since launches share this contract's
        // balance.
        IERC20(l.token).forceApprove(address(deployer), 0);
        QUOTE.forceApprove(address(deployer), 0);
        if (pool == address(0) || lpAmount == 0) revert GraduationFailed();

        emit Graduated(launchId, pool, tokenAmount, quoteAmount, lpAmount);
    }

    /*//////////////////////////////////////////////////////////////
                                 QUOTES
    //////////////////////////////////////////////////////////////*/

    function quoteBuy(uint256 launchId, uint256 quoteIn) external view returns (uint256 baseOut, uint256 fee) {
        Launch storage l = _launches[launchId];
        FeeSplit memory s = feeSplit;
        fee = (quoteIn * _effectiveFeeBps(l, s)) / 10_000;
        uint256 k = uint256(l.quoteReserve) * l.baseReserve;
        uint256 newQuote = uint256(l.quoteReserve) + (quoteIn - fee);
        baseOut = l.baseReserve - Math.ceilDiv(k, newQuote);
    }

    function quoteSell(uint256 launchId, uint256 baseIn) external view returns (uint256 quoteOut, uint256 fee) {
        Launch storage l = _launches[launchId];
        uint256 k = uint256(l.quoteReserve) * l.baseReserve;
        uint256 gross = uint256(l.quoteReserve) - Math.ceilDiv(k, uint256(l.baseReserve) + baseIn);
        FeeSplit memory s = feeSplit;
        fee = (gross * _effectiveFeeBps(l, s)) / 10_000;
        quoteOut = gross - fee;
    }

    /// @dev Total fee actually charged right now, tax included and clamped.
    function _effectiveFeeBps(Launch storage l, FeeSplit memory s) private view returns (uint256) {
        uint256 baseBps = uint256(s.protocolBps) + s.treasuryBps + s.agentBps;
        uint256 snipeBps = _snipeTaxBps(l);
        if (baseBps + snipeBps > MAX_SNIPE_TAX_BPS) snipeBps = MAX_SNIPE_TAX_BPS - baseBps;
        return baseBps + snipeBps;
    }

    function raisedOf(uint256 launchId) external view returns (uint256) {
        Launch storage l = _launches[launchId];
        return uint256(l.quoteReserve) - l.initialQuote;
    }

    function _requireLive(uint256 launchId) private view returns (Launch storage l) {
        l = _launches[launchId];
        if (l.token == address(0)) revert NoSuchLaunch(launchId);
        if (l.graduated) revert AlreadyGraduated(launchId);
        if (block.timestamp < l.startsAt) revert NotStarted(l.startsAt);
    }
}
