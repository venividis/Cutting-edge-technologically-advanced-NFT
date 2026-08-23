# Architecture

17 contracts in four layers. Each layer is usable without the ones above it.

## Layer 1 — Core

| Contract | Size | Responsibility |
|---|---:|---|
| `core/AnimaAgent.sol` | 22.8 KB | The token. ERC-721 + ERC-8004 identity + ERC-7857-derived sealed brain + rental, locking, royalties, contract metadata. |
| `account/AgentAccount.sol` | 10.7 KB | The agent's ERC-6551 wallet: session keys, budgets, target allowlist, audit chain, ERC-4337. |
| `core/EncryptionKeyRegistry.sol` | 1.8 KB | Chain-wide registry of recipients' encryption keys. |
| `core/verifiers/*.sol` | 4.2 KB | Pluggable re-key adjudication: null, and an M-of-N attester quorum. |
| `mocks/ERC6551Registry.sol` | — | Behaviour-faithful registry for local chains; production points at the canonical `0x000000006551c19487814612e58FE06813775758`. |

**Why `AnimaAgent` is one contract and not a diamond.** The full extension stack does not fit in
24,576 bytes naively; the alternatives were EIP-2535, linked libraries, or a feature cut. A
diamond would put the token's rules behind a mutable facet registry, which defeats the point of
publishing a leash. Linked libraries were measured and made it *worse* — encoding dynamic arrays
for a `delegatecall` costs more bytecode than the inline loop it replaces (`BrainLib`'s comment
records this so nobody retries it). What worked was removing genuine duplication: unifying the
shard loops on one `memory` implementation, collapsing the ERC-8004 `register()` overloads, and
moving the encryption-key registry out — which is better architecture anyway, since a key belongs
to a person rather than to a collection.

Final: **22,775 bytes, 1,801 to spare.**

### Storage layout

`AgentCore` is packed to four slots:

```
slot 0  manifestHash                                              32
slot 1  brainRoot                                                 32
slot 2  guardian(20) status(1) seal(1) version(4) lockCount(4)    30/32
slot 3  brainEpoch(8) createdAt(8) operatorEpoch(8)               24/32
```

`operatorEpoch` is the mechanism behind "autonomy does not survive a sale": operator
authorisations are stored under `_operator[agentId][epoch][address]`, so incrementing the epoch
invalidates every one of them in a single write. A mapping's keys cannot be enumerated, so there
is no other O(1) way to revoke authorisations you did not record.

## Layer 2 — Accountability

```
        offerJob            acceptJob             deliver          acceptDelivery
 client ────────► Offered ──────────────► Active ─────────► Delivered ───────────► Settled
          │                  reserves bond          │                    │
          │ cancelOffer      locks agent            │ claimMissedDeadline│ claimUnreviewed
          ▼                                         ▼   (refund + slash) │  (pays agent)
       Cancelled                                  dispute                │
                                                     │                   ▼
                                                     ▼            attested feedback
                                                  Disputed ──► validator verdict
                                                     │            pass → agent paid
                                                     │            fail → refund + slash
                                                     └─ silence → resolveStaleDispute
                                                                  (refund, no slash)
```

**Every wait has a timer and every timer has a default winner.** In a two-party escrow both sides
can grief by doing nothing, so:

- an unaccepted offer is withdrawable at any time — and reserves nothing, or a stream of unwanted
  offers could pin an agent's entire bond and stop it earning;
- a missed deadline refunds the client *and* takes coverage;
- an unreviewed delivery pays the agent — refusing to click accept is not a free option;
- a disputed job goes to the validator named when the job was created, so neither side can shop
  for a friendlier referee after seeing the result;
- a validator who never answers returns everyone's money untouched. Nobody proved anything, so
  nobody is punished.

`BondVault` maintains `total >= reserved + unbonding`. Slashing consumes free collateral, then
unbonding, then reserved — reserved collateral is another client's protection, and one bad job
must not cascade into everyone else's coverage.

## Layer 3 — Markets

`AgentMarket` settles EIP-712 orders for sale and rental. Its distinguishing feature is that
orders bind to the agent's *substance* — see the README. Paid rentals lock the agent for the
term; ERC-4907 clearing `user` on transfer is correct for a free lease and a rug for a paid one.

`AgentLaunchpad` + `AgentToken` are a bonding curve whose token has a redemption floor. Fees split
three ways — protocol, the token's redemption treasury, and the agent's own account — so trading
leaves durable value in the token rather than only in a fee wallet. Graduation moves the raise and
the unsold supply into an `ILiquidityDeployer`; that seam is abstract because Uniswap v2/v3/v4,
Balancer and every L2 fork want different call shapes, and hard-coding one would date the contract
the moment the venue changed.

`AgentDerivativesDesk` covers the axis spot budgets cannot: leverage. It caps notional, margin at
risk and leverage per market plus collateral across the whole portfolio, and checks all of it
against what the venue reports after the trade rather than what the agent declared before it. Of
the three quantities it tracks, only the adapter's notional is trusted — collateral at risk is
arithmetic on funds the desk moved itself.

`AgentHandles` binds verified off-chain identities to an agent: an inbox (the one that unlocks
signup flows across the web), a DNS domain, a DID, an ENS name, a social account, a libp2p mesh
peer id. Attestations are per-kind, one-agent-per-handle, and go stale on transfer.

`AgentSwapRouter` is the only door an agent should be allowed to trade through. Allowlist *it* in
the `AutonomyPolicy`, set per-token budgets, and the agent's reach is genuinely bounded rather than
nominally bounded.

## Layer 4 — Reach

`AgentComms` prices attention: postage is escrowed and collectable only by replying, and refunds
if ignored. `InferenceMeter` runs unidirectional payment channels with cumulative vouchers, so a
thousand calls settle in one transaction — and the voucher commits to the exact receipt batch,
making the record of what an agent did bilateral.

`OmniAgentHome` / `OmniAgentMirror` move the token across chains over LayerZero V2 while keeping
one canonical home for accountability. `AnimaBindings` implements ERC-8217 so an entry in the
chain's singleton ERC-8004 registry can point back at an ANIMA token.

## Off-chain interfaces, and their moving parts

The contracts commit to documents that live off-chain, so the shapes of those documents matter.
Recorded with dates because several changed recently in ways that break older integrations:

- **A2A v1.0.0** (2026-03-12) restructured the AgentCard: `url`/`preferredTransport`/
  `additionalInterfaces` collapsed into one ordered `supportedInterfaces[]`, enums serialise as
  ProtoJSON SCREAMING_SNAKE, and the well-known path is `/.well-known/agent-card.json`. Crucially
  it is the *only* standard here that defines its own canonicalisation — RFC 8785 (JCS) — which
  is why the SDK uses JCS and why `keccak256(manifest)` is byte-identical to what an A2A JWS
  already signs.
- **MCP 2026-07-28** made the protocol stateless: no `initialize` handshake, no session id,
  discovery via `server/discover`. Sampling, roots and logging are deprecated. A design that
  hashed an `initialize` result would be hashing something that no longer exists.
- **x402 v2** renamed every header (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`),
  renamed `maxAmountRequired` to `amount`, and moved to CAIP-2 network identifiers. Anything
  referencing `X-PAYMENT` is v1. `InferenceMeter` is a settlement layer underneath this rather
  than an implementation of it — channels exist because a settlement per inference costs more
  than the inference.
- **ERC-7715**'s method is `wallet_requestExecutionPermissions`, not `wallet_grantPermissions`.
- **Sovereign Agent Mesh** binds a libp2p peer id to an OIDC subject at its control plane and
  translates the claims into Biscuit Datalog facts (`user(...)`, `role(...)`, `node(<peer-id>)`).
  `AgentHandles` publishes the same peer id against the token, so a mesh can check the chain
  instead of an identity provider.

## One capability ported from outside EVM

ERC-721's `setApprovalForAll` is unbounded in time, unbounded in scope, and not enumerable
on-chain — the direct cause of the largest class of NFT user losses. Two ecosystems arrived
independently at the fix: ICRC-37 puts `expires_at` on every approval with batch revocation, and
CW-721 puts `expires` on both `Approve` and `ApproveAll`.

ANIMA ports it. `setApprovalForAll` keeps its ERC-721 signature and semantics, because breaking
it would break every marketplace; alongside it sit `setApprovalForAllUntil` and an O(1)
`revokeAllApprovals`, with `approvalExpiryOf` so a holder can see what is outstanding.
Enumeration is left to indexers via events — a per-owner operator list would cost more bytecode
than the token has left, and the log answers the question equally well.

This is the same defect as every finding in the security review: an authorisation that outlives
the relationship it was granted under.

Worth noting for cross-ecosystem reach: Solana's Metaplex Agent Registry (June 2026) adopted
ERC-8004 as its agent registration schema outright — its `AgentIdentity` plugin points at an
ERC-8004 registration JSON. Conforming to ERC-8004 rather than competing with it is what makes
an agent legible outside EVM at all.

## Final standards a research pass caught late

Four were missing and each closed a real hole:

- **ERC-5646 Token State Fingerprint** (Final, 2022) — `getStateFingerprint`, interfaceId
  `0xf5112315`. The marketplace pins account state, brain root and coverage individually because
  those are the three a buyer is most often cheated on; this is the general and standardised
  form. It strictly dominates the ERC-6551 `state()` nonce, which sees only the bound account and
  says nothing about the agent's memory, model, status, guardian, lease or policy.
- **ERC-6492 Signature Validation for Predeploy Contracts** (Final, 2023). ANIMA needs this more
  than most protocols: counterfactual accounts are not an edge case here, they are the design. An
  ERC-6551 account has an address from the moment its token exists and is usually deployed lazily,
  so a maker signing as their agent's own wallet could not list it at all — a `staticcall` to a
  codeless address succeeds with no data, which reads as "invalid signature".
- **Bridge rate limiting.** Neither ONFT721 nor HypERC721 has one, which is the difference between
  a compromised DVN set costing one agent and costing all of them. `AnimaOApp` caps inbound
  messages per source chain; a throttled message stays retryable, so the cap converts a drain into
  a delay someone can notice. Off by default, so a deployment picks a number rather than inheriting
  one.
- **ERC-7007 Verifiable AI-Generated Content** (Final, 2023) specifies both zkML *and* opML paths
  for proving an inference. `InferenceMeter`'s receipts already carry an `attestationKind` with an
  optimistic value, which is the right shape; the actual challenge game is venue-specific and is
  deliberately not in this repository.

**ERC-7432 Non-Fungible Token Roles** (Final) is implemented — as `AnimaRoles`, a standalone
registry. An earlier draft of this document said it "does not fit", which was the wrong frame: it
was never supposed to fit. The spec's Rationale is explicit that it is deliberately *not* an
ERC-721 extension, "to enable it to be implemented externally or on the same contract as the NFT",
and every function carries `tokenAddress` beside `tokenId` for exactly that reason. Zero bytes were
added to the token.

It gives an agent distinct operator, payer, auditor and trainer roles, each with its own recipient,
expiry and revocability — where ERC-4907 has one `user` slot and no revocability flag at all. Where
the spec suggests a registry take custody of the NFT so a role cannot be sold out from under its
holder, `AnimaRoles` registers as an ANIMA module and uses the native lock instead: the owner keeps
the token in their own wallet, visible to every marketplace, and it simply cannot move while a role
is live. Irrevocable roles are capped at a year, because a grant the owner cannot end is a lock the
owner cannot lift.

## The 24 KB wall, measured

`AnimaAgent` sits at 23,971 of the 24,576 bytes EIP-170 allows. The options, with real numbers
rather than folklore:

| Lever | Recovers | Cost |
|---|---:|---|
| Drop the CBOR metadata trailer | 53 B | loses the source-verification hash |
| Optimizer `runs: 200` → `1` | 376 B | taxes every call the contract ever serves |
| Both together | 429 B | as above |
| Move a feature to a linked contract | its whole size | one external call per read |

The first two are not worth having: the most aggressive combination buys less than one small
feature and makes the contract permanently more expensive to use. **Composition is the only lever
that scales**, and it is the one the standards were designed for.

Note what does *not* help: an NFT holding other NFTs. ERC-7401 nesting moves ownership and data,
not code — a token that owns a thousand tokens has exactly the same bytecode budget. Likewise
SSTORE2 stores *data* in contract code, which is the opposite problem.

One measured trap: moving `writeShards` into a `public` library made the token **4 KB larger**, not
smaller. ABI-encoding a dynamic array for a `delegatecall` costs more bytecode than the inline loop
it replaced. Public libraries pay off for simple value-type parameters and backfire on dynamic ones.

If the *token itself* ever has to grow, the remaining option is an **immutable diamond** — EIP-2535
facets with `diamondCut` removed after deployment. That buys unlimited code while keeping the
property that matters here, which is that nobody can rewrite an agent's rules after the fact. It
costs a delegatecall and a selector lookup on every call, and demands ERC-7201 namespaced storage
discipline. **ERC-7656 Generalized Contract-Linked Services** (Final) is the lighter form of the
same idea and remains the right next move for the brain-commitment and lifecycle services.

## Trust boundaries

| Party | Can | Cannot |
|---|---|---|
| Token owner | everything on their agent; unlimited spending from its account | touch another agent |
| Session key | spend within per-tx, daily and session caps, to allowlisted targets, while Active | sign ERC-1271; exceed caps; act while paused |
| Operator | configure, update brain, submit/deliver work | spend (needs a session) |
| ERC-4907 tenant | operate within the lease | reconfigure ownership-level settings |
| Guardian | pause; revoke a session; revoke a swap token | transfer, spend, un-pause |
| Module (escrow, market) | lock/unlock, set Disputed, reserve/release/slash bond | transfer or spend |
| Contract owner | swap the verifier, manage the module allowlist, set fees (capped) | mint on behalf of others, move agents, take bonds |

## Extension points

- `ITransferVerifier` — swap the trust model for private state without a token migration.
- `ILiquidityDeployer` — target any AMM at graduation.
- Module allowlist — new settlement primitives gain lock/dispute rights without touching the token.
- `AnimaOApp` — any new cross-chain message type inherits peer authentication.
