# Security model

Unaudited. 119 tests and an adversarial review pass are not an audit.

## Invariants

Each is enforced in code and covered by a test.

### Token

1. **Operator authorisations do not survive a transfer.** `_update` increments `operatorEpoch`,
   invalidating every authorisation the seller granted in one write.
2. **A locked agent cannot be transferred or burned.** Enforced in `_update`, not merely reported
   by `locked()` / `isTransferable()` — both of those are descriptive and stop nothing.
3. **A transfer pauses the agent and zeroes its policy, guardian, lease and bound wallet.**
4. **`brainEpoch` is strictly increasing**, and `updateBrain` reverts on a stale expected epoch.
5. **`SealPolicy` can only be strengthened by a verifier**, never by an owner's assertion.
6. **A sealed transfer requires a published recipient key**, or the buyer receives ciphertext
   nobody can open.
7. **Wallet binding requires a signature from the wallet**, so an agent cannot claim an address
   it does not control and inherit its standing.
8. **A guardian can only pause.**

### Account

9. **The owner is never rate-limited**; session keys always are.
10. **Session keys cannot produce ERC-1271 signatures.**
11. **A paused or disputed agent cannot spend from a session key.**
12. **`state()` increments on every state-changing call**, so a buyer can detect a drain.
13. **The audit root is append-only and reproducible off-chain** from public event data.
14. **An account owned by its own token has no owner** — no self-authorising loop.

### Bond and escrow

15. `total >= reserved + unbonding` at all times.
16. **Collateral queued for withdrawal stays slashable** for the full cooldown.
17. **Slashing consumes free collateral before another client's reserved coverage.**
18. **A queued withdrawal pays whoever queued it**, not whoever holds the agent when it matures.
19. **Coverage is reserved, not merely counted** — one bond cannot back two jobs.
20. **Every escrow wait has a timeout with a default winner**, so neither side profits from
    silence.
21. **Release and slash are clamped to what the vault actually holds**, so an earlier slash on
    another job can never strand a later settlement.

### Markets

22. **Curve rounding always favours the pool.** A curve that rounds toward the trader can be
    drained a wei at a time by a loop.
23. **`AgentToken` has no mint function**, so the redemption floor cannot be diluted.
24. **Treasury is tracked explicitly**, not read from `balanceOf` — a donation cannot silently
    move the floor.
25. **Redemption is neutral for remaining holders**: floor per token never decreases.
26. **Swap output is verified by balance delta**, never by the venue's return value.
27. **Approvals are zeroed in the same transaction** they are granted.

### Cross-chain

28. **Inbound messages require both** `msg.sender == endpoint` **and** a registered peer match.
    A zero peer is never trusted, so an unconfigured route fails closed.
29. **Only an agent this contract sent out may return, and only from the chain it went to.**
30. **A busy agent cannot bridge.**

## Attack classes considered

| Class | Mitigation |
|---|---|
| ERC-721 reentrancy via `onERC721Received` | `ReentrancyGuardTransient` + CEI; `_safeTransfer` is the last step of `transferWithBrain` |
| Signature replay | EIP-712 with chainId and verifying contract; per-agent nonces for wallet binding; per-order hash consumption; monotonic cumulative vouchers |
| Approval phishing / dangling approvals | router zeroes its own approvals; the account's target allowlist is per (target, selector) |
| ERC-6551 state desync ("buy a drained agent") | `state()` bumped on every call; market orders pin `expectedAccountState` |
| Ownership cycles | `owner()` returns zero when the account holds its own token |
| Launchpad sniping | fair window with a per-address cap — raises a sniper's cost, does not defeat a funded sybil |
| Bridge payload forgery | endpoint + peer authentication; `awayOn` bookkeeping rejects a return for an agent that never left |
| Reputation sybil | attested feedback requires a settled escrow and is weighted by value at stake |
| Escrow griefing (either side) | timers with default winners in both directions |
| Agent impersonation | `AgentComms` verifies control of `fromAgentId`; allowlists key on agent id, not address |
| Malicious pluggable (verifier, venue, liquidity deployer) | governance-set and reentrancy-guarded; swap output verified independently |
| Gas-estimation side-effect loss | no `try/catch` on gas-estimated paths — see below |

## Findings from building this

Two bugs the test suite caught that are worth recording, because both are easy to reproduce in
other codebases.

**`try/catch` loses optional side effects under gas estimation.** Filing attested feedback was
wrapped in `try/catch` so a failing reputation write could never brick a settlement — sound in
principle. But `eth_estimateGas` binary-searches for the *cheapest* gas at which the transaction
succeeds, and with a swallowing catch the cheapest success is the one where the inner call runs
out of gas and the side effect is skipped. Every wallet-estimated settlement would silently have
lost its reputation record with nothing looking wrong. Replaced with an explicit check of the one
condition the registry rejects.

**Scaled ratios truncate to zero at realistic decimals.** `floorPerToken` computed
`treasury * 1e18 / totalSupply`. With a 6-decimal quote asset against a 1e27 supply the true
value is ~1e-20, so the headline number for the entire redemption mechanism read as "no floor".
Fixed by quoting per whole token via `mulDiv`.

## Deliberate non-goals

- **Royalty enforcement.** ERC-2981's own abstract says payment "must be voluntary", and by 2026
  that is observed reality. The only mechanism that works — ERC-721C plus a transfer validator —
  costs tradeability on Blur and most aggregators and adds a runtime dependency on a contract you
  do not control. ANIMA captures value at chokepoints it controls instead.
- **Making prior plaintext unrecoverable.** Impossible; `SealPolicy` publishes the achieved
  guarantee instead of claiming one.
- **Message delivery guarantees.** That is the transport's job.
- **Defeating a funded sybil at launch.** A permissionless curve cannot.

## Reporting

This is a reference implementation with no deployments. If you are adapting it, get an audit,
and set an explicit LayerZero DVN configuration — leaving it on defaults delegates your security
to whoever the defaults name.
