# MASTER-NFT-PROJECT integration review — 2026-09-17

## Scope and provenance

The source was cloned directly from `https://github.com/venividis/MASTER-NFT-PROJECT` at commit
`e12e0cd38ed231a0b2015d17fec302a359476de1`. The reviewed surfaces included the current README and
security/capability maps; Solidity account, module, memory, proof, launch, governance, communication,
world, cross-chain and recovery contracts; the portable module SDK; browser module host; agent
runtime; deployment/recovery planners; and their native/browser tests.

MASTER is MIT licensed. ANIMA preserves the original `anima.extension-release/1` and
`anima.host/1` domains where byte compatibility is intentional. Reusing a domain while silently
changing canonicalization would be a protocol break, not a branding improvement.

## What MASTER contains that matters to autonomous agents

### Immutable software packages

MASTER separates software publication, installation, state and execution:

1. `ModuleArchiveFactory` trusts only factory-created immutable readers and records runtime code
   hashes. Stored and expanded SHA-256 values remain client-verified commitments.
2. `ExtensionReleaseRegistry` binds publisher, module ID, version, archive, runtime, host API,
   state schema, sorted capabilities and exact dependency release IDs.
3. `TokenModuleRegistry` lets the canonical NFT account activate or disable a release with stale
   root, state-head and custody-epoch checks.
4. `ModuleStateStore` retains append-only, per-token/per-module branches, including state staged
   before installation and historical state not currently active.
5. `ModuleWorkbench` anchors a bounded recoverable browser document and its service addresses.
6. The SDK packages deterministic archives, verifies dependency graphs, prepares unsigned calls,
   pins reads to a block, bounds every page/response, and records resumable public receipts.

The critical design decision is that installing software creates **no session, allowance or spending
permission**. A module may request `transaction.propose`; the holder still reviews the exact call.

### Exact unattended authority

MASTER's `AgentPolicyGuard` does not grant a worker a generic selector. It binds complete calldata,
target runtime code hash, asset, per-call and remaining budgets, time range, interval, call count,
account epoch, owner and nonce. This closes a real gap in selector-only sessions: two calls to
`transfer(address,uint256)` can have radically different recipients and amounts.

ANIMA now applies the portable portion directly in `AgentAccount.grantScopedSession`: target,
complete calldata hash, target code hash, expected account state, call count, cadence, ownership, lifecycle, target policy,
native per-call/daily/lifetime budgets and account audit/state all have to agree. Ordinary broad
sessions remain available for backwards compatibility and must be deliberately re-granted to clear
a scope.

A runtime code-hash pin detects replacement of an ordinary target contract; it does not detect an
upgrade behind an unchanged proxy or a behavior change driven by mutable storage, an oracle, or an
external dependency. Owners should scope unattended calls to immutable, independently reviewed
targets and keep the call count, cadence, lifetime and value cap as small as practical.

MASTER additionally models ERC-20 asset budgets in its account instrument. ANIMA already isolates
ERC-20 swaps and leveraged trading through `AgentSwapRouter` and `AgentDerivativesDesk`; generic
account sessions still must not be represented as token-amount bounded. A future account version
can add asset-specific exact grants only with balance-delta accounting and fee-on-transfer tests.

### Recovery, privacy and host boundaries

The most reusable non-contract rules are:

- verify full stored and expanded hashes before interpreting bytes;
- reject dependency cycles and place hard limits on depth, release count and expanded bytes;
- keep state migration explicit and separate from code activation;
- pin reads to one block and recheck its hash;
- never overwrite recovery output silently;
- preserve public receipt journals and stop on nonce/reorganization conflicts;
- run untrusted modules without wallet, ambient network, parent DOM, form, popup or top-navigation
  access;
- return transaction proposals to a trusted host for human review;
- describe public, encrypted and hash-only memory honestly;
- treat content hashes as byte identity, not publisher trust or harmlessness.

## What this update imports

| MASTER concept | ANIMA implementation |
|---|---|
| Exact-call agent automation | `AgentAccount.SessionScope`, `grantScopedSession`, scope consumption on direct and ERC-4337 execution |
| Portable release format | Typed `ExtensionManifest`, canonical validation, SHA-256 package identity and bounded dependency resolution in `@anima/sdk` |
| Permission vocabulary | Only `identity.read`, `state.read`, `state.write`, `transaction.propose`, and `journal.propose` are accepted |
| Agent discovery | Optional integrity-bound `anima.extensions[]` entries in the ERC-8004 registration schema |
| Finite graph/resource profile | 16 direct dependencies, 64 releases, depth 16, 16 MiB expanded package, 32 KiB state declaration, 16 KiB manifest |
| Security guidance | Capability catalog and integration guide distinguish installation, execution permission and evidence |

## What is deliberately not copied

- MASTER's collection, account, renderer and Ascension authority cannot replace ANIMA's immutable
  ERC-8004/6551 identity without creating two controllers.
- Its onchain archive/state contracts are not claimed deployed for ANIMA. The SDK format enables
  compatible publication and recovery; a separately reviewed ERC-7656-style service remains the
  right deployment boundary.
- Local worlds, launch protocols, proof systems, shielded routes, MLS service and keeper processes
  require their own operations and trust assumptions. Source presence is not an endpoint.
- Arbitrary HTML cartridges are not loaded into the onchain renderer. A safe host needs a sandbox,
  CSP, byte verification, bounded recovery and explicit wallet review.
- MASTER test results are evidence for its pinned source, not for ANIMA contracts.

## Remaining high-value work

1. Implement and audit an optional module service contract without changing the immutable identity.
2. Publish standalone module SDK vectors and byte-compatible cross-repository fixtures.
3. Build a worker/iframe host with the MASTER permission profile and no ambient authority.
4. Add ERC-20 exact-grant budgets using measured balance deltas rather than nominal amounts.
5. Add block-pinned, reorg-aware recovery for ANIMA audit logs, brains, manifests and modules.
6. Operate real A2A/MCP agents whose service cards reference verified extension releases.
7. Audit the account changes before any mainnet deployment; the existing Base Sepolia account
   implementation is immutable and does not gain new scoped-session functions from repository code.

## Files reviewed in MASTER

Primary implementation evidence included `contracts/src/modules/*`,
`contracts/src/extensions/agents/AgentPolicyGuard.sol`, `packages/modules/*`,
`web/modules/*`, `agent/extensions/*`, `docs/CAPABILITIES.md`, `docs/MODULES-IMPLEMENTATION.md`,
`docs/OWNER-AUTHORITY-AND-RECOVERY.md`, `docs/FORWARD-SECURE-COMMONS.md`,
`docs/CROSSCHAIN.md`, `docs/PRODUCTION-VALIDATION.md`, and the corresponding module, browser and
native tests. This is a source-level integration review, not an independent security audit.
