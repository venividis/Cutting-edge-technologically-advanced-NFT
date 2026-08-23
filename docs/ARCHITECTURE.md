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
