# ERC-XXXX: Sovereign Agent Tokens

| Field | Value |
|---|---|
| **Title** | Sovereign Agent Tokens |
| **Status** | Draft (unsubmitted) |
| **Type** | Standards Track — ERC |
| **Requires** | 165, 712, 721, 1271, 2981, 4906, 4907, 5192, 5646, 6454, 6492, 6551, 8004 |
| **Created** | 2026-08 |

## Abstract

An ERC-721 extension in which each token is a complete, economically accountable AI agent: an
on-chain identity with a committed off-chain manifest, a token bound account whose autonomy is
publicly bounded, private state whose protection level is machine-readable and self-correcting,
and a slashable bond that caps how much the agent can cost a counterparty.

## Motivation

ERC-8004 standardises agent *identity*. ERC-6551 gives any NFT a *wallet*. ERC-7857 gives an
NFT *private state* that re-keys on transfer. Each is sound; none composes with the others, and
none answers the question a counterparty actually has:

> *If I hire this agent and it fails, what happens?*

Today the answer is "nothing". Reputation is free to mint, validation is advisory, and an
agent's spending authority is invisible until after it has spent. This proposal binds the
existing standards into one token and adds the three missing pieces: a **published leash**, a
**truthful seal policy**, and a **slashable bond**.

A secondary motivation is negative. Several plausible-looking designs are excluded on purpose,
and the Rationale records why, so implementers do not rediscover them.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in RFC 2119.

### 1. Core types

```solidity
enum AgentStatus { Inactive, Active, Paused, Disputed, Retired }

enum SealPolicy { None, Committed, ReKeyed, SealedTEE, SealedZK, Threshold }

struct BrainShard {
    bytes32 dataHash;        // keccak256 of ciphertext (or plaintext when SealPolicy.None)
    bytes32 keyCommitment;   // commitment to the content key; zero when unencrypted
    uint64  size;            // bytes
    uint8   kind;            // ShardKind
    string  uri;             // ipfs:// | ar:// | 0g:// | https://
    string  description;
}

struct ModelIdentity {
    bytes32 weightsRoot;
    bytes32 runtimeMeasurement;  // MRENCLAVE / TDX MRTD / SEV-SNP, or zero
    uint8   attestationKind;     // 0 none, 1 signed, 2 TEE, 3 zk, 4 optimistic
    string  modelId;
}

struct AutonomyPolicy {
    uint128 perTxWei;
    uint128 dailyWei;
    uint64  expiry;              // 0 = no expiry
    bool    allowDelegateCall;
    bool    allowUnlistedTargets;
    bytes32 targetsRoot;         // merkle root over keccak(abi.encode(target, selector))
}
```

### 2. Identity

A conforming token MUST implement ERC-721 and ERC-8004's `IIdentityRegistry`, and MUST use the
**same integer** as both the ERC-721 `tokenId` and the ERC-8004 `agentId`, so an agent is
globally addressed as `eip155:<chainId>:<contract>` plus that id.

### 3. Manifest commitment

```solidity
function setManifest(uint256 agentId, string calldata agentURI, bytes32 manifestHash) external;
function manifestOf(uint256 agentId) external view returns (string memory, bytes32, uint32);
function verifyManifest(uint256 agentId, bytes calldata manifest) external view returns (bool);
```

- The URI and its commitment MUST be settable only together.
- `manifestHash` MUST be `keccak256` over the exact bytes served at `agentURI`.
- Every change MUST increment `version` and emit `ManifestUpdated` and ERC-4906 `MetadataUpdate`.
- ERC-8004's `setAgentURI` MUST set the commitment to `bytes32(0)` ("uncommitted"). It MUST NOT
  leave a previous hash in place.

*A URI without a matching hash is exactly the hole that lets an agent show you one card and
serve another.*

The manifest SHOULD be a superset of an A2A `AgentCard` and SHOULD additionally declare MCP
endpoints, pricing, and the agent's declared capabilities.

### 4. Private state

```solidity
function brainOf(uint256 agentId)   external view returns (BrainShard[] memory);
function brainRoot(uint256 agentId) external view returns (bytes32);
function brainEpoch(uint256 agentId) external view returns (uint64);
function updateBrain(uint256 agentId, BrainShard[] calldata shards, uint64 expectedEpoch) external;
function transferWithBrain(
    address from, address to, uint256 agentId,
    BrainShard[] calldata newShards, bytes[] calldata sealedKeys, bytes calldata proof
) external;
```

- `brainRoot` MUST be a deterministic, order-sensitive commitment over the shard set that an
  off-chain indexer can reproduce.
- `updateBrain` MUST revert unless `expectedEpoch` equals the current epoch (optimistic
  concurrency: two writers must not silently clobber one another).
- `transferWithBrain` MUST re-key and transfer atomically, MUST increment `brainEpoch`, and
  MUST revert if the recipient has published no encryption key.
- After a successful `transferWithBrain` the stored `SealPolicy` MUST be set to the value the
  verifier reports, whether that is stronger or weaker than the previous value.

### 5. Seal policy

```solidity
function sealPolicyOf(uint256 agentId) external view returns (SealPolicy);
function downgradeSealPolicy(uint256 agentId, SealPolicy seal) external;
```

At mint, `SealPolicy` is the issuer's **claim**. It MUST be strengthenable only by a verifier
certifying a re-key. An owner MAY weaken it at any time.

*Rationale: no cryptography prevents a previous owner who already decrypted the plaintext from
retaining it. The guarantee level is therefore published as data so a buyer prices the residual
risk, rather than being told a promise the mechanism cannot keep.*

### 6. Encryption keys

Sealing to an address is impossible in general — an address is a hash, and a smart-account
holder may have no recoverable encryption key. Implementations MUST require the recipient to
have published an encryption key before a sealed transfer, and SHOULD read it from a
chain-wide registry rather than per-collection state.

### 7. Wallet and autonomy

```solidity
function accountOf(uint256 agentId) external view returns (address);
function policyOf(uint256 agentId)  external view returns (AutonomyPolicy memory);
function setPolicy(uint256 agentId, AutonomyPolicy calldata policy) external;
```

- `accountOf` MUST be the ERC-6551 address derived from `(implementation, salt, chainId,
  address(this), agentId)`, and MUST return the same value before and after deployment.
- The account MUST enforce `policyOf` against **session keys** and MUST NOT enforce it against
  the token's owner. The owner must always be able to rescue a paused or misconfigured agent.
- The account MUST refuse session-key execution unless `statusOf(agentId) == Active`.
- Session keys MUST NOT be able to produce valid ERC-1271 signatures. *A budget cap means
  nothing if the key can instead sign an unbounded off-chain order some other protocol honours.*

### 8. Autonomy does not survive a transfer

On any transfer between non-zero addresses an implementation MUST:

1. invalidate every operator authorisation granted by the previous owner;
2. clear the ERC-4907 user, the guardian, and any bound wallet;
3. zero the `AutonomyPolicy`;
4. set status to `Paused`.

*Rationale: an agent that keeps executing its previous owner's policy on behalf of its new owner
is how a treasury disappears. Operator invalidation SHOULD be implemented by epoch-rolling the
authorisation mapping, since a mapping's keys cannot be enumerated to clear individually.*

### 9. Locking

An implementation MUST implement both ERC-5192 `locked` and ERC-6454 `isTransferable`, and MUST
enforce them in the transfer path — both interfaces are descriptive and stop nothing on their
own. Locking MUST be temporary and purposeful (an agent that owes work or is under dispute),
not permanent soulbinding, and MUST also block burning.

### 10. Guardian

```solidity
function guardianOf(uint256 agentId) external view returns (address);
function guardianPause(uint256 agentId) external;
```

A guardian MUST be able to pause and MUST NOT be able to transfer, spend, reconfigure, or
un-pause.

### 11. Accountability (RECOMMENDED)

An implementation SHOULD expose slashable collateral such that the maximum a counterparty can
lose to an agent is bounded by, and readable from, the agent's own free coverage. Where such a
vault exists:

- collateral queued for withdrawal MUST remain slashable for the full cooldown;
- slashing MUST consume free collateral before collateral reserved against other obligations;
- a queued withdrawal MUST pay the address that queued it, not the current token holder.

### 12. Events

```solidity
event ManifestUpdated(uint256 indexed agentId, bytes32 manifestHash, uint32 version, string agentURI);
event ModelDeclared(uint256 indexed agentId, bytes32 weightsRoot, uint8 attestationKind, string modelId);
event BrainUpdated(uint256 indexed agentId, uint64 brainEpoch, bytes32 brainRoot, SealPolicy seal);
event SealedKeysPublished(uint256 indexed agentId, address indexed recipient, uint64 brainEpoch, bytes[] sealedKeys);
event PolicyUpdated(uint256 indexed agentId, AutonomyPolicy policy);
event StatusChanged(uint256 indexed agentId, AgentStatus previous, AgentStatus current);
event WalletBound(uint256 indexed agentId, address indexed wallet);
event GuardianSet(uint256 indexed agentId, address indexed guardian);
event OperatorSet(uint256 indexed agentId, address indexed operator, bool allowed);
```

### 13. Interface identifiers

| Interface | ID |
|---|---|
| ERC-165 | `0x01ffc9a7` |
| ERC-721 | `0x80ac58cd` |
| ERC-721Metadata | `0x5b5e139f` |
| ERC-2981 | `0x2a55205a` |
| ERC-4906 | `0x49064906` *(hand-picked constant, not an XOR — `type(IERC4906).interfaceId` is `0x00000000`)* |
| ERC-4907 | `0xad092b5c` |
| ERC-5192 | `0xb45a3c0e` |
| ERC-6454 | `0x91a6262f` |
| ERC-7572 | `0xe8a3d485` *(unofficial; the draft publishes none)* |
| ERC-5646 | `0xf5112315` |
| ERC-7432 | `0xd00ca5cf` *(on the roles registry, not the token — see below)* |

## Rationale

**Why compose rather than replace.** Every standard listed under *Requires* has deployed users.
A new agent standard that ignored them would be strictly worse: it would inherit none of the
tooling and would have to re-solve identity, wallets and rental from scratch.

**Why the bond is the centrepiece.** Permissionless feedback (ERC-8004) is correct as a base
layer and worthless consumed naively — an agent can rate itself perfect for the price of gas.
Weighting by settled value fixes the signal; a bond fixes the incentive. Together they make the
cost of faking a reputation equal to the value of the jobs faked.

**Why autonomy is revoked on sale rather than transferred.** Continuity would be more
convenient. It is also the single most dangerous default available: the buyer inherits an
actively-spending agent configured by someone who no longer has any interest in their outcome.

**Why `SealPolicy` is data and not a guarantee.** See §5. The alternative — asserting that
transfer makes prior plaintext unrecoverable — is false, and encoding a false claim in a
standard is worse than encoding an honest one.

**Why per-token spending budgets are separate from the account's native caps.** A native-value
cap does not constrain ERC-20 movement at all. Any implementation that stops at `msg.value` has
a spending limit in name only.

## Backwards compatibility

Fully ERC-721 compatible; a conforming token trades on any existing marketplace. ERC-8004
clients that only know `IIdentityRegistry` interoperate through the `register()` overloads.
Marketplaces that read only ERC-5192 see correct lock state; those that read ERC-6454 see a
more precise answer.

Roles beyond ERC-4907's single `user` SHOULD be provided through an external ERC-7432 registry
rather than on the token. ERC-7432 is deliberately not an ERC-721 extension for this reason, and a
maximal agent token has no room for it: the reference implementation is already within 605 bytes of
the EIP-170 limit.

Implementations MUST NOT also implement ERC-4519 (its `userOf` collides with ERC-4907 at the
selector level with different semantics) or ERC-3525 (which overloads `balanceOf` and `approve`
against ERC-721).

### Multi-contract implementations

An implementation MAY be assembled from EIP-2535 facets. Two requirements follow, and both are
consequences of `getStateFingerprint` rather than new rules:

1. The `AgentCore` struct MUST have the layout given in §Specification, field for field and in
   order. The fingerprint ABI-encodes the struct wholesale, so a field reordered in one
   implementation and not another yields two different fingerprints for the same agent — and a
   buyer who pinned one would be checking nothing.
2. State MUST be held in an ERC-7201 namespace. EIP-2535 explicitly leaves storage layout
   undefined, which makes collision between independently written facets the default outcome
   rather than an exotic one.

An implementation that is upgradeable — a diamond retaining `diamondCut`, or any proxy with a
live admin — does not conform. Every guarantee in this specification is a statement about what
cannot happen to an agent after you acquire it, and an address that can be given new code makes
all of them conditional on an admin key.

## Security considerations

See [SECURITY.md](SECURITY.md) for the full invariant list. The load-bearing ones:

1. Operator authorisations MUST NOT survive a transfer.
2. A locked agent MUST NOT be transferable or burnable.
3. `transferWithBrain` MUST be atomic and reentrancy-guarded; the verifier is an external call
   made before state changes.
4. Wallet binding MUST require a signature *from the wallet*, or an agent can claim any address
   and inherit its standing.
5. Session keys MUST NOT sign ERC-1271 payloads.
6. Rounding in any curve or vault MUST favour the protocol, never the caller.
7. Optional side effects MUST NOT be wrapped in `try/catch` on a path whose gas is estimated —
   `eth_estimateGas` finds the cheapest successful path, which is the one where the side effect
   silently fails.

## Reference implementation

<https://github.com/venividis/Cutting-edge-technologically-advanced-NFT> — 26 contracts,
248 tests. Two conformant builds of the token: `contracts/core/AnimaAgent.sol` (one contract)
and `contracts/diamond/` (an immutable EIP-2535 assembly). The same suite runs against both.

## Copyright

CC0.
