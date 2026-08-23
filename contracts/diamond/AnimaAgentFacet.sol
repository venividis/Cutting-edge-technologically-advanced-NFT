// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";

import {AnimaBase} from "./AnimaBase.sol";
import {AnimaStorage} from "./AnimaStorage.sol";
import {AgentCore, AgentStatus, ModelIdentity, AutonomyPolicy, Lease, IAnima} from "../interfaces/IAnima.sol";
import {IERC4907} from "../interfaces/IRentable.sol";
import {IERC6551Registry, IERC6551Account} from "../interfaces/IERC6551.sol";
import {IIdentityRegistry} from "../interfaces/IERC8004.sol";
import {EncryptionKeyRegistry} from "../core/EncryptionKeyRegistry.sol";

/**
 * @title AnimaAgentFacet — who the agent is, what it may do, and where its money lives
 * @notice Manifest, metadata, declared model, wallet binding, autonomy policy, lifecycle,
 *         guardian, tenancy, and the ERC-5646 state fingerprint.
 * @dev This is the facet an owner configures and a counterparty reads before hiring. It
 *      writes nothing that could move the token; transfer authority lives entirely in
 *      {AnimaCoreFacet} and {AnimaBase}.
 */
contract AnimaAgentFacet is AnimaBase, IERC4907, IERC4906 {
    /*//////////////////////////////////////////////////////////////
                     CONSTRUCTION-TIME CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice The canonical, chain-agnostic ERC-6551 registry.
    /// @dev A field rather than an `immutable`, because a facet's immutable is baked into
    ///      *that facet's* code: three facets would each carry their own copy and could be
    ///      deployed disagreeing. One authoritative value, written once at initialisation.
    function REGISTRY() external view returns (IERC6551Registry) {
        return _s().registry;
    }

    function ACCOUNT_IMPLEMENTATION() external view returns (address) {
        return _s().accountImplementation;
    }

    function ACCOUNT_SALT() external view returns (bytes32) {
        return _s().accountSalt;
    }

    /// @notice Chain-wide registry of recipients' encryption keys. Shared across every
    ///         ANIMA collection so a user publishes a key once, not once per contract.
    function KEY_REGISTRY() external view returns (EncryptionKeyRegistry) {
        return _s().keyRegistry;
    }

    /// @notice See {IAnima-keyRegistry}.
    function keyRegistry() external view returns (address) {
        return address(_s().keyRegistry);
    }

    /*//////////////////////////////////////////////////////////////
                              ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-isController}.
    function isController(uint256 agentId, address account) external view returns (bool) {
        return _isController(agentId, account);
    }

    /// @notice See {IAnima-isOperator}.
    function isOperator(uint256 agentId, address operator) external view returns (bool) {
        return _isOperator(agentId, operator);
    }

    /// @notice See {IAnima-setOperator}.
    function setOperator(uint256 agentId, address operator, bool allowed) external {
        _requireOwnerOf(agentId);
        if (operator == address(0)) revert ZeroAddress();
        AnimaStorage.Layout storage $ = _s();
        $.operator[agentId][$.core[agentId].operatorEpoch][operator] = allowed;
        emit OperatorSet(agentId, operator, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                            MANIFEST & METADATA
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-setManifest}.
    function setManifest(uint256 agentId, string calldata agentURI_, bytes32 manifestHash) public {
        _requireController(agentId);
        AnimaStorage.Layout storage $ = _s();
        AgentCore storage c = $.core[agentId];
        $.agentURI[agentId] = agentURI_;
        c.manifestHash = manifestHash;
        unchecked {
            c.version += 1;
        }
        emit ManifestUpdated(agentId, manifestHash, c.version, agentURI_);
        emit IIdentityRegistry.URIUpdated(agentId, agentURI_, msg.sender);
        emit MetadataUpdate(agentId); // ERC-4906: invalidate marketplace caches
    }

    /// @notice ERC-8004 compatibility shim.
    /// @dev It deliberately clears the manifest commitment: pointing at new bytes without
    ///      saying what they hash to is precisely the swap this standard exists to prevent,
    ///      so the honest on-chain state is "uncommitted" rather than a stale hash that
    ///      would falsely validate.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        setManifest(agentId, newURI, bytes32(0));
    }

    /// @notice See {IAnima-manifestOf}.
    function manifestOf(uint256 agentId)
        external
        view
        returns (string memory agentURI_, bytes32 manifestHash, uint32 version)
    {
        _requireOwned(agentId);
        AnimaStorage.Layout storage $ = _s();
        AgentCore storage c = $.core[agentId];
        return ($.agentURI[agentId], c.manifestHash, c.version);
    }

    /// @notice See {IAnima-verifyManifest}.
    function verifyManifest(uint256 agentId, bytes calldata manifest) external view returns (bool) {
        bytes32 committed = _s().core[agentId].manifestHash;
        return committed != bytes32(0) && keccak256(manifest) == committed;
    }

    /// @notice ERC-8004 free-form metadata.
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireController(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _s().metadata[agentId][keccak256(bytes(metadataKey))];
    }

    /*//////////////////////////////////////////////////////////////
                                   MODEL
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-declareModel}.
    function declareModel(uint256 agentId, ModelIdentity calldata model) external {
        _requireOwnerOf(agentId);
        _s().model[agentId] = model;
        emit ModelDeclared(agentId, model.weightsRoot, model.attestationKind, model.modelId);
        emit MetadataUpdate(agentId);
    }

    /// @notice See {IAnima-modelOf}.
    function modelOf(uint256 agentId) external view returns (ModelIdentity memory) {
        return _s().model[agentId];
    }

    /*//////////////////////////////////////////////////////////////
                            WALLET & AUTONOMY
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-accountOf}.
    function accountOf(uint256 agentId) public view returns (address) {
        AnimaStorage.Layout storage $ = _s();
        return $.registry.account($.accountImplementation, $.accountSalt, block.chainid, address(this), agentId);
    }

    /// @notice See {IAnima-deployAccount}.
    function deployAccount(uint256 agentId) external returns (address) {
        _requireOwned(agentId);
        AnimaStorage.Layout storage $ = _s();
        return $.registry.createAccount($.accountImplementation, $.accountSalt, block.chainid, address(this), agentId);
    }

    /// @notice ERC-8004: the address this agent transacts from.
    function getAgentWallet(uint256 agentId) external view returns (address) {
        address bound = _s().boundWallet[agentId];
        return bound == address(0) ? accountOf(agentId) : bound;
    }

    /// @notice Bind an external wallet as this agent's transacting address.
    /// @dev The signature is produced by the *wallet*, not the agent owner. Without it an
    ///      agent could name any address as its wallet and inherit that address's standing,
    ///      which is the cheapest possible impersonation attack on a reputation system.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        _requireOwnerOf(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        AnimaStorage.Layout storage $ = _s();
        uint256 nonce = $.walletNonce[agentId]++;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(_WALLET_BINDING_TYPEHASH, agentId, newWallet, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidSignature();

        $.boundWallet[agentId] = newWallet;
        emit WalletBound(agentId, newWallet);
    }

    function unsetAgentWallet(uint256 agentId) external {
        _requireOwnerOf(agentId);
        delete _s().boundWallet[agentId];
        emit WalletBound(agentId, accountOf(agentId));
    }

    function walletNonce(uint256 agentId) external view returns (uint256) {
        return _s().walletNonce[agentId];
    }

    /// @notice See {IAnima-policyOf}.
    function policyOf(uint256 agentId) external view returns (AutonomyPolicy memory) {
        return _s().policy[agentId];
    }

    /// @notice See {IAnima-setPolicy}.
    function setPolicy(uint256 agentId, AutonomyPolicy calldata policy) external {
        _requireOwnerOf(agentId);
        _s().policy[agentId] = policy;
        emit PolicyUpdated(agentId, policy);
    }

    /*//////////////////////////////////////////////////////////////
                            LIFECYCLE & SAFETY
    //////////////////////////////////////////////////////////////*/

    /// @notice See {IAnima-statusOf}.
    function statusOf(uint256 agentId) external view returns (AgentStatus) {
        return _s().core[agentId].status;
    }

    /// @notice See {IAnima-setStatus}.
    function setStatus(uint256 agentId, AgentStatus status) external {
        AgentStatus current = _s().core[agentId].status;
        // `Disputed` is a module-only state and `Retired` is terminal — neither may be
        // entered or left by ordinary configuration calls.
        if (status == AgentStatus.Disputed || current == AgentStatus.Disputed || current == AgentStatus.Retired) {
            revert InvalidStatusTransition(current, status);
        }
        if (status == AgentStatus.Retired) {
            _requireOwnerOf(agentId);
            // Retirement is terminal and disables every session key, so standing an agent
            // down while it owes a tenant or a client work would be a way to keep their
            // money and hand back a corpse.
            if (_locked(agentId)) revert AgentLocked(agentId);
        } else {
            _requireController(agentId);
        }
        _setStatus(agentId, status);
    }

    /// @notice See {IAnima-guardianOf}.
    function guardianOf(uint256 agentId) external view returns (address) {
        return _s().core[agentId].guardian;
    }

    /// @notice See {IAnima-setGuardian}.
    function setGuardian(uint256 agentId, address guardian) external {
        _requireOwnerOf(agentId);
        _s().core[agentId].guardian = guardian;
        emit GuardianSet(agentId, guardian);
    }

    /// @notice See {IAnima-guardianPause}.
    /// @dev A guardian may only ever pause. It cannot transfer, cannot spend, and cannot
    ///      un-pause. A kill switch that can also steal is not a safety feature.
    function guardianPause(uint256 agentId) external {
        AgentCore storage c = _s().core[agentId];
        if (c.guardian != msg.sender) revert NotGuardian(agentId, msg.sender);
        if (c.status == AgentStatus.Retired || c.status == AgentStatus.Disputed) {
            revert InvalidStatusTransition(c.status, AgentStatus.Paused);
        }
        _setStatus(agentId, AgentStatus.Paused);
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-4907  RENTAL / LEASE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC4907
    function setUser(uint256 tokenId, address user, uint64 expires) external {
        _requireOwnerOf(tokenId);
        // Paid leases are booked by the marketplace, which locks the agent for the term.
        // Blocking `setUser` while locked stops an owner from evicting a paying tenant.
        if (_locked(tokenId)) revert AgentLocked(tokenId);
        _s().lease[tokenId] = Lease({user: user, expires: expires});
        emit UpdateUser(tokenId, user, expires);
    }

    /// @notice Book a paid lease and hold the agent for its term. Marketplace/escrow only.
    function moduleSetUser(uint256 tokenId, address user, uint64 expires) external onlyModule {
        _s().lease[tokenId] = Lease({user: user, expires: expires});
        emit UpdateUser(tokenId, user, expires);
    }

    /// @inheritdoc IERC4907
    function userOf(uint256 tokenId) public view returns (address) {
        Lease storage l = _s().lease[tokenId];
        return l.expires >= block.timestamp ? l.user : address(0);
    }

    /// @inheritdoc IERC4907
    function userExpires(uint256 tokenId) external view returns (uint256) {
        return _s().lease[tokenId].expires;
    }

    /*//////////////////////////////////////////////////////////////
                       ERC-5646  TOKEN STATE FINGERPRINT
    //////////////////////////////////////////////////////////////*/

    /// @notice One hash over everything about this agent that can change without the token
    ///         moving. interfaceId `0xf5112315`.
    /// @dev It deliberately covers more than the ERC-6551 `state()` nonce does. That nonce
    ///      sees only the bound account; it says nothing about the agent's memory, its
    ///      declared model, its status, its guardian, its lease, or the policy its keys run
    ///      under. A buyer needs one number over all of it, and an integrator that checks
    ///      only `state()` is checking the wallet while the agent is swapped out from under
    ///      them.
    ///
    ///      Reverts for a non-existent agent, so a fingerprint is never confused with zero.
    function getStateFingerprint(uint256 tokenId) external view returns (bytes32) {
        address holder = _requireOwned(tokenId);
        address account = accountOf(tokenId);
        uint256 accountState = account.code.length == 0 ? 0 : IERC6551Account(payable(account)).state();
        AnimaStorage.Layout storage $ = _s();
        return keccak256(
            abi.encode(
                holder,
                $.core[tokenId],
                $.model[tokenId].weightsRoot,
                $.boundWallet[tokenId],
                $.lease[tokenId],
                $.policy[tokenId],
                accountState
            )
        );
    }
}
