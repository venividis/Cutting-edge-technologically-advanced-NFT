// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IAnima, AgentStatus, SealPolicy, BrainShard, ModelIdentity, AutonomyPolicy} from "../interfaces/IAnima.sol";
import {IIdentityRegistry, MetadataEntry} from "../interfaces/IERC8004.sol";
import {IERC4907, IERC5192, IERC6454, IERC7572} from "../interfaces/IRentable.sol";
import {IERC6551Registry} from "../interfaces/IERC6551.sol";
import {ITransferVerifier, ReKeyRequest} from "../interfaces/ITransferVerifier.sol";
import {BrainLib} from "../libraries/BrainLib.sol";
import {EncryptionKeyRegistry} from "./EncryptionKeyRegistry.sol";

/**
 * @title AnimaAgent — Sovereign Agent Token
 * @notice One ERC-721 token = one complete, economically accountable AI agent: an identity,
 *         a wallet, private state, a declared model, a published leash, and a bond.
 *
 *         See {IAnima} for the design rationale. This is the reference implementation and is
 *         intentionally *not* upgradeable — an agent standard whose rules a proxy admin can
 *         rewrite is not a standard, it is a promise. The things that legitimately need to
 *         evolve (the re-key verifier, the module allowlist, royalties) are swappable
 *         pointers under two-step ownership instead.
 *
 * @dev Security posture worth reading before integrating:
 *
 *      1. **Selling an agent revokes its autonomy.** On transfer the operator set is
 *         epoch-rolled, the lease is cleared, the guardian is cleared, the autonomy policy
 *         is zeroed, the bound wallet is reset and status drops to `Paused`. The
 *         alternative — an agent that keeps executing its previous owner's policy on behalf
 *         of its new owner — is how a treasury disappears.
 *      2. **A locked agent cannot move.** Modules lock an agent while it owes work or is
 *         under dispute, so it cannot be sold out from under a counterparty mid-job.
 *      3. **The token bound account is derived, not stored.** Same address before
 *         deployment, after deployment, and on every chain, so quoting never races account
 *         creation.
 *      4. **Manifest URI and its hash move together.** A URI set without a commitment
 *         records `bytes32(0)`, i.e. "uncommitted" — never a stale hash that would let an
 *         agent show one card and serve another.
 */
contract AnimaAgent is
    IAnima,
    IIdentityRegistry,
    IERC4907,
    IERC5192,
    IERC6454,
    IERC7572,
    IERC4906,
    ERC721,
    ERC2981,
    EIP712,
    Ownable2Step,
    ReentrancyGuardTransient
{
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct AgentCore {
        bytes32 manifestHash; //  slot 0
        bytes32 brainRoot; //     slot 1
        address guardian; //      slot 2 ─┐ 20
        AgentStatus status; //            │  1
        SealPolicy seal; //               │  1
        uint32 version; //                │  4
        uint32 lockCount; //     ─────────┘  4  = 30/32
        uint64 brainEpoch; //     slot 3 ─┐  8
        uint64 createdAt; //              │  8
        uint64 operatorEpoch; // ─────────┘  8  = 24/32
    }

    struct Lease {
        address user;
        uint64 expires;
    }

    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant _WALLET_BINDING_TYPEHASH =
        keccak256("AgentWalletBinding(uint256 agentId,address wallet,uint256 nonce,uint256 deadline)");

    bytes4 private constant _INTERFACE_ID_ERC4906 = 0x49064906;
    bytes4 private constant _INTERFACE_ID_ERC4907 = 0xad092b5c;
    bytes4 private constant _INTERFACE_ID_ERC5192 = 0xb45a3c0e;
    bytes4 private constant _INTERFACE_ID_ERC6454 = 0x91a6262f;
    /// @dev ERC-7572 publishes no interfaceId; this is the community-computed value.
    bytes4 private constant _INTERFACE_ID_ERC7572 = 0xe8a3d485;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The canonical, chain-agnostic ERC-6551 registry.
    IERC6551Registry public immutable REGISTRY;
    address public immutable ACCOUNT_IMPLEMENTATION;
    bytes32 public immutable ACCOUNT_SALT;

    /// @notice Chain-wide registry of recipients' encryption keys. Shared across every
    ///         ANIMA collection so a user publishes a key once, not once per contract.
    EncryptionKeyRegistry public immutable KEY_REGISTRY;

    ITransferVerifier public verifier;

    uint256 private _nextAgentId = 1;

    mapping(uint256 agentId => AgentCore) private _core;
    mapping(uint256 agentId => BrainShard[]) private _shards;
    mapping(uint256 agentId => ModelIdentity) private _model;
    mapping(uint256 agentId => AutonomyPolicy) private _policy;
    mapping(uint256 agentId => string) private _agentURI;
    mapping(uint256 agentId => Lease) private _lease;
    mapping(uint256 agentId => address) private _boundWallet;
    mapping(uint256 agentId => uint256) private _walletNonce;
    mapping(uint256 agentId => mapping(bytes32 keyHash => bytes)) private _metadata;

    /// @dev Keyed by operator epoch so a sale wipes the previous owner's staff in O(1)
    ///      instead of leaving dangling authorisations nobody can enumerate.
    mapping(uint256 agentId => mapping(uint64 epoch => mapping(address => bool))) private _operator;

    string private _contractURI;

    /// @notice Protocol modules (escrow, marketplace, bridge) permitted to lock agents and
    ///         move them into `Disputed`. A small, explicit allowlist — never open-ended.
    mapping(address module => bool) public isModule;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event VerifierSet(address indexed verifier, SealPolicy policy);
    event ModuleSet(address indexed module, bool allowed);
    event AgentLockChanged(uint256 indexed agentId, uint32 lockCount);

    error NotModule(address caller);
    error NotOwnerOf(uint256 agentId, address caller);
    error EmptyBrain();
    error VerificationFailed();
    error NotGuardian(uint256 agentId, address caller);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        IERC6551Registry registry_,
        address accountImplementation_,
        bytes32 accountSalt_,
        ITransferVerifier verifier_,
        EncryptionKeyRegistry keyRegistry_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) ERC721(name_, symbol_) EIP712("AnimaAgent", "1") Ownable(owner_) {
        if (address(registry_) == address(0) || accountImplementation_ == address(0)) revert ZeroAddress();
        if (address(keyRegistry_) == address(0)) revert ZeroAddress();
        KEY_REGISTRY = keyRegistry_;
        REGISTRY = registry_;
        ACCOUNT_IMPLEMENTATION = accountImplementation_;
        ACCOUNT_SALT = accountSalt_;
        _setVerifier(verifier_);
        if (royaltyReceiver_ != address(0)) _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);
    }

    /*//////////////////////////////////////////////////////////////
                              ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    modifier onlyModule() {
        if (!isModule[msg.sender]) revert NotModule(msg.sender);
        _;
    }

    function _requireOwnerOf(uint256 agentId) private view {
        if (_requireOwned(agentId) != msg.sender) revert NotOwnerOf(agentId, msg.sender);
    }

    function _requireController(uint256 agentId) private view {
        if (!isController(agentId, msg.sender)) revert NotAgentController(agentId, msg.sender);
    }

    /// @inheritdoc IAnima
    function isController(uint256 agentId, address account) public view returns (bool) {
        if (account == address(0)) return false;
        if (_ownerOf(agentId) == account) return true;
        Lease storage l = _lease[agentId];
        if (l.user == account && l.expires >= block.timestamp) return true;
        return _operator[agentId][_core[agentId].operatorEpoch][account];
    }

    /// @inheritdoc IAnima
    function isOperator(uint256 agentId, address operator) public view returns (bool) {
        return _operator[agentId][_core[agentId].operatorEpoch][operator];
    }

    /// @inheritdoc IAnima
    function setOperator(uint256 agentId, address operator, bool allowed) external {
        _requireOwnerOf(agentId);
        if (operator == address(0)) revert ZeroAddress();
        _operator[agentId][_core[agentId].operatorEpoch][operator] = allowed;
        emit OperatorSet(agentId, operator, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                          MINT  /  ERC-8004 REGISTER
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
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

    /// @inheritdoc IIdentityRegistry
    function register(string calldata agentURI_, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _registerBare(agentURI_);
        _applyMetadata(agentId, metadata);
    }

    /// @inheritdoc IIdentityRegistry
    function register(string calldata agentURI_) external returns (uint256) {
        return _registerBare(agentURI_);
    }

    /// @inheritdoc IIdentityRegistry
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
        agentId = _nextAgentId++;

        AgentCore storage c = _core[agentId];
        c.manifestHash = manifestHash;
        c.seal = seal;
        c.version = 1;
        c.createdAt = uint64(block.timestamp);
        c.status = AgentStatus.Inactive;

        _agentURI[agentId] = agentURI_;
        _model[agentId] = model;

        _mint(to, agentId);

        if (shards.length != 0) {
            bytes32 root = BrainLib.rootOf(shards);
            _writeShards(agentId, shards);
            c.brainRoot = root;
            c.brainEpoch = 1;
            emit BrainUpdated(agentId, 1, root, seal);
        }

        emit Registered(agentId, agentURI_, to);
        emit ManifestUpdated(agentId, manifestHash, 1, agentURI_);
        emit ModelDeclared(agentId, model.weightsRoot, model.attestationKind, model.modelId);
    }

    /*//////////////////////////////////////////////////////////////
                            MANIFEST & METADATA
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
    function setManifest(uint256 agentId, string calldata agentURI_, bytes32 manifestHash) public {
        _requireController(agentId);
        AgentCore storage c = _core[agentId];
        _agentURI[agentId] = agentURI_;
        c.manifestHash = manifestHash;
        unchecked {
            c.version += 1;
        }
        emit ManifestUpdated(agentId, manifestHash, c.version, agentURI_);
        emit URIUpdated(agentId, agentURI_, msg.sender);
        emit MetadataUpdate(agentId); // ERC-4906: invalidate marketplace caches
    }

    /// @inheritdoc IIdentityRegistry
    /// @dev ERC-8004 compatibility shim. It deliberately clears the manifest commitment:
    ///      pointing at new bytes without saying what they hash to is precisely the swap
    ///      this standard exists to prevent, so the honest on-chain state is "uncommitted"
    ///      rather than a stale hash that would falsely validate.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        setManifest(agentId, newURI, bytes32(0));
    }

    /// @inheritdoc IAnima
    function manifestOf(uint256 agentId)
        external
        view
        returns (string memory agentURI_, bytes32 manifestHash, uint32 version)
    {
        _requireOwned(agentId);
        AgentCore storage c = _core[agentId];
        return (_agentURI[agentId], c.manifestHash, c.version);
    }

    /// @inheritdoc IAnima
    function verifyManifest(uint256 agentId, bytes calldata manifest) external view returns (bool) {
        bytes32 committed = _core[agentId].manifestHash;
        return committed != bytes32(0) && keccak256(manifest) == committed;
    }

    /// @inheritdoc IIdentityRegistry
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        _requireController(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) private {
        _metadata[agentId][keccak256(bytes(key))] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    /// @inheritdoc IIdentityRegistry
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _agentURI[agentId];
    }

    /*//////////////////////////////////////////////////////////////
                                   MODEL
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
    function declareModel(uint256 agentId, ModelIdentity calldata model) external {
        _requireOwnerOf(agentId);
        _model[agentId] = model;
        emit ModelDeclared(agentId, model.weightsRoot, model.attestationKind, model.modelId);
        emit MetadataUpdate(agentId);
    }

    /// @inheritdoc IAnima
    function modelOf(uint256 agentId) external view returns (ModelIdentity memory) {
        return _model[agentId];
    }

    /// @inheritdoc IAnima
    function keyRegistry() external view returns (address) {
        return address(KEY_REGISTRY);
    }

    /*//////////////////////////////////////////////////////////////
                                   BRAIN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
    function brainOf(uint256 agentId) external view returns (BrainShard[] memory) {
        return _shards[agentId];
    }

    /// @inheritdoc IAnima
    function brainRoot(uint256 agentId) external view returns (bytes32) {
        return _core[agentId].brainRoot;
    }

    /// @inheritdoc IAnima
    function brainEpoch(uint256 agentId) external view returns (uint64) {
        return _core[agentId].brainEpoch;
    }

    /// @inheritdoc IAnima
    function sealPolicyOf(uint256 agentId) external view returns (SealPolicy) {
        return _core[agentId].seal;
    }

    /// @inheritdoc IAnima
    function downgradeSealPolicy(uint256 agentId, SealPolicy seal) external {
        _requireOwnerOf(agentId);
        AgentCore storage c = _core[agentId];
        if (uint8(seal) >= uint8(c.seal)) revert SealPolicyNotUpgradable(c.seal, seal);
        c.seal = seal;
        emit BrainUpdated(agentId, c.brainEpoch, c.brainRoot, seal);
    }

    /// @inheritdoc IAnima
    function updateBrain(uint256 agentId, BrainShard[] calldata shards, uint64 expectedEpoch) external {
        _requireController(agentId);
        if (shards.length == 0) revert EmptyBrain();
        AgentCore storage c = _core[agentId];
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

    /// @inheritdoc IAnima
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

        bytes32 recipientKeyId = KEY_REGISTRY.keyIdOf(to);
        if (recipientKeyId == bytes32(0)) revert NoEncryptionKey(to);

        AgentCore storage c = _core[agentId];
        bytes32 newRoot = BrainLib.rootOf(newShards);

        ITransferVerifier v = verifier;
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

    /// @dev Single `memory` implementation shared by mint, update and sealed transfer.
    ///      Duplicating it per data location is what pushed this contract over the size
    ///      limit; the one-time calldata copy at the call boundary is the cheaper trade.
    function _writeShards(uint256 agentId, BrainShard[] memory shards) private {
        BrainShard[] storage s = _shards[agentId];
        uint256 n = shards.length;
        uint256 existing = s.length;
        for (uint256 i; i < n; ++i) {
            if (i < existing) s[i] = shards[i];
            else s.push(shards[i]);
        }
        for (uint256 i = existing; i > n; --i) {
            s.pop();
        }
    }

    /*//////////////////////////////////////////////////////////////
                            WALLET & AUTONOMY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
    function accountOf(uint256 agentId) public view returns (address) {
        return REGISTRY.account(ACCOUNT_IMPLEMENTATION, ACCOUNT_SALT, block.chainid, address(this), agentId);
    }

    /// @inheritdoc IAnima
    function deployAccount(uint256 agentId) external returns (address) {
        _requireOwned(agentId);
        return REGISTRY.createAccount(ACCOUNT_IMPLEMENTATION, ACCOUNT_SALT, block.chainid, address(this), agentId);
    }

    /// @inheritdoc IIdentityRegistry
    function getAgentWallet(uint256 agentId) external view returns (address) {
        address bound = _boundWallet[agentId];
        return bound == address(0) ? accountOf(agentId) : bound;
    }

    /// @inheritdoc IIdentityRegistry
    /// @dev The signature is produced by the *wallet*, not the agent owner. Without it an
    ///      agent could name any address as its wallet and inherit that address's standing,
    ///      which is the cheapest possible impersonation attack on a reputation system.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        _requireOwnerOf(agentId);
        if (newWallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        uint256 nonce = _walletNonce[agentId]++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(_WALLET_BINDING_TYPEHASH, agentId, newWallet, nonce, deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidSignature();

        _boundWallet[agentId] = newWallet;
        emit WalletBound(agentId, newWallet);
    }

    /// @inheritdoc IIdentityRegistry
    function unsetAgentWallet(uint256 agentId) external {
        _requireOwnerOf(agentId);
        delete _boundWallet[agentId];
        emit WalletBound(agentId, accountOf(agentId));
    }

    function walletNonce(uint256 agentId) external view returns (uint256) {
        return _walletNonce[agentId];
    }

    /// @inheritdoc IAnima
    function policyOf(uint256 agentId) external view returns (AutonomyPolicy memory) {
        return _policy[agentId];
    }

    /// @inheritdoc IAnima
    function setPolicy(uint256 agentId, AutonomyPolicy calldata policy) external {
        _requireOwnerOf(agentId);
        _policy[agentId] = policy;
        emit PolicyUpdated(agentId, policy);
    }

    /*//////////////////////////////////////////////////////////////
                            LIFECYCLE & SAFETY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAnima
    function statusOf(uint256 agentId) external view returns (AgentStatus) {
        return _core[agentId].status;
    }

    /// @inheritdoc IAnima
    function setStatus(uint256 agentId, AgentStatus status) external {
        AgentStatus current = _core[agentId].status;
        // `Disputed` is a module-only state and `Retired` is terminal — neither may be
        // entered or left by ordinary configuration calls.
        if (status == AgentStatus.Disputed || current == AgentStatus.Disputed || current == AgentStatus.Retired) {
            revert InvalidStatusTransition(current, status);
        }
        if (status == AgentStatus.Retired) _requireOwnerOf(agentId);
        else _requireController(agentId);
        _setStatus(agentId, status);
    }

    function _setStatus(uint256 agentId, AgentStatus status) private {
        AgentCore storage c = _core[agentId];
        AgentStatus previous = c.status;
        if (previous == status) return;
        c.status = status;
        emit StatusChanged(agentId, previous, status);
    }

    /// @inheritdoc IAnima
    function guardianOf(uint256 agentId) external view returns (address) {
        return _core[agentId].guardian;
    }

    /// @inheritdoc IAnima
    function setGuardian(uint256 agentId, address guardian) external {
        _requireOwnerOf(agentId);
        _core[agentId].guardian = guardian;
        emit GuardianSet(agentId, guardian);
    }

    /// @inheritdoc IAnima
    /// @dev A guardian may only ever pause. It cannot transfer, cannot spend, and cannot
    ///      un-pause. A kill switch that can also steal is not a safety feature.
    function guardianPause(uint256 agentId) external {
        AgentCore storage c = _core[agentId];
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
        if (locked(tokenId)) revert AgentLocked(tokenId);
        _lease[tokenId] = Lease({user: user, expires: expires});
        emit UpdateUser(tokenId, user, expires);
    }

    /// @notice Book a paid lease and hold the agent for its term. Marketplace/escrow only.
    function moduleSetUser(uint256 tokenId, address user, uint64 expires) external onlyModule {
        _lease[tokenId] = Lease({user: user, expires: expires});
        emit UpdateUser(tokenId, user, expires);
    }

    /// @inheritdoc IERC4907
    function userOf(uint256 tokenId) public view returns (address) {
        Lease storage l = _lease[tokenId];
        return l.expires >= block.timestamp ? l.user : address(0);
    }

    /// @inheritdoc IERC4907
    function userExpires(uint256 tokenId) external view returns (uint256) {
        return _lease[tokenId].expires;
    }

    /*//////////////////////////////////////////////////////////////
                       ERC-5192  CONDITIONAL LOCKING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC5192
    /// @dev ANIMA's locking is *temporary and purposeful*, not soulbinding. An agent is
    ///      immovable exactly while it owes someone work or is answering for it.
    function locked(uint256 tokenId) public view returns (bool) {
        AgentCore storage c = _core[tokenId];
        return c.lockCount != 0 || c.status == AgentStatus.Disputed;
    }

    /// @inheritdoc IERC6454
    /// @dev The precise counterpart to `locked`: same rule, but phrased as the question a
    ///      marketplace asks before offering a fill it would otherwise watch revert.
    function isTransferable(uint256 tokenId, address from, address to) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        if (from == address(0)) return true; // minting is always permitted
        to; // a burn is gated by exactly the same condition as a transfer
        return !locked(tokenId);
    }

    /// @notice Increment an agent's lock count. Module-only.
    function lockAgent(uint256 agentId) external onlyModule {
        _requireOwned(agentId);
        AgentCore storage c = _core[agentId];
        bool wasLocked = locked(agentId);
        c.lockCount += 1;
        emit AgentLockChanged(agentId, c.lockCount);
        if (!wasLocked) emit Locked(agentId);
    }

    /// @notice Decrement an agent's lock count. Module-only.
    function unlockAgent(uint256 agentId) external onlyModule {
        AgentCore storage c = _core[agentId];
        if (c.lockCount == 0) return;
        c.lockCount -= 1;
        emit AgentLockChanged(agentId, c.lockCount);
        if (!locked(agentId)) emit Unlocked(agentId);
    }

    /// @notice Move an agent into or out of `Disputed`. Module-only.
    function setDisputed(uint256 agentId, bool disputed) external onlyModule {
        AgentCore storage c = _core[agentId];
        bool wasLocked = locked(agentId);
        if (disputed) {
            _setStatus(agentId, AgentStatus.Disputed);
            if (!wasLocked) emit Locked(agentId);
        } else {
            if (c.status == AgentStatus.Disputed) _setStatus(agentId, AgentStatus.Paused);
            if (!locked(agentId) && wasLocked) emit Unlocked(agentId);
        }
    }

    /*//////////////////////////////////////////////////////////////
                             TRANSFER HOOK
    //////////////////////////////////////////////////////////////*/

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        address previousOwner = _ownerOf(tokenId);

        if (previousOwner != address(0)) {
            // Applies to burns as well: an agent that owes work cannot be destroyed either.
            if (locked(tokenId)) revert AgentLocked(tokenId);
        }

        from = super._update(to, tokenId, auth);

        if (previousOwner != address(0) && to != address(0)) {
            AgentCore storage c = _core[tokenId];
            unchecked {
                c.operatorEpoch += 1; // wipes every operator the seller authorised
            }
            c.guardian = address(0);
            delete _policy[tokenId];
            delete _lease[tokenId];
            delete _boundWallet[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
            emit PolicyUpdated(tokenId, _policy[tokenId]);
            emit GuardianSet(tokenId, address(0));
            // Autonomy does not survive a change of ownership. The buyer must consciously
            // re-arm the agent, having read what it is about to be allowed to do.
            _setStatus(tokenId, AgentStatus.Paused);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    function setVerifier(ITransferVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    function _setVerifier(ITransferVerifier verifier_) private {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
        emit VerifierSet(address(verifier_), verifier_.sealPolicy());
    }

    function setModule(address module, bool allowed) external onlyOwner {
        isModule[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    /// @inheritdoc IERC7572
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function setContractURI(string calldata newURI) external onlyOwner {
        _contractURI = newURI;
        emit ContractURIUpdated();
    }

    /// @dev A declaration, not an entitlement. ERC-2981's own abstract says payment "must be
    ///      voluntary", and by 2026 that is the observed reality: OpenSea made royalties
    ///      optional when the Operator Filter sunset (2023-08-31 for new collections,
    ///      2024-02-29 for existing), Blur enforces only a 0.5% floor on immutable
    ///      contracts, and only ERC-721C collections see enforcement on Magic Eden — at the
    ///      cost of being untradeable on Blur and most aggregators.
    ///
    ///      ANIMA therefore does not fight the secondary-market royalty war. It captures
    ///      value where it actually controls the chokepoint: escrow settlement fees,
    ///      launchpad fees, and per-call metering. This hook exists so marketplaces that do
    ///      pay have somewhere to send it, and for no stronger promise than that.
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    function setTokenRoyalty(uint256 agentId, address receiver, uint96 feeNumerator) external onlyOwner {
        _setTokenRoyalty(agentId, receiver, feeNumerator);
    }

    function totalMinted() external view returns (uint256) {
        return _nextAgentId - 1;
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981, IERC165) returns (bool) {
        return interfaceId == type(IAnima).interfaceId || interfaceId == type(IIdentityRegistry).interfaceId
            || interfaceId == _INTERFACE_ID_ERC4906 || interfaceId == _INTERFACE_ID_ERC4907
            || interfaceId == _INTERFACE_ID_ERC5192 || interfaceId == _INTERFACE_ID_ERC6454
            || interfaceId == _INTERFACE_ID_ERC7572 || super.supportsInterface(interfaceId);
    }
}
