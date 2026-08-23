// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentCore, Lease, BrainShard, ModelIdentity, AutonomyPolicy} from "../interfaces/IAnima.sol";
import {IERC6551Registry} from "../interfaces/IERC6551.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";
import {EncryptionKeyRegistry} from "../core/EncryptionKeyRegistry.sol";

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
 *      The four values that are `immutable` in the monolith are plain fields here. Facet
 *      immutables *would* work — they are inlined into the facet's own runtime code, which
 *      is what executes under `delegatecall` — but they would have to be passed identically
 *      to every facet's constructor, and a diamond whose facets disagree about which
 *      ERC-6551 registry is canonical is a diamond that mints agents whose wallets move
 *      depending on which function you asked. One authoritative copy, written once at
 *      initialisation, is worth the SLOAD.
 */
library AnimaStorage {
    /// @custom:storage-location erc7201:anima.storage.core
    struct Layout {
        // ─── set once at initialisation, never written again ───────────────────────────
        IERC6551Registry registry;
        address accountImplementation;
        bytes32 accountSalt;
        EncryptionKeyRegistry keyRegistry;
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
