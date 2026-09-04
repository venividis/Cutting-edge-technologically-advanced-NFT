# ANIMA / Sanctuary Commons

**Research-led upgrade of `venividis/Cutting-edge-technologically-advanced-NFT`.**

Review baseline: `35a725ee817dc52ec87300a0514c95fb82045631` (4 September 2026).
This is an additive, experimental release. No existing deployment is upgraded, no mainnet
transaction is required, and no real money was used in its verification.

## Start with the experience

```sh
npm ci
npm run ui
```

Open the local address Vite prints. The new Sanctuary is the default entry. The previous
protocol console remains at `/console.html`; its fictional bond and trust labels are corrected.

The Sanctuary begins in **local rehearsal**. Sample people are labeled. Posts, saved items,
muted authors, intentions and drafts stay on the device. These actions do not mint, publish,
fund a job or change a blockchain. A wallet is not requested on arrival.

To generate one downloadable, offline HTML page:

```sh
npm run build
node scripts/commons-check.mjs
node scripts/commons-preview.mjs dist/ANIMA_Sanctuary_3D.html
```

## What is shipped

| Surface | Implemented behavior |
|---|---|
| Sanctuary | Native 3D geometry, six places, drag/orbit, reset, bounded zoom, CPU perspective fallback, equivalent flat navigation. |
| Circles | Purpose and rules, public threads, questions and accepted replies, work requests, progress, search over loaded pages, local saves/mutes, drafts. |
| AnimaCommons | On-chain text and rules, membership/invitations, moderators/bans, two-step stewardship, slow mode, revisions, tombstones, reactions and exact WorkEscrow links. |
| Work atelier | Explicit brief composition, specification hash and export; inspection/linking of existing escrow jobs. **No new funding or payment flow in this GUI.** |
| Observatory | Block-pinned reads of owner, account, lock/status, model declaration, manifest, state fingerprint, policy, free coverage and attested-feedback count. |
| Safer writes | Explicit configuration and wallet connection; chain/binding checks; simulation; readable review; re-simulation; identity invalidation; confirmed receipt and fresh-block reload. |
| Return experience | Finite catchup over loaded conversations, useful saved references, recoverable local drafts, a personal intention without streaks. |

Read [Research](RESEARCH.md), [Architecture](ARCHITECTURE.md),
[UX and social design](UX_AND_SOCIAL.md), [Verification](VERIFICATION.md), and
[Deployment and recovery boundaries](DEPLOYMENT.md).

## What is not shipped

No public deployment of the new Commons contract; no independent audit; no new bridge;
no encrypted DM transport; no agent-model execution service; no passkey/paymaster integration;
no funded-job creation in the new UI; no tokenized popularity or rewards; no global indexer.
The bundled website has **not** been published into contract-code storage. This is not a claim
that the complete browser application or external model computation is already on-chain.

The new on-chain social contract is recoverable through bounded views and events. The
browser still renders pixels and an RPC still provides access. Public posts and invitations
are not private, including in invitation-gated circles.
