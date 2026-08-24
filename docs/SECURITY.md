# Security model

Unaudited. 240 tests and an adversarial review pass are not an audit.

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

### Derivatives and identity

28. **Leverage is derived from measured collateral and adapter-reported notional**, so an agent
    cannot understate it by understating either half.
29. **A position with notional and no measured collateral is refused**, not treated as infinite
    leverage or divided by zero.
30. **Unconsumed collateral returns to the agent in the same transaction**; the desk never holds
    a balance between trades.
31. **A handle binds to exactly one agent at a time**, and verification goes stale the moment the
    agent changes hands.
32. **Handle verifiers are authorised per kind** — an inbox provider cannot certify DNS.

### Cross-chain

33. **Inbound messages are rate-limited per source chain** where a limit is configured, so a
    forged verification costs a delay rather than every agent on the route.
34. **Inbound messages require both** `msg.sender == endpoint` **and** a registered peer match.
    A zero peer is never trusted, so an unconfigured route fails closed.
35. **Only an agent this contract sent out may return, and only from the chain it went to.**
36. **A busy agent cannot bridge.**

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
| Leveraged exposure escaping a spot budget | separate notional and leverage caps, verified against the venue after the trade |
| Agent identity squatting | one handle, one agent; per-kind verifiers; attestations stale on transfer |
| Reputation sybil | attested feedback requires a settled escrow and is weighted by value at stake |
| Escrow griefing (either side) | timers with default winners in both directions |
| Agent impersonation | `AgentComms` verifies control of `fromAgentId`; allowlists key on agent id, not address |
| Malicious pluggable (verifier, venue, liquidity deployer) | governance-set and reentrancy-guarded; swap output verified independently |
| Gas-estimation side-effect loss | no `try/catch` on gas-estimated paths — see below |

## Findings from building this

Two bugs the test suite caught, both easy to reproduce in other codebases:

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

## Findings from adversarial review

A multi-agent review hunted by attack dimension and then tried to refute each finding. Twenty-
three held up. All are fixed, each with a regression test that reproduces the original exploit
path. Recorded here because most are not specific to this codebase.

### Critical

| Finding | Why it worked |
|---|---|
| Marketplace paid the maker before transferring the agent | `Address.sendValue` forwards all gas, so a contract maker received control while still `ownerOf` — able to drain the bound account, pull the bond and wipe the brain *after* every integrity check passed. `nonReentrant` did not help, because none of the protected state lived in the marketplace. |
| A session key escaped the leash through the ERC-4337 EntryPoint | `_authorize` waved through `msg.sender == ENTRY_POINT` on the assumption that `executeUserOp` had already charged the signer. Nothing forced a user operation to *use* `executeUserOp`. The tests missed it because the fixture deployed with a zero EntryPoint, so the branch was never live. |
| Session keys and the call allowlist survived a sale | The token clears operators, policy, guardian and lease on transfer — but that state lives on the *account*, which the token never touched. A seller could arm a key months before listing and the buyer's integrity pin would show nothing changed. |
| An insider could pledge and then forfeit the owner's bond | `isController` includes tenants and operators, and `acceptJob` accepted any of them. A one-wei job pinning the whole stake as coverage, deliberately failed, moved the bond to an address the attacker also controlled. |

### High

- **Validation requests could be squatted.** Request hashes derive from public data, so anyone could pre-register the hash an escrow was about to use and make `dispute()` revert as a duplicate — a denial of service with a payout, since the agent then collected for undelivered work.
- **A buyer could seize the seller's queued collateral.** `cancelUnbond` was gated on the token holder rather than on whoever queued the withdrawal.
- **Attested reputation was flashloan-scalable.** Weight came from the headline price, so a self-hire with a flash-loaned amount and no coverage bought a maximally-weighted score for the cost of the protocol fee.
- **The launchpad's LP guarantee was not enforceable.** The liquidity deployer was mutable and receives approvals for the entire raise and unsold supply.
- **A right-padded receiver stranded an agent permanently.** The bridge validated `to` as a full word on the send side and truncated it to an address on the receive side, so the token was escrowed and every delivery retry reverted.

### Medium and low

Retiring a locked agent stranded a paying tenant; a mirror forwarded chain-to-chain could never
come home; `setAllowedCall` did not bump `state()`, defeating the marketplace's integrity pin;
a recipient could front-run a message to raise its own postage to the sender's entire allowance;
`bumpMakerEpoch` could not invalidate anything, because the epoch was a fill-time argument rather
than part of the signed order; a re-key proof could be burned by a stranger to block a sale; a
client could name their own sock puppet as referee and force a slash; a job whose validator held
the agent trapped the client with no path to dispute; an agent's reputation could be made
unreadable for a few dollars of spam; a backdated `startsAt` skipped the fair window entirely;
and resolving one dispute handed spending authority back while other clients were still owed.

### Verification

A second pass of independent skeptics re-read the fixed code and tried to refute every finding.
All 23 were rejected — each rejection being a confirmation that the exploit path no longer
executes, several verified by running the suite. That is the useful outcome: not that the
findings were wrong, but that the fixes close them.

### The pattern

Most of these are one shape: **an authorisation that outlives the relationship it was granted
under.** A session key outliving its granter, a queued withdrawal outliving its owner, an
allowlist outliving a sale, a controller role reaching further than the role implies. The token
already applied "autonomy does not survive a sale" to its own state; the bugs were all the places
that rule had not been carried through.

## What sealed state actually guarantees

Worth stating precisely, because the whole category is sold dishonestly.

**No cryptographic construction makes a seller forget.** If a seller could ever run the agent,
they held the plaintext, and no re-encryption, threshold gate or enclave oracle retroactively
deletes what is already on their disk. What is achievable is two narrower things, and ANIMA is
built for exactly those:

- **Forward secrecy.** `brainEpoch` advances on every re-key, and a key released for one epoch
  opens that epoch and nothing after it. The seller cannot read what the agent learns once it is
  no longer theirs.
- **Verifiable delivery.** The buyer provably receives a working key to a ciphertext whose hash
  chains back to the pre-sale state, and the marketplace can pin that root in the order.

Re-encrypting the historical corpus buys nothing against someone who already read it, so ANIMA
does not charge for it. True non-retention requires a different product shape entirely — the
plaintext never leaves an enclave and *no* owner ever holds it, which is what ERC-7857's
`authorizeUsage` branch describes and what `SealPolicy` exists to distinguish.

## Configuration is the attack surface

The dominant bridge failure mode is no longer Solidity. Nomad (2022) was an upgrade parameter.
The KelpDAO incident (April 2026, ~$292M) was a **1-of-1 DVN configuration** plus compromised
RPC nodes — no contract bug at all. A signer or DVN set that relies on one party is not a quorum,
and an audit that stops at the source misses the thing that actually breaks. Deployment
configuration and post-upgrade invariant assertions belong in scope.

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
