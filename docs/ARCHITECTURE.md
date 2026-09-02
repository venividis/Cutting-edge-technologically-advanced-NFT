# Architecture

26 contracts in four layers, plus an alternate assembly of the token itself. Each layer is
usable without the ones above it.

## Layer 1 — Core

| Contract | Size | Responsibility |
|---|---:|---|
| `core/AnimaAgent.sol` | 24.0 KB | The token. ERC-721 + ERC-8004 identity + ERC-7857-derived sealed brain + rental, locking, royalties, contract metadata. |
| `account/AgentAccount.sol` | 10.7 KB | The agent's ERC-6551 wallet: session keys, budgets, target allowlist, audit chain, ERC-4337. |
| `core/EncryptionKeyRegistry.sol` | 1.8 KB | Chain-wide registry of recipients' encryption keys. |
| `core/verifiers/*.sol` | 4.2 KB | Pluggable re-key adjudication: null, and an M-of-N attester quorum. |
| `mocks/ERC6551Registry.sol` | — | Behaviour-faithful registry for local chains; production points at the canonical `0x000000006551c19487814612e58FE06813775758`. |

**Why `AnimaAgent` is one contract.** The full extension stack does not fit in 24,576 bytes
naively; the alternatives were EIP-2535, linked libraries, or a feature cut. Linked libraries were
measured and made it *worse* — encoding dynamic arrays for a `delegatecall` costs more bytecode
than the inline loop it replaces (`BrainLib`'s comment records this so nobody retries it). What
worked was removing genuine duplication: unifying the shard loops on one `memory` implementation,
collapsing the ERC-8004 `register()` overloads, and moving the encryption-key registry out — which
is better architecture anyway, since a key belongs to a person rather than to a collection.

Final: **23,971 bytes, 605 to spare.** That margin is the reason Layer 1b exists.

### Storage layout

`AgentCore` is packed to four slots:

```
slot 0  manifestHash                                              32
slot 1  brainRoot                                                 32
slot 2  guardian(20) status(1) seal(1) version(4) lockCount(4)
        disputeCount(2)                                           32/32
slot 3  brainEpoch(8) createdAt(8) operatorEpoch(8)               24/32
```

`operatorEpoch` is the mechanism behind "autonomy does not survive a sale": operator
authorisations are stored under `_operator[agentId][epoch][address]`, so incrementing the epoch
invalidates every one of them in a single write. A mapping's keys cannot be enumerated, so there
is no other O(1) way to revoke authorisations you did not record.

## Layer 1b — The same token, as an immutable diamond

The monolith fits with 605 bytes to spare, which is a countdown rather than a margin. `AnimaDiamond`
removes the ceiling instead of raising it: the identical token, assembled from facets under
EIP-2535, with **no `diamondCut` function**.

| Contract | Size | Responsibility |
|---|---:|---|
| `diamond/AnimaDiamond.sol` | 177 B | Constructor and fallback. Wires the facets, emits `DiamondCut` once, and has no other code — nothing to call, nothing to change. |
| `diamond/AnimaBase.sol` | — | Abstract. The transfer hook, the authorisation predicates, the approval store, `tokenURI`, ERC-165. Shared so no facet can disagree. |
| `diamond/AnimaCoreFacet.sol` | 9.9 KB | ERC-721 surface, expiring approvals, royalties, locking, administration. 38 selectors. |
| `diamond/AnimaAgentFacet.sol` | 15.1 KB | Manifest, metadata, model, wallet binding, policy, lifecycle, guardian, lease, ERC-5646 fingerprint. 34 selectors. |
| `diamond/AnimaBrainFacet.sol` | 15.8 KB | Minting, ERC-8004 `register`, brain reads and writes, re-keying transfer. 11 selectors. |
| `diamond/AnimaLoupeFacet.sol` | 1.7 KB | EIP-2535 introspection. 4 selectors. |
| `diamond/AnimaInit.sol` | 9.0 KB | Delegatecalled once from the constructor. Its selector is never routed, so it is unreachable afterwards. |
| `diamond/IAnimaConfigured.sol` | — | The `AnimaConfig` struct and the one-function interface the constructor's agreement check reads. |

**Why immutable.** The usual reason to build a diamond is upgradeability, and that is exactly the
property this token must not have. A buyer's guarantee that a sale revokes the seller's session
keys is worth precisely as much as the admin key that could remove it. EIP-2535 provides for
this: *"A diamond that has no external function for adding, replacing or removing functions is
immutable."* What stays configurable is what stays configurable in the monolith, under the same
two-step owner: the re-key verifier, the module allowlist, royalties, the contract URI.

Anyone can check the claim without trusting the deployer: call `facets()`, confirm no selector
resolves to `diamondCut`, and confirm each facet address holds the bytecode they expect.

**Storage.** EIP-2535 deliberately does not specify storage — *"The particular layout of storage
is not defined in this EIP"* — and that freedom is its failure mode, since two facets that each
declare their own variables collide at slot 0. ERC-7201 removes the hazard structurally:

```
anima.storage.core     0x2134dd8a40292237c0a0658c1368c4805ba84a926576fc8c56170c3a72e5a700
anima.storage.diamond  0xbebefff3c1769f392cbed28935c84c24a3fe9fb422c6177e5902f9088f11d900
```

Everything ERC-721, ERC-2981, EIP-712 and Ownable2Step need lives in OpenZeppelin's own ERC-7201
namespaces, so all three regions are disjoint by construction rather than by review. Slots 0, 1
and 2 of the diamond are asserted empty in the test suite — a facet that forgot and declared a
plain state variable would land right there.

**The pinned configuration, and what measuring it changed.** The four values that are `immutable`
in the monolith — the ERC-6551 registry, the account implementation and salt, the key registry —
are `immutable` per facet here too. They were diamond-storage fields first, on the reasoning that
facet immutables could be deployed disagreeing about which registry is canonical, giving the token
agents whose wallet address depends on which function you asked.

The gas benchmark refuted that trade. Three cold `SLOAD`s made `accountOf` cost **+11,081 gas**
against the monolith rather than the +4,700 every other call pays — and `accountOf` is the hottest
cross-contract read in the protocol: `WorkEscrow`, `InferenceMeter`, `AgentComms`, `AgentMarket`
(twice per fill), `AgentSwapRouter`, `AgentDerivativesDesk`, `AgentLaunchpad` and `OmniAgentHome`
all call it on their settlement paths to find where an agent's money goes.

So the values went back into facet code, and the hazard is removed by a check instead of a cost:
every facet implements `IAnimaConfigured.animaConfigHash()`, and `AnimaDiamond`'s constructor
collects it from each facet and from the initialiser and refuses to deploy unless they agree (a
facet like the loupe that carries no configuration simply doesn't answer and is skipped; at least
one must). `accountOf` is back to +4,731 and `getStateFingerprint` to +5,386.

### What the diamond costs, measured

`test/Gas.test.ts` deploys both builds on a fresh chain per probe and reports the delta. It fails
the build if any call drifts outside 25% relative *and* 6,000 gas absolute, so the numbers in
these docs cannot silently rot.

```
call                 monolith  diamond     delta      rel
--------------------------------------------------------
ownerOf                 24472    29062     +4590    18.8%
tokenURI                30058    34511     +4453    14.8%
supportsInterface       21998    26960     +4962    22.6%
isApprovedForAll        28511    32853     +4342    15.2%
accountOf               26863    31594     +4731    17.6%
getStateFingerprint     54818    60204     +5386     9.8%
mintAgent              311367   316587     +5220     1.7%
transferFrom            85818    90499     +4681     5.5%
updateBrain             68445    72833     +4388     6.4%
```

The overhead is flat at roughly 4,300–5,400 gas regardless of what the call does, which is exactly
what one `DELEGATECALL` costs: a cold `SLOAD` of the selector table (2,100) plus a cold account
access for the facet (2,600). It is therefore a rounding error on writes (1.7% on `mintAgent`) and
a visible fraction only on the cheapest views, where the absolute number is still under 5,000.

**How equivalence is established.** The facets partition the monolith's ABI. The cut is derived
from that ABI at deploy time and the fixture refuses to build if a monolith function goes unrouted
or a facet routes one the monolith lacks — so `ANIMA_IMPL=diamond` re-runs all 199 protocol tests
against the diamond with no test changes at all. `test/Diamond.test.ts` adds the direct
comparison: an identical agent is driven through the same sequence of state changes on both
builds, and their ERC-5646 fingerprints — one hash over the whole of an agent's mutable state —
must be byte-identical.

**What the constructor refuses.** In order: a cut with no facets, a non-`Add` action, a facet with
no code, an empty per-facet cut, a selector two facets both claim, facets that disagree about the
ERC-6551 configuration, a diamond in which none carries it, an initialiser whose call reverts, an
initialiser that did not take effect (checked by post-condition, because `delegatecall` to a
codeless address *returns success* — so a zero or EOA initialiser would otherwise deploy silently),
and an initialiser that repointed any selector the `DiamondCut` event had already announced.

That last one is worth stating precisely. The initialiser is `delegatecall`ed, so while it runs it
can write any storage in the diamond, including the routing table built moments earlier. EIP-2535
makes `DiamondCut` the canonical record of what a diamond is; without the check, an indexer or an
auditor reading it could see one table while callers reached another. The check makes the event
true for every selector it names. It does not make a hostile initialiser safe — one can still add
a selector the cut never mentioned, and nothing on-chain can prevent that, because the deployer
chooses the initialiser. So verifying a deployment means verifying the initialiser's source as
well as the facets'.

### The two intended divergences

Everything else is identical. These two are deliberate, tested, and the complete list:

1. **`supportsInterface(0x48e2b093)`** is true on the diamond and false on the monolith. The
   diamond genuinely implements the EIP-2535 loupe, and a caller wanting to verify the code behind
   the address is entitled to discover that from ERC-165.
2. **An unrouted selector reverts `FunctionNotFound(bytes4)`** rather than with empty returndata.
   That is the EIP-2535 convention and a far better diagnostic, but it means the diamond reverts
   with *non-empty* data where the monolith reverts with none — observable in one place a caller
   can actually reach. ERC-721's receiver check bubbles a non-empty reason verbatim and converts an
   empty one to `ERC721InvalidReceiver`, so sending an agent to the token's own address (always a
   mistake, always a revert, no state touched either way) reports a different error on each build.
   `test/Diamond.test.ts` pins both so this stays a known fact rather than an integration surprise.

```
23,971 B   monolith, 605 to spare
15,758 B   largest facet, 8,818 to spare — and a fifth facet costs nothing
```

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

So the wall was removed rather than pushed back: the token also ships as an **immutable diamond**
(Layer 1b), EIP-2535 facets wired in the constructor with no `diamondCut` at all. That buys
unlimited code while keeping the property that matters here — nobody can rewrite an agent's rules
after the fact. It costs one `DELEGATECALL` and a selector lookup per call, and demands ERC-7201
storage discipline. **ERC-7656 Generalized Contract-Linked Services** (Final) is the lighter form
of the same idea and remains the right next move for the brain-commitment and lifecycle services.

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
