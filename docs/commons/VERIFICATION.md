# Verification / Sanctuary Commons

Verified locally on 4 September 2026 against upstream
`35a725ee817dc52ec87300a0514c95fb82045631`, with the locked dependency tree.
This report describes executed checks, not an independent audit or a claim of production safety.

## Results

| Check | Executed result |
|---|---:|
| Baseline suite before changes | 273 pass, 1 address-capitalization assertion failure |
| Full suite, AnimaAgent monolith | **322 pass, 0 fail** |
| Full suite, immutable diamond | **322 pass, 0 fail** |
| New Commons contract cases, included in each full suite | **29** |
| Pure model/bridge/geometry cases, included in each full suite | **19** |
| Chromium functional checks | **37 pass, 0 fail** |
| Regenerated frontend ABIs and executable runtime-size checks | Pass |
| Vite multi-entry production build | Pass |
| Standalone HTML generation | Pass |

The full suites share tests: these are **not 644 different security invariants**. The
baseline fix changes a test to compare normalized Ethereum addresses using `getAddress`;
it does not alter `FiatMintGateway`, case-fold arbitrary strings, or weaken an economic assertion.

## Reproduction

```sh
npm ci
npm run test:both
node scripts/commons-check.mjs
npm run ui:build
node scripts/commons-preview.mjs dist/ANIMA_Sanctuary_3D.html
```

The compiler must run before ABI regeneration. `test:both` compiles when needed. CI repeats
both builds and checks that generated ABI signatures have not drifted from the committed file.
The pre-existing `CI` workflow also runs a production dependency audit; it has not been disabled.
An external advisory database is time-dependent, so a past passing test is not an audit result.

### Browser / actual local EVM

In one terminal:

```sh
npx hardhat run scripts/commons-local.ts
```

This starts a disposable loopback EVM on port 18745 and writes `anima-local-config.json`.
It has seeded accounts, test tokens and 22 posts, and is **not a production RPC**. Do not
expose it to the internet or send assets to its deterministic addresses.

In another terminal, with Python Playwright and Chromium installed:

```sh
COMMONS_LOCAL_CONFIG=anima-local-config.json \
COMMONS_TEST_OUTPUT=commons-test-output \
python scripts/commons-browser-check.py dist/ANIMA_Sanctuary_3D.html
```

The runner uses `/usr/bin/chromium`; adjust that executable path for a different platform.
It emits JSON checks, actual local transaction hashes/receipts, and desktop/mobile captures.
This environment prohibited browser navigation to local hosts/files, so the test loads the
bundled application into an **in-memory document**, with explicit test-only localStorage,
fetch and EIP-1193 shims. Contract calls and submitted transactions execute on the actual
Hardhat EVM, not a JavaScript social-contract simulation. The test does **not** establish
compatibility with an extension wallet or a public network.

## Coverage that matters

**Identity and consent:** owner/controller badge authentication; zero/stale fingerprint
rejection; transfer and transfer-back invalidation; independent wallet authorship; invitation
consumption; membership and moderator permission removal on leave/ban; steward protection;
nomination cancellation and two-step acceptance.

**Public conversation integrity:** non-empty bounded content; UTF-8 byte limits; root and
reply validity; slow mode on publication and revision; archive restrictions; author-only
revision/withdrawal; moderator-only visibility with a reason; retained public bytes; history
root advancement; bounded pagination; explicit accepted replies and replaceable reactions.

**Work evidence:** no custody; immutable ANIMA/WorkEscrow wiring; existing job/client/specification
matching; unknown or mismatched job rejection; a linked specification cannot be edited. This
proves a reference to an escrow record, not delivery quality or successful payment.

**Client safety:** literal rendering of untrusted text; no unsolicited initial network or wallet
access; separate local/live state; drafts and saved references; address and uint256 validation;
UTF-8 content limits; exact brief hashing; bounded latest-page reads; stale wallet/chain/configuration
rejection before submission and after asynchronous simulation; transaction review before send;
fresh reads after a confirmed receipt; account-change invalidation.

**Rendering and access:** six native destinations; real geometry/projection assertions;
390-pixel mobile layout; horizontal-overflow checks; tested navigation target dimensions;
keyboard-focus reachability; explicit flat view; persisted reduced-motion setting. Native WebGL
was unavailable in this runner: **the actual CPU perspective-projected 3D path was exercised**.
The WebGL path is implemented and built, but needs real GPU/device coverage. These checks do
not certify complete WCAG conformance or replace screen-reader/usability testing.

## Build constraints and measurements

Pinned/locked versions used: Node 22.16.0; Hardhat 3.14.0; Solidity 0.8.28; Vite 7.3.6;
viem 2.55.19; OpenZeppelin Contracts 5.6.1. Solidity settings: optimizer 200 runs, via IR,
Cancun EVM. The existing transient-reentrancy-guard modules require a compatible EVM.

| Executable contract | Runtime bytes | EIP-170 limit |
|---|---:|---:|
| AnimaCommons | 12,941 | 24,576 |
| AnimaAgent (unchanged) | 23,971 | 24,576 |
| WorkEscrow (unchanged) | 11,346 | 24,576 |
| BondVault (unchanged) | 5,714 | 24,576 |
| ReputationRegistry (unchanged) | 9,159 | 24,576 |

No unlimited-runtime-size override was used. The monolith has only 605 bytes of remaining
runtime headroom, which is a reason to add Commons separately rather than graft social
storage/functions into the token or its existing immutable diamond.

The standalone page is approximately 443 KB uncompressed and embeds its script and style
without external media, fonts, or CDN libraries. The normal Vite build uses split bundles.
Actual gas expenditure and dollar cost depend on data length, network and fee conditions;
no misleading universal cost or throughput figure is asserted.

## Not established by these results

No independent audit, formal proof, coverage percentage, public deployment, real-wallet
compatibility, native GPU validation, global indexing/liveness guarantee, privacy guarantee
for public posts, Sybil resistance, human retention uplift, or large-scale load benchmark.
The original protocol's testnet addresses were not independently re-verified as deployed
bytecode during this upgrade. Dependency audit/CI outcomes are reported separately when run.

Primary specification for the bytecode limit: <https://eips.ethereum.org/EIPS/eip-170>.
