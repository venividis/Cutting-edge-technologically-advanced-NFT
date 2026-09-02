// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ExactERC20} from "../libraries/ExactERC20.sol";
import {BondVault} from "../registry/BondVault.sol";

interface IRevenueAgentView {
    function accountOf(uint256 agentId) external view returns (address);
}

interface IRevenueTreasury {
    function contribute(uint256 amount) external;
}

/**
 * @title RevenueRouter — commitment-safe agent revenue waterfalls
 * @notice Splits earned revenue between operations, a redemption treasury, bond growth,
 *         referrals and a commons without allowing a policy change to rewrite an existing deal.
 *
 * @dev Integrations quote `revenueCommitment`, commit it in their order/voucher, then call
 *      `routeExpected`. A pending policy has a mandatory delay, and a token transfer makes
 *      the old owner's policy stale immediately. The operating share receives every rounding
 *      remainder so configured peripheral shares can never silently exceed the gross amount.
 */
contract RevenueRouter is ReentrancyGuardTransient {
    using ExactERC20 for IERC20;
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint16 public constant MIN_OPERATING_BPS = 5_000;
    uint16 public constant MAX_REFERRAL_BPS = 500;
    uint64 public constant POLICY_DELAY = 2 days;

    struct Policy {
        address configuredBy;
        address treasury;
        address commons;
        uint16 treasuryBps;
        uint16 bondBps;
        uint16 referralBps;
        uint16 commonsBps;
    }

    struct PendingPolicy {
        Policy policy;
        uint64 activatesAt;
    }

    IERC20 public immutable ASSET;
    IERC721 public immutable AGENTS;
    IRevenueAgentView public immutable ANIMA;
    BondVault public immutable BONDS;

    mapping(uint256 agentId => Policy) private _policies;
    mapping(uint256 agentId => PendingPolicy) private _pending;

    event PolicyProposed(uint256 indexed agentId, bytes32 indexed policyHash, uint64 activatesAt);
    event PolicyActivated(uint256 indexed agentId, bytes32 indexed policyHash);
    event RevenueRouted(
        uint256 indexed agentId,
        address indexed payer,
        bytes32 indexed policyHash,
        uint256 gross,
        uint256 operating,
        uint256 treasury,
        uint256 bond,
        uint256 referral,
        uint256 commons,
        address referrer
    );

    error NotAgentOwner(uint256 agentId, address caller);
    error PolicyNotReady(uint64 activatesAt);
    error InvalidPolicy();
    error StalePolicy(bytes32 expected, bytes32 actual);
    error ZeroAmount();
    error MissingReferrer();
    error ZeroAddress();

    constructor(IERC20 asset_, IERC721 agents_, IRevenueAgentView anima_, BondVault bonds_) {
        if (
            address(asset_) == address(0) || address(agents_) == address(0) || address(anima_) == address(0)
                || address(bonds_) == address(0)
        ) revert ZeroAddress();
        ASSET = asset_;
        AGENTS = agents_;
        ANIMA = anima_;
        BONDS = bonds_;
        // ExactERC20 transfers require an exact allowance. It is reset after every deposit.
    }

    function policyOf(uint256 agentId) public view returns (Policy memory policy) {
        policy = _policies[agentId];
        if (policy.configuredBy != AGENTS.ownerOf(agentId)) delete policy;
    }

    function pendingPolicyOf(uint256 agentId) external view returns (PendingPolicy memory) {
        return _pending[agentId];
    }

    function policyHash(uint256 agentId) public view returns (bytes32) {
        return keccak256(abi.encode(policyOf(agentId)));
    }

    /// @notice Commitment an escrow/order should snapshot before accepting an obligation.
    ///         Binding the referrer prevents the settlement caller substituting itself later.
    function revenueCommitment(uint256 agentId, address referrer) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), agentId, policyHash(agentId), referrer));
    }

    function proposePolicy(
        uint256 agentId,
        address treasury,
        address commons,
        uint16 treasuryBps,
        uint16 bondBps,
        uint16 referralBps,
        uint16 commonsBps
    ) external {
        address owner = AGENTS.ownerOf(agentId);
        if (owner != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        uint256 peripheral = uint256(treasuryBps) + bondBps + referralBps + commonsBps;
        if (
            peripheral > BPS - MIN_OPERATING_BPS || referralBps > MAX_REFERRAL_BPS
                || (treasuryBps != 0 && treasury == address(0)) || (commonsBps != 0 && commons == address(0))
        ) revert InvalidPolicy();

        Policy memory policy = Policy(owner, treasury, commons, treasuryBps, bondBps, referralBps, commonsBps);
        uint64 activatesAt = uint64(block.timestamp) + POLICY_DELAY;
        _pending[agentId] = PendingPolicy(policy, activatesAt);
        emit PolicyProposed(agentId, keccak256(abi.encode(policy)), activatesAt);
    }

    function activatePolicy(uint256 agentId) external {
        PendingPolicy memory pending = _pending[agentId];
        if (pending.activatesAt == 0 || block.timestamp < pending.activatesAt) {
            revert PolicyNotReady(pending.activatesAt);
        }
        if (AGENTS.ownerOf(agentId) != pending.policy.configuredBy) revert InvalidPolicy();
        _policies[agentId] = pending.policy;
        delete _pending[agentId];
        emit PolicyActivated(agentId, keccak256(abi.encode(pending.policy)));
    }

    /// @notice Route revenue only if the policy is exactly the one the payer committed to.
    /// @dev The default/transfer-staled policy sends 100% to the agent account.
    function routeExpected(uint256 agentId, uint256 amount, address referrer, bytes32 expectedCommitment)
        external
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        Policy memory policy = policyOf(agentId);
        bytes32 actual = keccak256(abi.encode(policy));
        bytes32 commitment = keccak256(abi.encode(block.chainid, address(this), agentId, actual, referrer));
        if (commitment != expectedCommitment) revert StalePolicy(expectedCommitment, commitment);
        if (policy.referralBps != 0 && referrer == address(0)) revert MissingReferrer();

        ASSET.transferFromExact(msg.sender, address(this), amount);
        uint256 treasuryAmount = amount * policy.treasuryBps / BPS;
        uint256 bondAmount = amount * policy.bondBps / BPS;
        uint256 referralAmount = amount * policy.referralBps / BPS;
        uint256 commonsAmount = amount * policy.commonsBps / BPS;
        uint256 operating = amount - treasuryAmount - bondAmount - referralAmount - commonsAmount;

        if (treasuryAmount != 0) {
            ASSET.forceApprove(policy.treasury, treasuryAmount);
            IRevenueTreasury(policy.treasury).contribute(treasuryAmount);
            ASSET.forceApprove(policy.treasury, 0);
        }
        if (bondAmount != 0) {
            ASSET.forceApprove(address(BONDS), bondAmount);
            BONDS.deposit(agentId, bondAmount);
            ASSET.forceApprove(address(BONDS), 0);
        }
        if (referralAmount != 0) ASSET.transferExact(referrer, referralAmount);
        if (commonsAmount != 0) ASSET.transferExact(policy.commons, commonsAmount);
        ASSET.transferExact(ANIMA.accountOf(agentId), operating);

        emit RevenueRouted(
            agentId, msg.sender, actual, amount, operating, treasuryAmount, bondAmount, referralAmount,
            commonsAmount, referrer
        );
    }
}
