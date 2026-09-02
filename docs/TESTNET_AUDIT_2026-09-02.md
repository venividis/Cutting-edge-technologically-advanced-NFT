# Testnet and adversarial review — 2026-09-02

This is an incremental, evidence-backed review, not a formal audit and not a production-readiness
certification. The disclosed signer must be treated as a compromised testnet-only burner.

## Executed checks

- Both the monolith and immutable-diamond suites passed: 249 tests per implementation, 498 test
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

## Confirmed fix from this review

`AgentSwapRouter` previously refunded its entire input-token balance to the next successful caller.
An accidental transfer or old venue residue could therefore become the next agent's windfall. The
router now snapshots its pre-call input balance and refunds only input attributable to the current
swap. A regression pre-seeds the router and proves the balance is not gifted, against both token
implementations.

## Current network balances and execution boundary

The burner had native test funds on Unichain Sepolia, Robinhood testnet, BSC testnet, Base Sepolia,
and Ethereum Sepolia at preflight time. Only the Base multi-agent town was broadcast in this pass.
Claiming that every function was exercised on every chain would be false: several longer scripts are
still Base-specific, cross-chain execution needs explicit production DVN/executor configuration, and
real DEX/perpetual adapters are not present.

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
6. The dependency audit currently reports 29 findings (12 low, 1 moderate, 13 high, 3 critical),
   primarily in transitive LayerZero tooling. Reachability and upgrade/override decisions are required.
7. Add invariant/stateful fuzzing, static analysis, RPC quorum/reorg/nonce chaos, sustained load,
   bytecode/config drift checks, atomic evidence journals, and per-chain gas/balance budgets.

## Human-facing features worth implementing

- Packet status plus governed recovery, with DVN/executor/peer drift alerts.
- A bridge preflight that inventories native, ERC-20, and ERC-721 assets in the bound account.
- Allowance and stranded-token dashboards.
- An order simulator showing account-state, brain-root/epoch, and bond pins before signing.
- Guardian emergency controls, multi-chain explorer links, and reproducible signed audit exports.
