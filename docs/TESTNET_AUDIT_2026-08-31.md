# Testnet and adversarial review — 2026-08-31

This review began before spending the supplied testnet funds and was followed by live deployments and mints after the confirmed defects were fixed. It is not a formal audit
and does not claim the absence of vulnerabilities.

## Requested network readiness

| Network | Chain ID | LayerZero EID | Endpoint V2 | Native balance checked | Deployment result |
|---|---:|---:|---|---:|---|
| Unichain Sepolia | 1301 | 40333 | `0xb8815f3f882614048cbe201a67ef9c6f10fe5035` | 0.09999 ETH | Deployed with an explicitly opted-in local standards-faithful ERC-6551 registry; agent #1 minted |
| Robinhood testnet | 46630 | 40451 | `0x3acaaf60502791d199a5a5f0b173d78229ebfe32` | 0.30998946248 ETH | Protocol deployed; agent #1 minted |
| BSC testnet | 97 | 40102 | `0x6edce65403992e310a62460808c4b910d972f10f` | 2 tBNB | Protocol deployed; agent #1 minted |
| Ethereum Sepolia | 11155111 | 40161 | `0x6edce65403992e310a62460808c4b910d972f10f` | 0.43157603612625556 ETH | Protocol deployed; agent #1 minted |
| Base Sepolia | 84532 | 40245 | `0x6edce65403992e310a62460808c4b910d972f10f` | 0.08 ETH | Fresh deployer-scoped protocol deployed; agent #1 minted |

Endpoint data came from LayerZero's deployment metadata and chain deployment documentation.
The review added all five requested networks to Hardhat and replaced the fixed Base-to-OP runner
with a resumable Base-home star runner for all four requested mirrors. Mirrors deliberately cannot
forward an agent directly to another mirror.

After fixing the confirmed critical paths, fresh deployer-scoped records were used and real transactions were sent. Each network has a live diamond NFT, agent #1, deployed ERC-6551 account, published autonomy policy, active status, and successful account execution. Base Sepolia agents #2, #3, and #5 completed LayerZero round trips to Robinhood, BSC, and Ethereum Sepolia respectively. Agent #4 was escrowed for Unichain and its outbound packet remains pending; it is deliberately resumable and no duplicate send was submitted.

## Fixed in this review

- ERC-4337 session UserOperations now validate the inner `execute` or `executeBatch` selector that
  `executeUserOp` actually dispatches. A successful validation-and-execution regression covers the
  path, in addition to the EntryPoint bypass rejection.
- Derivatives execution now passes through the governance-selected adapter with the checked account
  and market as typed arguments. A mismatch regression proves opaque venue calldata cannot trade a
  different, disallowed market.
- A live revocable ERC-7432 role now prevents permissionless unlocking until the role is revoked.
- A nonzero inbound bridge capacity can no longer be paired with a zero-length window, which reset
  the limiter on every message.

## Remaining production risks

The identity-binding and bond-reservation findings were fixed before the live run. These remaining items still require production design decisions:

1. Cross-chain escrow has no timeout cancellation or recovery route after LayerZero accepts a packet
   that is never delivered. The live script also does not configure an explicit DVN/executor stack.
2. Explicit production DVN/executor configuration and a packet recovery policy remain required even though the live default-path test succeeded on three routes.

## Additional hardening findings

- Explicit validation-request expiry accepts a deadline that is already expired.
- Launchpad fair-window allocation is a per-address throttle and is Sybil-bypassable.
- The swap router can give pre-existing residual input tokens to the next caller.
- A diamond constructor should require every functional facet to report the pinned configuration,
  rather than skipping a facet that does not answer the configuration probe.

## Required next live-test steps

1. Resolve the canonical ERC-6551 registry dependency on Unichain or explicitly choose and document
   a deterministic canonical deployment accepted by wallets and indexers.
2. Configure and verify an explicit production DVN/executor stack instead of relying on defaults.
3. Resume the recorded Unichain outbound packet and diagnose it in LayerZero Scan if it remains
   undelivered; do not mint or send a duplicate journey.
4. Exercise the longer work, dispute, market, roles, handles, and metering scenario on each chain;
   the current live matrix proves deployment, minting, accounts, policy, execution, and bridging.
