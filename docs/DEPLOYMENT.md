# Deploying ANIMA

```bash
npm install
npx hardhat build
npx hardhat test          # 261 tests — do not deploy on a red suite
npm run test:diamond      # the same 261 against the EIP-2535 build
```

## Order and why it matters

1. **`AgentAccount` implementation** — needed before the token, which derives account addresses
   from it. Its `ENTRY_POINT` is immutable and shared by every ERC-1167 clone, so choosing it is
   a one-way decision; pass `address(0)` to disable the ERC-4337 path entirely.
2. **`EncryptionKeyRegistry`** — one per chain, shared across every ANIMA collection. If one
   already exists on your chain, reuse it: a key belongs to a person, not to a collection.
3. **A verifier.** Start with `NullTransferVerifier`, which honestly reports `Committed`.
   Deploy `AttesterQuorumVerifier` only when a real attester set and an approved enclave
   measurement exist — pointing at it earlier would advertise `SealedTEE` for a guarantee nobody
   is providing.
4. **The token** — either `AnimaAgent` (one contract) or `AnimaDiamond` (EIP-2535 facets). See
   below; everything downstream takes the token's address and does not care which you chose.
5. **Accountability**: `BondVault`, `ReputationRegistry`, `ValidationRegistry`, `WorkEscrow`.
6. **Markets and reach**, including `RevenueRouter` after its settlement asset and bond vault exist.
7. **Wiring.**

## Choosing a build

Both builds present the same ABI and the same behaviour; `test/Diamond.test.ts` asserts they
produce identical ERC-5646 fingerprints for an identically-lived agent.

**Deploy `AnimaAgent`** unless you have a reason not to. One address, one verification, no
`DELEGATECALL` on the hot path, and 605 bytes of headroom.

**Deploy `AnimaDiamond`** when you intend to add to the token. Run the script — do not transcribe
it:

```bash
npx hardhat run scripts/deploy-diamond.ts --network <name>
```

It deploys the four facets and the initialiser against one shared `AnimaConfig`, derives the cut
from `AnimaAgent`'s ABI with the SDK's `deriveFacetCut` (which throws rather than returning a
partial cut), deploys the diamond, and then verifies the result on chain before returning: every
one of the 83 declared selectors resolves to a facet, no selector resolves to `diamondCut`, the
loupe reports exactly the four facets deployed, each facet's code matches what this repo compiles
(modulo its immutables) and holds the configuration that was requested, initialisation took
effect, and ERC-165 answers correctly. Any failure aborts with `do NOT publish this address`.

`test/Deploy.test.ts` runs that script for real on every `npm test`, so the worked example cannot
rot into something that no longer works.

Three things the script cannot check for you, printed at the end of its run:

1. Each facet is source-verified on the explorer, and its verified source is this repository.
   **Verify the initialiser too, not only the facets.** It is reached by `delegatecall` from the
   constructor, so while it runs it can write any storage in the diamond. `AnimaDiamond` re-reads
   the routing table afterwards and reverts `RoutingTampered` if any emitted selector was
   repointed — which makes the `DiamondCut` event true for what it names — but nothing on-chain
   can stop a hostile initialiser from adding a selector the cut never mentioned, because the
   deployer is the one who chooses it. `AnimaInit` is the only initialiser this repository ships.
2. `facetAddress(0x1f931c1c)` returns the zero address, queried from a node you trust rather than
   from the deployment's own output.
3. The ERC-6551 registry is the canonical one for the chain.

There is no step 5. There is no `diamondCut`, so the wiring you deploy is the wiring forever —
which is the point.

## Known addresses, as of August 2026

Verify these against a block explorer before using them; they are recorded here because getting
them wrong is silent rather than loud.

| What | Address | Note |
|---|---|---|
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | Same on every EVM chain (Nick's factory). ERC-6551 itself is **Review**, not Final, despite near-universal claims otherwise. |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Live on ~20 mainnets. The EIP is Draft; deployment does not imply Final, and the interface has churned. |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | Same footprint. |
| ERC-8004 ValidationRegistry | — | **No confirmed mainnet deployment.** Do not architect around it as an existing dependency; ANIMA ships its own. |
| ERC-4337 EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895Ce9E3b5Ff108` | The widely-deployed one. |
| ERC-4337 EntryPoint v0.9 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` | ABI-compatible with v0.7/v0.8. |

`AnimaBindings` targets the canonical ERC-8004 IdentityRegistry above, so an ANIMA token can act
as the master NFT for a registration in the singleton every indexer already reads.

## The ERC-6551 registry

The canonical registry is at `0x000000006551c19487814612e58FE06813775758` on every EVM chain,
deployed through Nick's factory. The deploy script uses it when it finds code there and falls
back to deploying its own on a fresh local chain. **Never point production at the fallback** —
the whole value of the canonical address is that an agent's account resolves identically
everywhere.

## Wiring is the security-critical step

```solidity
anima.setModule(escrow, true);        // may lock agents and set them Disputed
anima.setModule(market, true);        // may lock agents and set ERC-4907 users
bonds.setModule(escrow, true);        // may reserve and release collateral
bonds.setArbiter(escrow, true);       // may TAKE collateral
reputation.setSettlementModule(escrow, true);  // may mark feedback as customer-attested
```

`setArbiter` grants the power to move other people's collateral to an address of the arbiter's
choosing. Grant it only to contracts you deployed and read.

## Settlement asset

Bonds, escrow, metering and launches all denominate in **one ERC-20**, chosen at deployment.
Native currency is deliberately unsupported: it would mean a payable surface on contracts that
hold other people's collateral, and every chain has a wrapped equivalent. Use a stablecoin
unless you want an agent's coverage to move with the market.

## After deployment

- **Set an explicit LayerZero DVN and executor configuration.** LayerZero's security lives in
  that configuration, not in this repository. Defaults are a choice, and not one you made.
- **Deploy `OmniAgentMirror` per destination chain and `setPeer` in both directions.** A
  one-directional peering silently fails closed on the return leg.
- **Set `liquidityDeployer` on `AgentLaunchpad`** or no launch can ever graduate.
- **Hand ownership to a multisig or timelock.** Every contract uses `Ownable2Step`, so the new
  owner must accept — a typo cannot brick governance.
- **Verify sources on the explorer.** An agent protocol whose rules cannot be read is asking for
  trust it has not earned.

## Fee ceilings

Governance cannot exceed these, by construction:

| Contract | Ceiling |
|---|---|
| `WorkEscrow` | 10% |
| `AgentMarket` | 5% |
| `AgentLaunchpad` | 3% total across protocol + treasury + agent legs |

## Parameters worth thinking about

| Parameter | Consideration |
|---|---|
| `BondVault.UNBONDING_PERIOD` | MUST exceed the longest dispute window of any module reserving against the vault, or an agent can outwait its own accountability. Immutable. |
| `InferenceMeter.CHALLENGE_WINDOW` | MUST exceed an agent's settlement batching interval, or honest work goes unpaid. Immutable. |
| `WorkEscrow` review window | Bounded 1 hour – 30 days per job by the client. |
| Launch `fairWindow` | Capped at 24 hours. Raises a sniper's cost; does not defeat a funded sybil. |
| `ACCOUNT_SALT` | Changing it changes every agent's account address. Keep it zero unless you have a reason. |
