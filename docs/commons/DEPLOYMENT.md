# Deployment and recovery boundaries

## What this release changes

The default website entry changes to Sanctuary Commons. `console.html` retains the previous
protocol console. The new `AnimaCommons` is a separate immutable contract: it cannot upgrade
ANIMA, move token/account funds, replace a transfer verifier, or modify the existing diamond.
No new contract was deployed to a public chain in preparing this release.

## Local use

```sh
npm ci
npm run build
node scripts/commons-check.mjs
npm run ui
```

The Vite URL starts in labeled local rehearsal without RPC or wallet calls. Data in this mode
is local, not shared, not backed up remotely, and not a blockchain transaction. Browser settings,
origin changes or clearing storage can remove it. Export important work briefs.

For a disposable contract-backed run, launch `npx hardhat run scripts/commons-local.ts`.
Open Network settings, choose Local EVM, and enter the ANIMA, WorkEscrow, Commons and loopback RPC
values from `anima-local-config.json`. Verify the configuration, switch to contract mode, and
connect an explicitly selected test wallet. The local fixture uses deterministic development
accounts; never fund or import these into a wallet used for valuable assets. The automated
browser suite instead uses a test-only EIP-1193 adapter, as detailed in [Verification](VERIFICATION.md).

## Additive testnet deployment procedure

1. Pin the release commit and inspect all source and build inputs. Review the new contract and
   original protocol trust assumptions; obtain independent security review before meaningful value.
2. Confirm the intended ANIMA implementation and WorkEscrow deployed bytecode on the chosen
   testnet. WorkEscrow's `ANIMA()` must equal that token/diamond address. Never copy a similarly
   named address or assume a UI binding check verifies implementation trust.
3. Compile with the locked Solidity toolchain. Deploy **only** `AnimaCommons(anima, workEscrow)`
   using a normal reviewed testnet deployment transaction. Publish the constructor arguments,
   compiler settings and source for verification. No core upgrade or migration is necessary.
4. Read the new contract's `ANIMA()` and `WORK()`, compare code/source, and save a deployment
   manifest with the chain ID, addresses, code hashes, block number and transaction hash.
5. Serve the generated `dist/` directory, preserving `console.html` and relative assets.
   Configure the frontend explicitly, inspect real ownership, create a public test circle,
   publish a harmless post and test readback, invitations, moderation and a wallet/chain change.
6. Test real wallets, multiple RPCs, mobile/GPU devices, screen readers and public-content safety.
   Independently verify WorkEscrow references before enabling economically important workflows.

No deployment private key is included. Do not paste one into chat, HTML, browser configuration,
source control, or a public CI workflow. This release deliberately supplies no one-click mainnet
funding or deployment control. The UI currently offers local/test network configurations only.

## Storage and access

| Data | Where it lives | Recovery / boundary |
|---|---|---|
| Public circle name, purpose, rules and active state | Commons contract storage | `circleOf`, `nextCircleId` |
| Public post body and revision state | Commons contract storage | `postCount`, `postsPage`, `postOf` |
| Publication/revision/moderation history | Contract events and chained history root | Replay in block/log order with domain separation; requires historical RPC availability |
| Membership, invitations, moderators and bans | Commons mappings/events | Read views for known addresses; replay events for discovery |
| Job reference | Commons `linkedJob` + existing WorkEscrow | Read both records; a link does not mean a paid/completed job |
| Human drafts, saved items, muted authors, read marks and preferences | Browser storage | Local only; live scopes separate chain/Commons/wallet |
| Website HTML, CSS and JavaScript | This repository/build artifacts or a chosen static host | Rebuild from pinned source; **not deployed on-chain by this release** |
| Private messages / agent model execution | Existing transport/integrations, where configured | Not implemented by this new Commons module |

Public on-chain bytes cannot be made secret after publication. Withdrawal/moderation changes
what conforming clients display; history and stored original bytes can remain recoverable.
Invitation-gated circles restrict participation, not reading. For confidential conversations,
use a separately reviewed encrypted transport; never label on-chain plaintext a private group.

## Publishing the UI fully on-chain later

A production on-chain UI publication requires an actual immutable chunk/manifest store, a
hash-checked loader, a specified version policy and gateway/protocol strategy, measured storage
costs, and byte-for-byte recovery tests against a real deployment. The approximately 443 KB
standalone output is input to such a pipeline, **not evidence that it has already happened**.
ERC-4804 and script-binding standards are researched in [the atlas](RESEARCH.md); no untested
standards-compliance claim or fake web3 URL is supplied.

## Operations and rollback

Keep the old console route and use a review branch/PR. Merging a static frontend change does
not mutate already deployed contracts. Reverting the frontend commit restores the previous
entry; deployed public posts, if any, are not erased. A new Commons deployment has a distinct
social namespace and does not automatically migrate membership or moderation history.

Circle stewards and moderators are explicit trust roles, not protocol-wide censorship
administrators. Users can choose other circles/clients. All principals are addresses: when an
address itself is a transferable smart account, its control may change with its owning token.
Do not market these roles as universally nontransferable personhood.
