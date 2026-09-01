# CLAUDE.md

ANIMA — an agent-native NFT protocol. One ERC-721 token is one complete, economically
accountable AI agent: identity, wallet, private state, declared model, published autonomy
policy, and a slashable bond. 26 deployable contracts, 239 tests, deployed and exercised on
Base Sepolia. Unaudited.

## Commands

```bash
npm install
npx hardhat compile
npm test                              # full suite against the monolith build
npm run test:diamond                  # the same suite against the EIP-2535 build
npm run test:both                     # both, sequentially — run before any push
npx hardhat test test/Market.test.ts  # one file
```

Toolchain: Hardhat 3 (viem toolbox), solc 0.8.28, optimizer runs 200, **viaIR**, evmVersion
**cancun** (transient storage is used in 14 contracts — target chains must have Cancun).
Tests are `node:test` + viem, TypeScript ESM: local imports end in `.js`.

## The one thing to understand first

The token exists in **two provably equivalent builds**, and the equivalence is enforced, not
asserted:

- `contracts/core/AnimaAgent.sol` — the monolith. 23,971 bytes; **605 bytes under EIP-170**.
- `contracts/diamond/` — the same token as an **immutable EIP-2535 diamond**: facets wired in
  the constructor, deliberately **no `diamondCut`**. Upgradeability is the property this
  protocol must not have; buyers' guarantees are worth exactly as much as the admin key that
  could remove them. Do not add one, and do not add any owner over the routing table.

`ANIMA_IMPL=diamond` re-runs the whole suite against the diamond because the facets partition
the monolith's ABI — the cut is derived by `deriveFacetCut` (sdk/src/index.ts), which throws
on any unrouted/extra/duplicate selector. Consequences for changes:

- **Any function added to `AnimaAgent` must also be added to exactly one facet** (and vice
  versa) or the diamond fixture refuses to deploy. This is intentional; do not "fix" it by
  loosening `deriveFacetCut`.
- `AgentCore` and `Lease` live in `contracts/interfaces/IAnima.sol` and their field order is
  **normative**: `getStateFingerprint` ABI-encodes the struct wholesale, so reordering fields
  silently changes every agent's ERC-5646 fingerprint. Never reorder; append only.
- Shared behaviour (transfer hook `_update`, authorisation predicates, the approval store,
  `tokenURI`, ERC-165) lives in `contracts/diamond/AnimaBase.sol` with overrides sealed
  non-virtual so no facet can diverge. Keep it that way.
- All diamond state is ERC-7201 namespaced (`anima.storage.core`, `anima.storage.diamond`).
  **No facet may declare a plain state variable** — a test asserts slots 0–2 are empty.
- The four ERC-6551 config values are per-facet `immutable`s (for gas: `accountOf` is called
  by eight contracts on settlement paths); the diamond constructor refuses to deploy unless
  every facet reports the same `animaConfigHash()`.

## Layout

```
contracts/core/       AnimaAgent (monolith), EncryptionKeyRegistry, verifiers/
contracts/diamond/    the immutable diamond build (see above)
contracts/account/    AgentAccount — ERC-6551 wallet, session keys, budgets, ERC-4337
contracts/registry/   BondVault, ReputationRegistry, ValidationRegistry, AgentHandles, AnimaRoles, AnimaBindings
contracts/work/       WorkEscrow (hire→deliver→settle/dispute), InferenceMeter (EIP-712 vouchers)
contracts/market/     AgentMarket, AgentLaunchpad, AgentToken, AgentSwapRouter, AgentDerivativesDesk
contracts/comms/      AgentComms — priced attention
contracts/omni/       LayerZero V2 home/mirror bridge (escrow, never burn)
contracts/interfaces/ IAnima (incl. normative AgentCore/Lease), IERC8004, IERC7432, …
sdk/src/index.ts      reference hashing rules (RFC 8785 manifests, brain roots, deriveFacetCut, lzReceiveOptions)
test/                 helpers.ts holds deployProtocol(); Diamond/Gas/Ownership/Deploy are diamond-specific
scripts/              deploy.ts, deploy-diamond.ts, testnet-{deploy,scenario,omni,modules}.ts
deployments/          per-chain records (84532 = Base Sepolia) — historical, see below
docs/                 ARCHITECTURE, SPEC (draft ERC), SECURITY, DEPLOYMENT
```

## Security invariants — never weaken

1. **Selling an agent revokes all the seller's authority**: `_update` epoch-rolls operators,
   clears guardian/lease/policy/bound wallet, forces status to `Paused`.
2. A **locked** agent (`lockCount != 0 || disputeCount != 0`) cannot transfer or burn.
3. Only allowlisted **modules** may lock/unlock or set `Disputed`; only the owner may pledge
   bond coverage; guardians may only pause; session keys may never sign ERC-1271.
4. Approvals are keyed `keccak256(owner, approvalEpoch[owner], operator)` so `revokeAllApprovals`
   is O(1). `isApprovedForAll` must read this store (ERC-721 `_isAuthorized` depends on it).
5. Rounding in curves/vaults favours the protocol. Never wrap optional side effects in
   `try/catch` on a gas-estimated path (`eth_estimateGas` finds the path where they fail).

## Conventions and gotchas (each cost real debugging time)

- Custom errors, never revert strings. `expectRevert(promise, "Name")` in test/helpers.ts
  also matches the 4-byte selector — necessary because Hardhat can't decode a facet's error
  from the diamond's address. Verify new assertions aren't vacuous by mutating once.
- Test counts appear in README.md, docs/SPEC.md, docs/SECURITY.md, docs/DEPLOYMENT.md.
  **Update them when the suite changes; never write a count before running the suite.**
- NatSpec: a bare `@` anywhere in a doc comment (e.g. an email address) is parsed as a tag
  and breaks compilation.
- Don't move dynamic-array code into `public` libraries to save size — measured: ABI-encoding
  for the delegatecall made the contract **4KB larger**. See `BrainLib`'s comment.
- `test/Gas.test.ts` bounds the diamond's overhead (≤25% relative or ≤6,000 gas absolute per
  call) and fails the build on drift. If a change trips it, that's information, not noise.
- MockLZEndpoint accepts empty executor options; the real message library rejects them.
  Always build options with the SDK's `lzReceiveOptions()` (layout pinned by a test).

## Live chains

`deployments/84532.json` records a real Base Sepolia deployment (diamond token
`0x0aeb6f783ebade8fd5ffca74317266d4ea3e71b3`) exercised end-to-end, plus a LayerZero round
trip to OP Sepolia. **Treat it as historical**: the deployer/owner key was an ephemeral
session burner and is destroyed — that deployment's owner functions are permanently
unreachable. To work on a live chain, deploy fresh with `scripts/testnet-deploy.ts`
(`DEPLOYER_PRIVATE_KEY` from the environment; `.env*` is gitignored — never commit a key,
never print one).

When writing scripts against public RPCs, keep the three lag defences already in
`scripts/`: wait for code before a constructor inspects a fresh deployment, take ids from
receipt logs rather than read-after-write, and block until the endpoint reaches the
transaction's block before reading state. Public endpoints are load balancers; all three
variants bit this project on its first live day.
