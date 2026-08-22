// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MetadataEntry} from "./IERC8004.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                  ANIMA TYPES
//////////////////////////////////////////////////////////////////////////////*/

/// @notice Lifecycle of an agent. Status gates *what the agent may do*, not who owns it —
///         ownership is always plain ERC-721 so agents stay liquid on any marketplace.
enum AgentStatus {
    Inactive, // registered, never activated; cannot be hired
    Active, //   operating normally
    Paused, //   owner- or guardian-halted; existing escrows can still settle
    Disputed, // a live dispute is drawing on its bond; token is locked (ERC-5192)
    Retired //   permanently stood down; bond withdrawable after the cooldown
}

/// @notice How strongly the agent's private state ("brain") is protected on transfer.
///
///         This is deliberately explicit and on-chain. Every "encrypted NFT" design has
///         the same irreducible flaw — a previous owner who has already decrypted the
///         plaintext can keep a copy forever — and most standards paper over it. ANIMA
///         instead makes the *guarantee level* a first-class, machine-readable field so a
///         buyer prices the residual risk rather than being misled about it.
enum SealPolicy {
    None, //        brain is public; hash is integrity only
    Committed, //   ciphertext hash on-chain, key handed over out-of-band (trust the seller)
    ReKeyed, //     key rotated to the buyer on transfer; seller's old key is useless for
    //              future updates but does not un-see past plaintext
    SealedTEE, //   re-encryption performed inside an attested enclave; plaintext never
    //              leaves the TEE, so a *non-exporting* seller provably retains nothing
    SealedZK, //    re-encryption proven in zero knowledge (no hardware trust)
    Threshold //    key held by a threshold committee; no single party can reconstruct it
}

/// @notice A single encrypted or public shard of the agent's state.
/// @dev Modelled on ERC-7857's `IntelligentData` but extended with the fields a real
///      deployment needs: where the bytes actually live, and how big they are.
struct BrainShard {
    bytes32 dataHash; //     keccak256 of the ciphertext (or plaintext when SealPolicy.None)
    bytes32 keyCommitment; //commitment to the content key; zero when unencrypted
    uint64 size; //          bytes, for storage accounting and fee quoting
    uint8 kind; //           ShardKind
    string uri; //           ipfs:// | ar:// | 0g:// | https:// — where the ciphertext lives
    string description; //   human/machine label, e.g. "long-term-memory"
}

/// @dev Conventional shard kinds. Free-form values above 200 are reserved for extensions.
library ShardKind {
    uint8 internal constant WEIGHTS = 0; //     model weights or a LoRA/adapter
    uint8 internal constant MEMORY = 1; //      long-term memory / vector store
    uint8 internal constant SYSTEM_PROMPT = 2; //persona and operating instructions
    uint8 internal constant TOOLS = 3; //       tool + MCP server configuration
    uint8 internal constant KEYS = 4; //        wrapped operational secrets
    uint8 internal constant DATASET = 5; //     fine-tuning corpus
    uint8 internal constant CHECKPOINT = 6; //  full serialised runtime snapshot
}

/// @notice What model this agent claims to be, and how that claim can be checked.
struct ModelIdentity {
    bytes32 weightsRoot; //  merkle root / digest of the weights or adapter set
    bytes32 runtimeMeasurement; // enclave measurement (MRENCLAVE, TDX MRTD, SEV-SNP) or 0
    uint8 attestationKind; //AttestationKind
    string modelId; //       e.g. "anthropic/claude-opus-5" or a HF repo@revision
}

library AttestationKind {
    uint8 internal constant NONE = 0; //      self-declared
    uint8 internal constant SIGNED = 1; //    signed by a registered attester
    uint8 internal constant TEE = 2; //       hardware attestation quote verified on-chain
    uint8 internal constant ZK = 3; //        zk proof of correct execution
    uint8 internal constant OPTIMISTIC = 4; //asserted, challengeable within a window
}

/// @notice The spending and reach limits an owner imposes on their agent's autonomy.
/// @dev Enforced by `AgentAccount`, but declared here so the limits are publicly readable
///      *before* anyone hires the agent. An agent that cannot prove its own leash is not
///      safe to transact with.
struct AutonomyPolicy {
    uint128 perTxWei; //      max native value per call (0 = none allowed)
    uint128 dailyWei; //      rolling 24h native spend cap
    uint64 expiry; //         policy self-destructs at this timestamp (0 = no expiry)
    bool allowDelegateCall; //DELEGATECALL from the agent account (dangerous; default off)
    bool allowUnlistedTargets; // if false, only allowlisted targets are callable
    bytes32 targetsRoot; //   merkle root of the allowlisted (target, selector) pairs
}

/*//////////////////////////////////////////////////////////////////////////////
                                 CORE INTERFACE
//////////////////////////////////////////////////////////////////////////////*/

/**
 * @title IAnima — Sovereign Agent Token
 * @notice An ERC-721 in which each token is a complete, economically accountable AI agent:
 *         an identity, a wallet, private state, a declared model, a leash, and a bond.
 *
 *         ANIMA is a *composition* standard. Rather than inventing a parallel universe it
 *         binds together the specs that already won, and adds only the pieces nobody
 *         shipped:
 *
 *           ERC-721/165/2981/4906  liquidity, royalties, metadata invalidation
 *           ERC-8004               identity, reputation, validation registries
 *           ERC-6551               the agent's own wallet (token bound account)
 *           ERC-7857               encrypted state with re-keying on transfer
 *           ERC-4907               rent an agent without selling it
 *           ERC-5192               conditional lock while mid-job or under dispute
 *
 *         The additions are: an on-chain manifest commitment (so an agent cannot swap its
 *         endpoints after you read its card), a machine-readable seal policy (so private
 *         state makes an honest promise), a published autonomy policy (so counterparties
 *         can see the leash), and a slashable bond (so reputation costs something).
 */
interface IAnima {
    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted whenever the off-chain manifest commitment changes.
    /// @param manifestHash keccak256 over the exact bytes served at `agentURI`.
    event ManifestUpdated(uint256 indexed agentId, bytes32 manifestHash, uint32 version, string agentURI);

    /// @notice Emitted when the agent's declared model changes. Buyers should treat a
    ///         model change as invalidating any prior reputation earned under the old one.
    event ModelDeclared(uint256 indexed agentId, bytes32 weightsRoot, uint8 attestationKind, string modelId);

    /// @notice Emitted when brain shards are replaced wholesale (mint, re-key, or update).
    /// @param brainEpoch Monotonic counter; a buyer verifies re-keying happened by
    ///        observing that the epoch advanced during their acquiring transfer.
    event BrainUpdated(uint256 indexed agentId, uint64 brainEpoch, bytes32 brainRoot, SealPolicy seal);

    /// @notice Sealed content keys published for `recipient` after a re-keying transfer.
    ///         Mirrors ERC-7857's `PublishedSealedKey`.
    event SealedKeysPublished(uint256 indexed agentId, address indexed recipient, uint64 brainEpoch, bytes[] sealedKeys);

    event PolicyUpdated(uint256 indexed agentId, AutonomyPolicy policy);
    event StatusChanged(uint256 indexed agentId, AgentStatus previous, AgentStatus current);
    event WalletBound(uint256 indexed agentId, address indexed wallet);
    event GuardianSet(uint256 indexed agentId, address indexed guardian);
    event OperatorSet(uint256 indexed agentId, address indexed operator, bool allowed);

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotAgentController(uint256 agentId, address caller);
    error AgentLocked(uint256 agentId);
    error AgentNotActive(uint256 agentId, AgentStatus status);
    error InvalidStatusTransition(AgentStatus from, AgentStatus to);
    error BrainEpochMismatch(uint64 expected, uint64 actual);
    error SealPolicyNotUpgradable(SealPolicy from, SealPolicy to);
    error NoEncryptionKey(address account);
    error UnknownAgent(uint256 agentId);
    error ZeroAddress();
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();

    /*//////////////////////////////////////////////////////////////
                             IDENTITY & MANIFEST
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint a new agent. `agentId` doubles as the ERC-8004 agent identifier and
    ///         the ERC-721 tokenId, so one token is one globally addressable agent:
    ///         `eip155:<chainId>:<thisContract>` + `agentId`.
    function mintAgent(
        address to,
        string calldata agentURI,
        bytes32 manifestHash,
        ModelIdentity calldata model,
        BrainShard[] calldata shards,
        SealPolicy seal,
        MetadataEntry[] calldata metadata
    ) external returns (uint256 agentId);

    /// @notice Update the manifest pointer and its commitment together. They are set in one
    ///         call by construction: a URI without a matching hash is exactly the hole that
    ///         lets an agent show you one card and serve another.
    function setManifest(uint256 agentId, string calldata agentURI, bytes32 manifestHash) external;

    function manifestOf(uint256 agentId)
        external
        view
        returns (string memory agentURI, bytes32 manifestHash, uint32 version);

    /// @notice Convenience check for clients that just fetched the manifest bytes.
    function verifyManifest(uint256 agentId, bytes calldata manifest) external view returns (bool);

    /*//////////////////////////////////////////////////////////////
                                   MODEL
    //////////////////////////////////////////////////////////////*/

    function declareModel(uint256 agentId, ModelIdentity calldata model) external;

    function modelOf(uint256 agentId) external view returns (ModelIdentity memory);

    /*//////////////////////////////////////////////////////////////
                                   BRAIN
    //////////////////////////////////////////////////////////////*/

    function brainOf(uint256 agentId) external view returns (BrainShard[] memory);

    /// @notice Merkle/digest root over the current shard set; the value committed to in
    ///         `BrainUpdated` and the anchor a cross-chain replica must match.
    function brainRoot(uint256 agentId) external view returns (bytes32);

    function brainEpoch(uint256 agentId) external view returns (uint64);

    /// @notice At mint this is the issuer's *claim*. After any `transferWithBrain` it is
    ///         overwritten with what the configured verifier actually certified, so the
    ///         field converges on the truth as the agent changes hands.
    function sealPolicyOf(uint256 agentId) external view returns (SealPolicy);

    /// @notice Weaken your own seal claim. Strengthening it is impossible by design: a
    ///         stronger policy can only be recorded by a verifier that certified a re-key.
    function downgradeSealPolicy(uint256 agentId, SealPolicy seal) external;

    /// @notice Replace the brain in place (the agent learned something). Requires the
    ///         caller to pin `expectedEpoch`, which makes concurrent updates fail loudly
    ///         instead of silently clobbering each other.
    function updateBrain(uint256 agentId, BrainShard[] calldata shards, uint64 expectedEpoch) external;

    /// @notice Transfer an agent *and* re-key its private state to the recipient in a single
    ///         atomic step, so ownership and decryptability can never diverge.
    /// @param proof Opaque bytes handed to the configured `ITransferVerifier`; its shape is
    ///        the verifier's business (TEE quote, zk proof, threshold signature set).
    function transferWithBrain(
        address from,
        address to,
        uint256 agentId,
        BrainShard[] calldata newShards,
        bytes[] calldata sealedKeys,
        bytes calldata proof
    ) external;

    /// @notice The {EncryptionKeyRegistry} this collection seals to. A buyer of a sealed
    ///         agent must have published a key there before the transfer can be proven,
    ///         which is what stops the common failure where an "encrypted" NFT is sold to
    ///         someone who can never decrypt it.
    function keyRegistry() external view returns (address);

    /*//////////////////////////////////////////////////////////////
                              WALLET & AUTONOMY
    //////////////////////////////////////////////////////////////*/

    /// @notice The agent's ERC-6551 token bound account — deterministic, so it is known
    ///         before it is deployed and survives every transfer of the token.
    function accountOf(uint256 agentId) external view returns (address);

    /// @notice Deploy the token bound account if it does not exist yet. Idempotent.
    function deployAccount(uint256 agentId) external returns (address);

    function policyOf(uint256 agentId) external view returns (AutonomyPolicy memory);

    function setPolicy(uint256 agentId, AutonomyPolicy calldata policy) external;

    /// @notice Addresses permitted to drive the agent (submit work, sign as it) without
    ///         owning it. Distinct from ERC-4907 `user`: operators are the agent's staff,
    ///         the ERC-4907 user is its tenant.
    function isOperator(uint256 agentId, address operator) external view returns (bool);

    function setOperator(uint256 agentId, address operator, bool allowed) external;

    /// @notice Anyone who may act on the agent's configuration: owner, ERC-4907 user
    ///         (within their lease), or a registered operator.
    function isController(uint256 agentId, address account) external view returns (bool);

    /*//////////////////////////////////////////////////////////////
                             LIFECYCLE & SAFETY
    //////////////////////////////////////////////////////////////*/

    function statusOf(uint256 agentId) external view returns (AgentStatus);

    function setStatus(uint256 agentId, AgentStatus status) external;

    /// @notice A guardian may only ever *pause* — never transfer, never spend, never
    ///         unpause. A kill switch that can also steal is not a safety feature.
    function guardianOf(uint256 agentId) external view returns (address);

    function setGuardian(uint256 agentId, address guardian) external;

    function guardianPause(uint256 agentId) external;
}
