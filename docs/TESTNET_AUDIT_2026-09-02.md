# Testnet and adversarial review — 2026-09-02

This is an incremental, evidence-backed review, not a formal audit and not a production-readiness
certification. The disclosed signer must be treated as a compromised testnet-only burner.

## Executed checks

- Both the monolith and immutable-diamond suites passed: 261 tests per implementation, 522 test
  executions in total.
- The Base Sepolia multi-owner town ran again against the deployment at
  `0xb3d92c766e3cb356db381feb21958a9ebb974365`: three independent wallets minted agents #15–#17,
  deployed their ERC-6551 accounts, bonded 500 aUSD each, and completed a circular paid conversation.
- The run mined 33 successful transactions and 12 expected hostile reverts. Each resident was unable
  to steal another resident's NFT, rewrite its manifest, operate its account, or unbond its collateral.
  Complete transaction evidence is in `townRun.evidence` in the signer-scoped Base deployment record.
- The town runner is now network-parameterized and verifies the RPC chain id and deployment signer
  before spending. It can exercise the existing signer-scoped deployment on any configured HTTP
  network rather than silently hard-coding Base Sepolia.

## Confirmed fixes from this review

Two additional adversarial findings were fixed in the current follow-up:

- `AnimaRoles` no longer permits an owner or approved operator to overwrite a live irrevocable
  role, which had allowed the promised recipient to be replaced before the grant expired.
- Expired and ownership-stale `AgentHandles` claims no longer squat a handle forever. Reverse
  lookup now suppresses stale claims, and another agent can atomically reclaim the handle.

`AgentSwapRouter` previously refunded its entire input-token balance to the next successful caller.
An accidental transfer or old venue residue could therefore become the next agent's windfall. The
router now snapshots its pre-call input balance and refunds only input attributable to the current
swap. A regression pre-seeds the router and proves the balance is not gifted, against both token
implementations.

## Current network balances and execution boundary

The burner had native test funds on Unichain Sepolia, Robinhood testnet, BSC testnet, Base Sepolia,
and Ethereum Sepolia at preflight time. The initial pass broadcast only the Base town; the subsequent
twelve-wallet campaign below exercised all five funded deployments. Claiming that every function was
exercised on every chain would still be false: several longer scripts are Base-specific, cross-chain
execution needs explicit production DVN/executor configuration, and real DEX/perpetual adapters are
not present.

## Production blockers and recommendations

1. The disclosed private key is compromised by disclosure. Never use it for production roles,
   treasuries, meaningful assets, or a deployment intended to graduate to production.
2. LayerZero escrow still has no replay-safe recovery state machine for accepted but permanently
   undelivered packets. Do not resend the recorded Unichain packet; continue monitoring its GUID.
3. Explicit validation requests accept already-expired deadlines.
4. The quorum verifier should reject zero attesters/measurements and needs constructor, threshold,
   EOA/ERC-1271, revocation, replay, and malformed-proof coverage.
5. ERC-4337 needs real EntryPoint tests and differential fuzzing of its duplicated calldata/memory
   authorization paths.
6. The 29 production-tree dependency findings were removed by deleting the unused LayerZero npm
   packages. ANIMA already uses a minimal local endpoint ABI and imported no LayerZero implementation;
   the packages contributed only an unused peer/tooling tree. CI now blocks high-severity production
   dependency findings with `npm run audit:prod`. The full development-tree audit still reports
   advisories in compiler and Hardhat verification tooling; see `docs/DEPENDENCY_SECURITY.md`.
7. Add invariant/stateful fuzzing, static analysis, RPC quorum/reorg/nonce chaos, sustained load,
   bytecode/config drift checks, atomic evidence journals, and per-chain gas/balance budgets.

## Human-facing features worth implementing

- Packet status plus governed recovery, with DVN/executor/peer drift alerts.
- A bridge preflight that inventories native, ERC-20, and ERC-721 assets in the bound account.
- Allowance and stranded-token dashboards.
- An order simulator showing account-state, brain-root/epoch, and bond pins before signing.
- Guardian emergency controls, multi-chain explorer links, and reproducible signed audit exports.

## Twelve-wallet multi-chain live run — 2026-09-03

At the owner's explicit request, the disclosed testnet-only burner was used for a larger live
exercise. It remains compromised and must never be reused for production or valuable assets.
The runner now creates twelve independently keyed residents, checkpoints every receipt, resumes
resident setup from its journal, sequences nonces locally across lagging public RPC backends, and
funds each resident for the full explicit-gas adversarial path.

Completed live runs:

- Base Sepolia (`84532`): twelve residents minted twelve agents, deployed their ERC-6551 wallets,
  bonded collateral, formed a circular paid-message network, and mined 48 expected authorization
  reverts. The journal contains 130 successful receipts and 48 expected-revert receipts; the two
  initial funding receipts from the pre-resume attempt are also mined but predate the final journal.
- Unichain Sepolia (`1301`): 132 successful receipts and 48 expected-revert receipts.
- BSC Testnet (`97`): 132 successful receipts and 48 expected-revert receipts.
- Robinhood Testnet (`46630`): the completed journal includes 213 successful receipts and 48
  expected-revert receipts because RPC nonce/receipt faults forced resumptions that intentionally
  repeated safe setup and messaging operations.
- Ethereum Sepolia (`11155111`): 144 successful receipts and 48 expected-revert receipts. The
  success count includes the initial funding attempt plus gas top-ups before the complete scenario.

Across the five completed chains, 60 independent wallets minted 60 agents and the committed journals
contain 751 successful receipts plus 240 expected-revert receipts (991 receipts total).

For every resident, the hostile transaction set attempted unauthorized NFT transfer, manifest
replacement, ERC-6551 account execution, and bond withdrawal. A mined status-0 receipt is required
for each expected failure. Deployment records contain labels and transaction hashes for independent
RPC/explorer verification. These campaigns establish the exercised live surface only; they do not
turn this repository into a formal audit or eliminate the production blockers above.
