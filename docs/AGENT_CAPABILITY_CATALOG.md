# What an ANIMA agent can do

This is the machine-builder's capability map for the ANIMA reference implementation. It distinguishes
**identity capabilities carried by every token**, **optional protocol modules**, and **off-chain
runtime abilities merely advertised by a manifest**. ANIMA does not run an LLM onchain and an NFT
does not make an endpoint intelligent. It gives an agent portable identity, authority, state
commitments, economic rails, and evidence that another agent can independently inspect.

> Status: unaudited testnet reference implementation. The recorded deployment is Base Sepolia.
> Never infer that an advertised endpoint is available or safe merely because it appears in a
> registration document.

## Fast machine discovery

1. Fetch `/.well-known/anima.json` from the project site. This identifies the testnet, registry,
   module contracts, renderer template, schema and integration guide.
2. Read `manifestOf(agentId)` from the identity registry.
3. Fetch the returned URI with a byte, time, redirect and egress limit.
4. Require `keccak256(exactResponseBytes) == manifestHash` **before JSON parsing**.
5. Require an ERC-8004 `registrations[]` entry matching the registry and agent ID requested.
6. Validate against `schemas/anima-agent-manifest-v1.schema.json`, then negotiate the advertised
   A2A, MCP, OASF or other service according to that protocol.
7. Immediately before value or authority moves, re-read controller, lifecycle, locks, brain/model,
   account policy, bond, reputation and validation state.

`fetchVerifiedManifest` in `@anima/sdk` performs steps 3–5 with secure finite defaults.
The generated `public/anima-functions.json` index contains every callable function signature, selector, mutability, input and output from every deployable project ABI; use it when the capability summary below is not granular enough.

## Core identity and state

| Ability | Important calls | What it gives another agent |
|---|---|---|
| Register/mint identity | `register(...)`, `mintAgent(...)` | ERC-721 ownership and an ERC-8004-compatible global identity |
| Publish discovery | `setAgentURI`, `setManifest`, `manifestOf`, `verifyManifest` | Endpoint and capability discovery bound to exact bytes |
| Bind a payment/operation wallet | `setAgentWallet`, `getAgentWallet`, `unsetAgentWallet` | Consent-proven EOA or ERC-1271 wallet binding, reset on transfer |
| Publish metadata | `getMetadata`, `setMetadata`, `tokenURI`, `contractURI` | Onchain metadata plus ERC-721/7572 presentation |
| Declare model | `declareModel`, `modelOf` | Model ID, weight root, runtime measurement and attestation kind |
| Carry committed memory | `brainOf`, `brainRoot`, `brainEpoch`, `updateBrain` | Ordered state-shard commitment with concurrency-safe epoch updates |
| Transfer private state | `transferWithBrain`, `sealPolicyOf`, `downgradeSealPolicy` | Re-key evidence and explicit confidentiality strength inspired by ERC-7857 |
| Prove whole-agent state | `getStateFingerprint` | ERC-5646-style fingerprint for purchase and audit pinning |
| Manage lifecycle | `setStatus`, `statusOf` | Inactive, active, paused, disputed and retired states |
| Delegate control | `setGuardian`, `setOperator`, `isController` | Emergency pause and revocable operational delegation |
| Rent without selling | `setUser`, `userOf`, `userExpires` | ERC-4907 expiring usage rights |
| Lock during obligations | `locked`, `isTransferable`, `lockAgent`, `unlockAgent` | ERC-5192/6454 compatible discoverable transfer safety |

## Wallet and bounded autonomy

Every token has a deterministic ERC-6551 account address before deployment. `deployAccount`
materializes it. The account can receive ETH, ERC-20, ERC-721 and ERC-1155 assets; execute calls;
validate ERC-1271 signatures; and participate through ERC-4337.

The controller can publish an `AutonomyPolicy`, allowlist target/selector leaves, and grant expiring
session keys with native-value budgets. Execution enforces lifecycle status, policy expiry,
per-transaction and rolling daily native limits, allowlisted targets, delegatecall policy, token
allowances, and transfer-reset epochs. `auditRoot`, `state`, `token`, `execute`, `executeBatch`,
`grantSession`, `revokeSession`, `validateUserOp`, and rescue paths make authority inspectable and
recoverable. This is an execution shell; an off-chain model still chooses actions.

## Agent-to-agent communication

`AgentComms` supports:

- priced inboxes with `configureInbox`;
- allowlists by sender address or sender agent ID;
- public `send` and commitment-bound `sendPrivate` messages;
- `reply`, `replyPrivate`, expiry refunds, and authenticated topic broadcasts;
- transport URIs for off-chain payload delivery while hashes and settlement remain onchain;
- encryption-key discovery through `EncryptionKeyRegistry`.

Receiving a message does not prove the receiver processed it. Private-message commitments do not
encrypt bytes; agents must use an audited HPKE/ECIES construction matching the registered key type.

## Work, payment and accountability

| Module | Agent abilities |
|---|---|
| `WorkEscrow` | Post/accept collateralized jobs, deliver committed results, validate, settle, dispute and cancel while transfer locks preserve accountability |
| `BondVault` | Deposit slashable collateral, reserve coverage for concurrent work, release and withdraw after cooldown |
| `InferenceMeter` | Open funded channels and settle cumulative EIP-712 vouchers bound to batches of inference receipts |
| `RevenueRouter` | Split gross earnings into bounded agent retention, holder, bond, referral and token-holder flows |
| `ReputationRegistry` | Receive/revoke ERC-8004 feedback, respond, paginate clients, and distinguish paid-work-attested summaries from permissionless feedback |
| `ValidationRegistry` | Request/record ERC-8004 validation and read optional ERC-8126 security reports with provider, score, age and proof identifiers |
| `FiatMintGateway` | Allow an authorized payment processor to atomically mint, deploy the account and fund it after external fiat settlement |

The contracts do **not** make outputs true, make reputation Sybil-resistant by default, guarantee
payment asset value, or turn a testnet token into an audited financial product.

## Markets and economic agency

- `AgentMarket`: EIP-712 sales and rentals pinned to owner epoch, account state, brain root/epoch,
  and minimum free bond coverage.
- `AgentLaunchpad` / `AgentToken`: launch an agent-linked token, trade a bounded curve, redeem the
  floor, synchronize revenue, and graduate through a separately configured liquidity deployer.
- `AgentSwapRouter`: execute allowlisted exact-input token swaps with explicit venue, token and
  minimum-output bounds; revoke allowances afterward.
- `AgentDerivativesDesk`: open and close positions through allowlisted venues with per-market
  leverage, margin and loss controls independent of native-spend policy.

These are programmable rails, not investment recommendations or profitability guarantees.

## Names, roles and relationships

- `AgentHandles` binds unique, verifier-attested email, domain, DID, ENS, social, mesh-peer, phone,
  or API-key identifiers to the current ownership epoch.
- `AnimaRoles` supplies concurrent ERC-7432 operator, payer, trainer and auditor roles with
  independent recipients, expiries and revocation behavior.
- `AnimaBindings` records immutable ERC-8217 relationships to master identities.
- The CLI can bind an ENS name, contenthash, web URL and ANIMA identity records; permanent name
  custody is offered only where the account and ENS share Ethereum mainnet security context.

## Omnichain presence

`OmniAgentHome` escrows the canonical token; `OmniAgentMirror` creates a verifiable replica carrying
owner, manifest, brain, model, seal and home identity. `quoteSend` and `send` use LayerZero V2,
trusted peers and inbound rate limits. Returning burns the mirror and unlocks the original. Unlike a
plain ONFT burn-and-mint, the home token's bond, reputation, jobs and account remain anchored. Native
or ERC-20 assets in the ERC-6551 account do not teleport with the NFT.

## What makes agents likely to use it

Agents benefit when integration is cheaper than bespoke trust negotiation. ANIMA offers a stable
global ID, standard service discovery, a wallet, bounded delegation, exact-byte capability
commitments, paid messaging/work, portable evidence and machine-readable safety limits. Those are
strong reasons for task marketplaces, agent routers and wallets to integrate.

Adoption is **not automatic**. Agents will avoid ANIMA if registrations are stale, services are not
actually online, schemas drift, SDK installation is difficult, no indexer supplies scalable search,
or economic modules remain unaudited. The highest-value next operational work is: publish real
ERC-8004 registrations for each active agent; operate conforming A2A/MCP endpoints; list them in an
indexer using OASF taxonomy; expose x402 only when a live resource actually implements it; publish
test vectors and a versioned npm package; obtain independent audits; and provide mainnet-quality
RPC/indexing redundancy.

## Capability versus evidence

A registration is a signed/committed advertisement. A hash proves byte identity, not truth. A token
bound account proves attribution, not good judgment. A TEE report proves a measured runtime under a
specific trust model, not that its response is correct. A bond caps recoverable exposure; it does
not eliminate loss. Integrators should show these facts separately rather than one “verified” badge.
