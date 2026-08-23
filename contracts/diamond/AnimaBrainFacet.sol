// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {AnimaBase} from "./AnimaBase.sol";
import {AnimaStorage} from "./AnimaStorage.sol";
import {
    IAnima,
    AgentCore,
    AgentStatus,
    SealPolicy,
    BrainShard,
    ModelIdentity
} from "../interfaces/IAnima.sol";
import {IIdentityRegistry, MetadataEntry} from "../interfaces/IERC8004.sol";
import {ITransferVerifier, ReKeyRequest} from "../interfaces/ITransferVerifier.sol";
import {BrainLib} from "../libraries/BrainLib.sol";

/**
 * @title AnimaBrainFacet — minting, and the agent's private state
 * @notice Where agents come into existence and where their memory is written, including the
 *         re-keying transfer that hands a buyer state they can actually decrypt.
 * @dev Grouped together because they are the same operation seen at two moments: a mint
 *      writes the first brain, a re-keyed sale writes the last one the seller will ever
 *      write. Both go through {AnimaBase-_writeShards} and both advance `brainEpoch`, so an
 *      indexer sees one consistent history.
 */
contract AnimaBrainFacet is AnimaBase, IERC4906, ReentrancyGuardTransient {
    /*//////////////////////////////////////////////////////////////
                          MINT  /  ERC-8004 REGISTER
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-mintAgent}.
    function mintAgent(
        address to,
        string calldata agentURI_,
        bytes32 manifestHash,
        ModelIdentity calldata model,
        BrainShard[] calldata shards,
        SealPolicy seal,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId) {
        agentId = _mintAgent(to, agentURI_, manifestHash, model, shards, seal);
        _applyMetadata(agentId, metadata);
    }

    /// @notice See {IIdentityRegistry-register}.
    function register(string calldata agentURI_, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _registerBare(agentURI_);
        _applyMetadata(agentId, metadata);
    }

    /// @notice See {IIdentityRegistry-register}.
    function register(string calldata agentURI_) external returns (uint256) {
        return _registerBare(agentURI_);
    }

    /// @notice See {IIdentityRegistry-register}.
    function register() external returns (uint256) {
        return _registerBare("");
    }

    /// @dev The ERC-8004 compatibility path: a bare identity with no brain, model or
    ///      manifest commitment. Everything those overloads omit can be filled in later by
    ///      the owner, so the shim costs nothing but also promises nothing.
    function _registerBare(string memory agentURI_) private returns (uint256) {
        return _mintAgent(
            msg.sender,
            agentURI_,
            bytes32(0),
            ModelIdentity({weightsRoot: bytes32(0), runtimeMeasurement: bytes32(0), attestationKind: 0, modelId: ""}),
            new BrainShard[](0),
            SealPolicy.None
        );
    }

    function _applyMetadata(uint256 agentId, MetadataEntry[] calldata metadata) private {
        for (uint256 i; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _mintAgent(
        address to,
        string memory agentURI_,
        bytes32 manifestHash,
        ModelIdentity memory model,
        BrainShard[] memory shards,
        SealPolicy seal
    ) private returns (uint256 agentId) {
        if (to == address(0)) revert ZeroAddress();
        AnimaStorage.Layout storage $ = _s();
        agentId = $.nextAgentId++;

        AgentCore storage c = $.core[agentId];
        c.manifestHash = manifestHash;
        c.seal = seal;
        c.version = 1;
        c.createdAt = uint64(block.timestamp);
        c.status = AgentStatus.Inactive;

        $.agentURI[agentId] = agentURI_;
        $.model[agentId] = model;

        _mint(to, agentId);

        if (shards.length != 0) {
            bytes32 root = BrainLib.rootOf(shards);
            _writeShards(agentId, shards);
            c.brainRoot = root;
            c.brainEpoch = 1;
            emit BrainUpdated(agentId, 1, root, seal);
        }

        emit IIdentityRegistry.Registered(agentId, agentURI_, to);
        emit ManifestUpdated(agentId, manifestHash, 1, agentURI_);
        emit ModelDeclared(agentId, model.weightsRoot, model.attestationKind, model.modelId);
    }

    /*//////////////////////////////////////////////////////////////
                                   BRAIN
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-brainOf}.
    function brainOf(uint256 agentId) external view returns (BrainShard[] memory) {
        return _s().shards[agentId];
    }

    /// @notice See {IAnima-brainRoot}.
    function brainRoot(uint256 agentId) external view returns (bytes32) {
        return _s().core[agentId].brainRoot;
    }

    /// @notice See {IAnima-brainEpoch}.
    function brainEpoch(uint256 agentId) external view returns (uint64) {
        return _s().core[agentId].brainEpoch;
    }

    /// @notice See {IAnima-sealPolicyOf}.
    function sealPolicyOf(uint256 agentId) external view returns (SealPolicy) {
        return _s().core[agentId].seal;
    }

    /// @notice See {IAnima-downgradeSealPolicy}.
    function downgradeSealPolicy(uint256 agentId, SealPolicy seal) external {
        _requireOwnerOf(agentId);
        AgentCore storage c = _s().core[agentId];
        if (uint8(seal) >= uint8(c.seal)) revert SealPolicyNotUpgradable(c.seal, seal);
        c.seal = seal;
        emit BrainUpdated(agentId, c.brainEpoch, c.brainRoot, seal);
    }

    /// @notice See {IAnima-updateBrain}.
    function updateBrain(uint256 agentId, BrainShard[] calldata shards, uint64 expectedEpoch) external {
        _requireController(agentId);
        if (shards.length == 0) revert EmptyBrain();
        AgentCore storage c = _s().core[agentId];
        // Optimistic concurrency: two operators writing memory at once must not silently
        // clobber each other, which is how an agent quietly forgets what it just learned.
        if (c.brainEpoch != expectedEpoch) revert BrainEpochMismatch(expectedEpoch, c.brainEpoch);

        bytes32 root = BrainLib.rootOf(shards);
        _writeShards(agentId, shards);
        c.brainRoot = root;
        unchecked {
            c.brainEpoch = expectedEpoch + 1;
        }
        emit BrainUpdated(agentId, c.brainEpoch, root, c.seal);
        emit MetadataUpdate(agentId);
    }

    /// @notice See {IAnima-transferWithBrain}.
    function transferWithBrain(
        address from,
        address to,
        uint256 agentId,
        BrainShard[] calldata newShards,
        bytes[] calldata sealedKeys,
        bytes calldata proof
    ) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (newShards.length == 0) revert EmptyBrain();

        address holder = _requireOwned(agentId);
        if (holder != from) revert NotOwnerOf(agentId, from);
        if (!_isAuthorized(holder, msg.sender, agentId)) revert NotOwnerOf(agentId, msg.sender);

        AnimaStorage.Layout storage $ = _s();
        bytes32 recipientKeyId = $.keyRegistry.keyIdOf(to);
        if (recipientKeyId == bytes32(0)) revert NoEncryptionKey(to);

        AgentCore storage c = $.core[agentId];
        bytes32 newRoot = BrainLib.rootOf(newShards);

        ITransferVerifier v = $.verifier;
        bool ok = v.verifyReKey(
            ReKeyRequest({
                chainId: block.chainid,
                anima: address(this),
                agentId: agentId,
                from: from,
                to: to,
                oldBrainRoot: c.brainRoot,
                newBrainRoot: newRoot,
                oldEpoch: c.brainEpoch,
                recipientKeyId: recipientKeyId,
                sealedKeysHash: BrainLib.hashSealedKeys(sealedKeys)
            }),
            proof
        );
        if (!ok) revert VerificationFailed();

        _writeShards(agentId, newShards);
        c.brainRoot = newRoot;
        unchecked {
            c.brainEpoch += 1;
        }
        // The seal now reflects what was actually certified, not what was claimed at mint.
        c.seal = v.sealPolicy();

        emit BrainUpdated(agentId, c.brainEpoch, newRoot, c.seal);
        emit SealedKeysPublished(agentId, to, c.brainEpoch, sealedKeys);

        _safeTransfer(from, to, agentId, "");
    }
}
