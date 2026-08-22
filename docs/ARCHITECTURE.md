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
