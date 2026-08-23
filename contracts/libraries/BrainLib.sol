// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BrainShard} from "../interfaces/IAnima.sol";

/**
 * @title BrainLib
 * @notice Canonical commitment over an agent's shard set.
 * @dev An ordered hash chain rather than a Merkle tree: the only question ever asked
 *      on-chain is "are these two shard sets identical?" (equality after a re-key, and
 *      equality between a home chain and an omnichain replica). A chain answers that for
 *      ~30 gas per shard, where a tree costs more and buys inclusion proofs nobody needs
 *      here. Off-chain indexers that *do* want inclusion proofs can build a tree over the
 *      per-shard leaves, which are exposed by `leafOf`.
 *
 *      Order is significant, so re-ordering shards is a state change and produces a new
 *      root. That is deliberate: shard index is part of an agent's addressing scheme.
 *
 *      Every entry point takes `memory` rather than `calldata`. Solidity compiles a separate
 *      copy of a loop for each data location, and three shard-writing call sites times two
 *      locations was enough duplicated bytecode to push the token past the 24,576-byte
 *      limit. Callers pass calldata arrays and the compiler converts once at the boundary.
 */
library BrainLib {
    /// @dev Domain separator so a shard leaf can never collide with another struct's hash.
    bytes32 internal constant LEAF_TAG = keccak256("anima.BrainShard.v1");
    bytes32 internal constant ROOT_TAG = keccak256("anima.BrainRoot.v1");

    function leafOf(BrainShard memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                LEAF_TAG, s.dataHash, s.keyCommitment, s.size, s.kind, keccak256(bytes(s.uri)), keccak256(bytes(s.description))
            )
        );
    }

    function rootOf(BrainShard[] memory shards) internal pure returns (bytes32 root) {
        root = keccak256(abi.encode(ROOT_TAG, shards.length));
        for (uint256 i; i < shards.length; ++i) {
            root = keccak256(abi.encode(root, leafOf(shards[i])));
        }
    }

    function hashSealedKeys(bytes[] calldata sealedKeys) internal pure returns (bytes32) {
        return keccak256(abi.encode(sealedKeys));
    }

}
