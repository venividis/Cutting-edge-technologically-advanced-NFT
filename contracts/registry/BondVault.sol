// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title BondVault — skin in the game for autonomous agents
 * @notice Holds a slashable bond per agent. Escrow modules reserve against it before
 *         accepting a job, and arbiters take from it when an agent fails.
 *
 * @dev This is the piece that makes everything else non-theatrical.
 *
 *      Reputation you can mint for the price of gas is worthless; validation nobody pays
 *      for is advisory. A bond changes the economics: an agent can only accept work up to
 *      what it has staked, so its *maximum lie is bounded by its own capital*, and a client
 *      can check that bound before hiring. It converts "trust me" into a number.
 *
 *      Three properties this contract is careful about, each corresponding to a way real
 *      staking systems have been drained:
 *
 *      1. **Unbonding stays slashable.** Funds queued for withdrawal remain fully exposed
 *         for the entire cooldown. Otherwise an agent front-runs its own accountability by
 *         withdrawing the moment it knows a job went badly.
 *      2. **Slashing hits free capital first, reserved capital last.** Reserved funds are
 *         another client's coverage; burning those to pay this client's claim would let one
 *         failure cascade into everyone else's protection.
 *      3. **Coverage is reserved, not merely counted.** `reserve` moves the number into a
 *         locked bucket, so the same collateral can never back two jobs at once.
 *
 *      Slashed value is *not* burned. It routes to the harmed party, because the point is
 *      to make the client whole, not to perform severity.
 */
contract BondVault is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Bond {
        uint128 total; //      slot 0 — everything held for this agent, incl. `unbonding`
        uint128 reserved; //   slot 0 — backing live jobs
        uint128 unbonding; //  slot 1 — queued for withdrawal; still slashable until readyAt
        uint64 readyAt; //     slot 1 — when the queued amount becomes withdrawable
        address unbondTo; //   slot 2 — who queued it, and therefore whose money it is
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC20 public immutable ASSET;
    IERC721 public immutable AGENTS;

    /// @notice How long withdrawn collateral stays slashable. Must outlast the dispute
    ///         window of any module that reserves against this vault, or the guarantee is
    ///         only as good as an agent's patience.
    uint64 public immutable UNBONDING_PERIOD;

    /// @notice Modules permitted to reserve and release coverage (escrow, marketplace).
    mapping(address module => bool) public isModule;
    /// @notice Modules permitted to slash. Deliberately a narrower set than `isModule`.
    mapping(address arbiter => bool) public isArbiter;

    mapping(uint256 agentId => Bond) private _bonds;

    uint256 public totalBonded;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event ModuleSet(address indexed module, bool allowed);
    event ArbiterSet(address indexed arbiter, bool allowed);
    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event UnbondRequested(uint256 indexed agentId, address indexed beneficiary, uint256 amount, uint64 readyAt);
    event UnbondCancelled(uint256 indexed agentId, uint256 amount);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Reserved(uint256 indexed agentId, address indexed module, uint256 amount);
    event Released(uint256 indexed agentId, address indexed module, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed arbiter, address indexed beneficiary, uint256 amount, bytes32 reason);

    error NotModule(address caller);
    error NotArbiter(address caller);
    error NotAgentOwner(uint256 agentId, address caller);
    error InsufficientFree(uint256 agentId, uint256 requested, uint256 free);
    error InsufficientReserved(uint256 agentId, uint256 requested, uint256 reserved);
    error InsufficientBond(uint256 agentId, uint256 requested, uint256 total);
    error NothingUnbonding(uint256 agentId);
    error UnbondNotReady(uint256 agentId, uint64 readyAt);
    error UnbondPending(uint256 agentId);
    error ZeroAmount();
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 asset_, IERC721 agents_, uint64 unbondingPeriod_, address owner_) Ownable(owner_) {
        if (address(asset_) == address(0) || address(agents_) == address(0)) revert ZeroAddress();
        ASSET = asset_;
        AGENTS = agents_;
        UNBONDING_PERIOD = unbondingPeriod_;
    }

    modifier onlyModule() {
        if (!isModule[msg.sender]) revert NotModule(msg.sender);
        _;
    }

    modifier onlyArbiter() {
        if (!isArbiter[msg.sender]) revert NotArbiter(msg.sender);
        _;
    }

    function setModule(address module, bool allowed) external onlyOwner {
        isModule[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    function setArbiter(address arbiter, bool allowed) external onlyOwner {
        isArbiter[arbiter] = allowed;
        emit ArbiterSet(arbiter, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function bondOf(uint256 agentId) external view returns (Bond memory) {
        return _bonds[agentId];
    }

    /// @notice Collateral available to back a new job. This is the number a client should
    ///         check before hiring: it is the most this agent can be made to pay.
    function availableCoverage(uint256 agentId) public view returns (uint256) {
        Bond storage b = _bonds[agentId];
        uint256 committed = uint256(b.reserved) + b.unbonding;
        return b.total > committed ? b.total - committed : 0;
    }

    /// @notice Total slashable collateral, including funds already queued for withdrawal.
    function slashableOf(uint256 agentId) external view returns (uint256) {
        return _bonds[agentId].total;
    }

    /*//////////////////////////////////////////////////////////////
                            DEPOSIT / WITHDRAW
    //////////////////////////////////////////////////////////////*/

    /// @notice Anyone may top up an agent's bond — a sponsor, a DAO, the agent itself out of
    ///         its own earnings. Only the owner can ever take it back out.
    function deposit(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        AGENTS.ownerOf(agentId); // reverts for a non-existent agent

        ASSET.safeTransferFrom(msg.sender, address(this), amount);
        _bonds[agentId].total += amount.toUint128();
        totalBonded += amount;
        emit Deposited(agentId, msg.sender, amount);
    }

    /// @notice Begin withdrawing free collateral. It remains fully slashable until `readyAt`.
    function requestUnbond(uint256 agentId, uint256 amount) external {
        address holder = _requireAgentOwner(agentId);
        if (amount == 0) revert ZeroAmount();

        Bond storage b = _bonds[agentId];
        if (b.unbonding != 0) revert UnbondPending(agentId);

        uint256 free = availableCoverage(agentId);
        if (amount > free) revert InsufficientFree(agentId, amount, free);

        b.unbonding = amount.toUint128();
        b.readyAt = uint64(block.timestamp) + UNBONDING_PERIOD;
        // The queued amount belongs to whoever put it up, not to whoever happens to hold the
        // agent when the cooldown matures — otherwise selling an agent mid-unbond would hand
        // the buyer the seller's collateral.
        b.unbondTo = holder;
        emit UnbondRequested(agentId, holder, amount, b.readyAt);
    }

    /// @notice Abandon a pending withdrawal and return the collateral to active coverage.
    /// @dev Gated on whoever *queued* it, not on whoever currently holds the agent. Gating on
    ///      the holder would let a buyer cancel the seller's pending withdrawal, re-queue it to
    ///      themselves, and walk off with collateral that was already on its way out — the sale
    ///      price having reflected `availableCoverage`, which by then reads zero.
    function cancelUnbond(uint256 agentId) external {
        Bond storage b = _bonds[agentId];
        uint256 amount = b.unbonding;
        if (amount == 0) revert NothingUnbonding(agentId);
        if (b.unbondTo != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        b.unbonding = 0;
        b.readyAt = 0;
        b.unbondTo = address(0);
        emit UnbondCancelled(agentId, amount);
    }

    /// @notice Collect matured collateral. Permissionless to call; always pays the address
    ///         that queued the withdrawal.
    /// @dev Note for buyers: judge an agent by `availableCoverage`, never by `slashableOf`.
    ///      The latter includes collateral already on its way out the door.
    function withdraw(uint256 agentId) external nonReentrant {
        Bond storage b = _bonds[agentId];

        uint256 amount = b.unbonding;
        if (amount == 0) revert NothingUnbonding(agentId);
        if (block.timestamp < b.readyAt) revert UnbondNotReady(agentId, b.readyAt);

        address to = b.unbondTo;
        // A slash during the cooldown may have eaten into the queued amount.
        if (amount > b.total) amount = b.total;

        b.unbonding = 0;
        b.readyAt = 0;
        b.unbondTo = address(0);
        b.total -= amount.toUint128();
        totalBonded -= amount;

        ASSET.safeTransfer(to, amount);
        emit Withdrawn(agentId, to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            COVERAGE (MODULES)
    //////////////////////////////////////////////////////////////*/

    /// @notice Reserve coverage against a job. Reverts unless the agent genuinely has the
    ///         free collateral, which is what stops one bond from backing ten jobs.
    function reserve(uint256 agentId, uint256 amount) external onlyModule {
        if (amount == 0) revert ZeroAmount();
        uint256 free = availableCoverage(agentId);
        if (amount > free) revert InsufficientFree(agentId, amount, free);
        _bonds[agentId].reserved += amount.toUint128();
        emit Reserved(agentId, msg.sender, amount);
    }

    function release(uint256 agentId, uint256 amount) external onlyModule {
        Bond storage b = _bonds[agentId];
        if (amount > b.reserved) revert InsufficientReserved(agentId, amount, b.reserved);
        b.reserved -= amount.toUint128();
        emit Released(agentId, msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 SLASHING
    //////////////////////////////////////////////////////////////*/

    /// @notice Take `amount` from an agent's bond and pay it to the harmed party.
    /// @dev Consumption order is free → unbonding → reserved. Reserved collateral is another
    ///      client's protection and is touched only once nothing else remains, so a single
    ///      bad job cannot silently strip the coverage every other client is relying on.
    ///      The caller is expected to `release` its own reservation separately.
    function slash(uint256 agentId, uint256 amount, address beneficiary, bytes32 reason)
        external
        onlyArbiter
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (beneficiary == address(0)) revert ZeroAddress();

        Bond storage b = _bonds[agentId];
        if (amount > b.total) revert InsufficientBond(agentId, amount, b.total);

        uint256 remaining = amount;

        uint256 free = availableCoverage(agentId);
        if (free >= remaining) {
            remaining = 0;
        } else {
            remaining -= free;
        }

        if (remaining != 0) {
            uint256 fromUnbonding = b.unbonding < remaining ? b.unbonding : remaining;
            b.unbonding -= fromUnbonding.toUint128();
            remaining -= fromUnbonding;
            if (b.unbonding == 0) {
                b.readyAt = 0;
                b.unbondTo = address(0);
            }
        }

        if (remaining != 0) {
            uint256 fromReserved = b.reserved < remaining ? b.reserved : remaining;
            b.reserved -= fromReserved.toUint128();
            remaining -= fromReserved;
        }

        b.total -= amount.toUint128();
        totalBonded -= amount;

        ASSET.safeTransfer(beneficiary, amount);
        emit Slashed(agentId, msg.sender, beneficiary, amount, reason);
    }

    /*//////////////////////////////////////////////////////////////
                                 INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _requireAgentOwner(uint256 agentId) private view returns (address holder) {
        holder = AGENTS.ownerOf(agentId);
        if (holder != msg.sender) revert NotAgentOwner(agentId, msg.sender);
    }
}
