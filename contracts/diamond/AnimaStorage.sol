// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCore, Lease, BrainShard, ModelIdentity, AutonomyPolicy} from "../interfaces/IAnima.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";

/**
 * @title AnimaStorage — ERC-7201 namespaced state for the diamond build
 * @notice Every facet reads and writes agent state through this one struct at one computed
 *         slot. Nothing else in the diamond may declare a state variable.
 *
 * @dev EIP-2535 deliberately declines to specify storage: *"The particular layout of
 *      storage is not defined in this EIP."* That freedom is also the failure mode — two
 *      facets that each declare their own variables collide at slot 0 and corrupt each
 *      other. ERC-7201 removes the hazard structurally rather than by convention: the root
 *      is
 *
 *          keccak256(abi.encode(uint256(keccak256("anima.storage.core")) - 1)) & ~0xff
 *
 *      which no other namespace and no compiler-assigned slot can reach. The trailing byte
 *      is masked so the struct can be extended without ever running into a neighbour.
 *
 *      Everything ERC-721, ERC-2981, EIP-712 and Ownable2Step need lives in OpenZeppelin's
 *      own ERC-7201 namespaces (the `contracts-upgradeable` package), so the three
 *      state regions are provably disjoint by construction, not by review.
 *
 *      Note what is *not* here. The four values that are `immutable` in the monolith — the
 *      ERC-6551 registry, the account implementation and salt, the encryption key registry —
 *      stay immutable, per facet, and are deliberately absent from this struct. They were
 *      fields here at first; measuring showed that cost three cold `SLOAD`s on `accountOf`,
 *      about 6,300 gas, on the hottest cross-contract read in the protocol — eight contracts
 *      call it to find where an agent's money goes. The hazard that argued for storage, facets
 *      deployed disagreeing about which registry is canonical, is instead removed by
 *      {AnimaDiamond} refusing to deploy unless every facet reports the same
 *      {IAnimaConfigured-animaConfigHash}. A check at construction beats a cost on every
 *      settlement.
 */
library AnimaStorage {
    /// @custom:storage-location erc7201:anima.storage.core
    struct Layout {
        // ─── mutable protocol configuration ────────────────────────────────────────────
        ITransferVerifier verifier;
        string contractURI;
        mapping(address module => bool) isModule;
        // ─── per-agent state ───────────────────────────────────────────────────────────
        uint256 nextAgentId;
        mapping(uint256 agentId => AgentCore) core;
        mapping(uint256 agentId => BrainShard[]) shards;
        mapping(uint256 agentId => ModelIdentity) model;
        mapping(uint256 agentId => AutonomyPolicy) policy;
        mapping(uint256 agentId => string) agentURI;
        mapping(uint256 agentId => Lease) lease;
        mapping(uint256 agentId => address) boundWallet;
        mapping(uint256 agentId => uint256) walletNonce;
        mapping(uint256 agentId => mapping(bytes32 keyHash => bytes)) metadata;
        mapping(uint256 agentId => mapping(uint64 epoch => mapping(address => bool))) operator;
        // ─── expiring, revocable approvals ─────────────────────────────────────────────
        mapping(address owner => uint64) approvalEpoch;
        mapping(bytes32 key => uint64 expiresAt) operatorExpiry;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("anima.storage.core")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x2134dd8a40292237c0a0658c1368c4805ba84a926576fc8c56170c3a72e5a700;

    function layout() internal pure returns (Layout storage $) {
        assembly {
            $.slot := SLOT
        }
    }
}
