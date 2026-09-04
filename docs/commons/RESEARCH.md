# NFT and Web3 research -> Sanctuary Commons decisions

**Review date:** 4 September 2026. **Target:** ANIMA at
`35a725ee817dc52ec87300a0514c95fb82045631`.

## 1. Conclusion

The highest-value upgrade is not another ownership interface. ANIMA already combines
agent identity, an account, scoped execution, work, collateral, reputation, private-state
commitments and a home/mirror transport. The missing layer is the human journey between
these mechanisms: belonging, discovering, asking, collaborating, checking evidence and
returning to something useful.

The implementation therefore preserves the protocol, adds a small independent public-social
contract, and replaces the default client with a navigable sanctuary. It separates five facts
that should never be collapsed into one badge: **identity, authority, statement, evidence and
settlement**. Neither an impressive avatar nor an NFT standard proves all five.

## 2. Scope and method

The repository's earlier `NFT_STANDARDS_RESEARCH_2026-09-02.md` contains its own broader ERC
census. That document was read as project context, not treated as independently verified
proof of everything it claims. This review freshly consulted primary specifications across
the families below, inspected the actual contract/client boundaries, ran the baseline, added
implementation tests and exercised browser-originated transactions on a disposable EVM.

The atlas is a broad functional map, not a claim that every NFT proposal on every blockchain
has been exhaustively read, deployed or conformance-audited. Standards membership is not a
binary marketing checklist: status, ABI, deployment conventions, authorization and actual
consumer interoperability all matter. Only selected fast-moving statuses are repeated below;
the linked canonical specification remains the source of truth.

## 3. iNFT: distinguish ownership, secrecy, intelligence and proof

[iNFT/agent metadata: ERC-7857](https://eips.ethereum.org/EIPS/eip-7857) is **Final** at the
review date. It specifies private agent metadata and verifiable data-transfer interfaces,
including an on-chain verifier and off-chain prover. It does not by itself put a large model's
inference on the EVM. ANIMA's sealed-brain implementation is an adaptation with its own keys,
commitments and seal-strength semantics, not a reason to assert an identical ABI or that an
external model has been audited. The new public social layer deliberately does not pretend
that a visibility toggle supplies encryption.

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is still **Draft** in the canonical
specification, despite deployments and ecosystem use. It provides identity, reputation and
validation registries. Its security discussion explicitly retains Sybil and capability-veracity
risks. Decision: read concrete agent state and the repository's attested-work count; do not
turn arbitrary feedback into a percentage labelled trust. An on-chain identity is not evidence
that advertised endpoints work or that the registered agent is safe.

[ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) is **Final** and describes specialized
agent-verification interfaces and risk results. A standard-shaped report remains dependent
on its provider and evidence. ANIMA already has an optional registry surface. The new client
does not fabricate an ERC-8126 result or silently label absence as low risk. A subsequent
report view must show provider, time, scope, proof commitment and verification method.

[ERC-7662](https://eips.ethereum.org/EIPS/eip-7662) describes agent-associated prompts,
model and data. [ERC-7007](https://eips.ethereum.org/EIPS/eip-7007) concerns verifiable
AI-generated **content**, a different asset from the agent which produced it.
[ERC-8217](https://eips.ethereum.org/EIPS/eip-8217) concerns identity bindings.
[ERC-8354](https://eips.ethereum.org/EIPS/eip-8354) is an input for confidential policy verdicts,
not an already-installed general privacy engine. No external AI execution, proof system,
private transport or confidential policy guard was added by this upgrade.

## 4. ONFT: token movement is not whole-agent continuity

[LayerZero ONFT V2](https://docs.layerzero.network/v2/developers/evm/onft/quickstart) is a
protocol implementation family, not a single Ethereum ERC number. ONFT721 and its adapter
have different supply/custody patterns. Endpoint, peer, verification and execution settings
are part of the security boundary, not deployment boilerplate.

An agent can have home-chain jobs, reserved collateral, account permissions, keys and model
commitments. Moving `(recipient, tokenId)` does not automatically move those liabilities.
ANIMA's existing canonical-home/mirror structure is therefore preserved. This client does
not expose a new bridge button or infer remote execution authority from the appearance of a
mirror. A future cross-chain action must check home authority, source/destination domain,
message freshness, pause/recovery policy and unresolved obligations.

[IBC ICS-721](https://docs.cosmos.network/ibc/v10.1.x/spec/app/ics-721-nft-transfer/README)
is another native NFT-transfer specification with class/token identity, trace and packet
semantics. Generic cross-chain messaging can also carry a custom NFT protocol. Therefore
“only two technologies can carry an NFT” is not a sound general conclusion; a product-specific
token-transfer API and a general message transport are different abstractions. This release
does not implement IBC, a generic-message NFT bridge or cross-chain social membership.

## 5. Standards atlas and implementation choices

**Legend:** Existing = a corresponding capability is already in the repository, not a new
conformance certification. Preserve = do not destabilize it for this UI upgrade. Defer = a
specific candidate, not shipped. Reject here = would confuse this product's authority model.
Every entry links a primary specification; short descriptions are not a substitute for its
full normative requirements.

### Ownership, supply, approvals and economics

| Specification | Primitive | Decision for this project |
|---|---|---|
| [ERC-165](https://eips.ethereum.org/EIPS/eip-165) | Interface discovery | Preserve truthful interface advertisement; no fictional social ERC ID. |
| [ERC-721](https://eips.ethereum.org/EIPS/eip-721) | Unique ownership and transfer | Keep the agent identity; do not tokenize each casual message. |
| [ERC-1155](https://eips.ethereum.org/EIPS/eip-1155) | Multiple token types and batches | Candidate for future inventory, not a replacement for agent ownership. |
| [ERC-2309](https://eips.ethereum.org/EIPS/eip-2309) | Consecutive transfer events | No new bulk-mint requirement in Commons. |
| [ERC-3525](https://eips.ethereum.org/EIPS/eip-3525) | Value within semi-fungible slots | Do not fractionalize responsibility for a single agent's execution. |
| [ERC-7631](https://eips.ethereum.org/EIPS/eip-7631) | Dual-nature token pairs | No hybrid liquidity/popularity mechanism added. |
| [ERC-7651](https://eips.ethereum.org/EIPS/eip-7651) | Fractionally represented NFTs | Reject for human profiles and circle authority. |
| [ERC-4494](https://eips.ethereum.org/EIPS/eip-4494) | NFT permit signatures | Not required to join or post; avoid an unnecessary signing surface. |
| [ERC-2981](https://eips.ethereum.org/EIPS/eip-2981) | Royalty information | Preserve; an information interface is not universal royalty enforcement. |
| [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626) | Tokenized asset vault | Not a substitute for slashable work coverage; no automatic yield. |
| [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540) | Asynchronous vault requests | Useful for later asset products, unrelated to conversational consent. |

### Metadata, recoverability and presentation

| Specification | Primitive | Decision |
|---|---|---|
| [ERC-1046](https://eips.ethereum.org/EIPS/eip-1046) | Token URI interoperability | Distinguish a URI from the data and from verified code. |
| [ERC-2477](https://eips.ethereum.org/EIPS/eip-2477) | Metadata integrity | Content hashes are useful; integrity does not guarantee availability. |
| [ERC-4906](https://eips.ethereum.org/EIPS/eip-4906) | Metadata update signaling | Existing; use fresh reads rather than a frozen trust showcase. |
| [ERC-5169](https://eips.ethereum.org/EIPS/eip-5169) | Token-associated client scripts | Consider only with authenticated bundles; no automatic remote script loading. |
| [ERC-7160](https://eips.ethereum.org/EIPS/eip-7160) | Multiple metadata outputs | A UI/media surface is not interchangeable with private execution state. |
| [ERC-7496](https://eips.ethereum.org/EIPS/eip-7496) | Dynamic NFT traits | Read canonical status/policy/evidence instead of duplicating mutable truth. |
| [ERC-7508](https://eips.ethereum.org/EIPS/eip-7508) | External attributes repository | Useful external pattern; no extra attributes dependency required here. |
| [ERC-7572](https://eips.ethereum.org/EIPS/eip-7572) | Collection `contractURI` | Preserve collection metadata; distinguish it from a human's profile. |
| [ERC-5646](https://eips.ethereum.org/EIPS/eip-5646) | Token state fingerprint | Used through ANIMA to bind an agent-badged publication to current state. |
| [ERC-4804](https://eips.ethereum.org/EIPS/eip-4804) | Web3 URL-to-EVM calls | Candidate for recoverable client distribution; not deployed by this upgrade. |

### Composition and relationships

| Specification | Primitive | Decision |
|---|---|---|
| [ERC-998](https://eips.ethereum.org/EIPS/eip-998) | Composable ownership | Do not represent people as assets nested under an agent. |
| [ERC-6150](https://eips.ethereum.org/EIPS/eip-6150) | Hierarchical NFTs | Separate asset hierarchy from revocable community roles. |
| [ERC-7401](https://eips.ethereum.org/EIPS/eip-7401) | Parent-governed nesting | Supersedes ERC-6059; equipment/ownership nesting is not circle membership. |
| [ERC-5773](https://eips.ethereum.org/EIPS/eip-5773) | Context-dependent multiple assets | Candidate for future avatar/media outputs, not a prerequisite for 3D navigation. |
| [ERC-6220](https://eips.ethereum.org/EIPS/eip-6220) | Equippable composition | Future interoperable equipment must honor ownership and acceptance semantics. |
| [ERC-7590](https://eips.ethereum.org/EIPS/eip-7590) | ERC-20 holding by NFTs | Existing agent accounts are the custody boundary; Commons holds no assets. |
| [ERC-5521](https://eips.ethereum.org/EIPS/eip-5521) | NFT reference relationships | Provenance graphs can be useful, but replies need not become NFTs. |
| [ERC-7409](https://eips.ethereum.org/EIPS/eip-7409) | Public NFT emoting | Reaction semantics inform design; Commons uses post reactions, not this NFT ABI. |

### Use rights, locks, credentials and consent

| Specification | Primitive | Decision |
|---|---|---|
| [ERC-4907](https://eips.ethereum.org/EIPS/eip-4907) | Expiring NFT user | Preserve rental/control distinction; leasing an agent grants no human social office. |
| [ERC-5006](https://eips.ethereum.org/EIPS/eip-5006) | ERC-1155 user rights | Possible inventory rental, not social membership. |
| [ERC-5192](https://eips.ethereum.org/EIPS/eip-5192) | Minimal lock discovery | Existing obligation locks are not proof of a unique human. |
| [ERC-6454](https://eips.ethereum.org/EIPS/eip-6454) | Transferability query | Preserve consistent transfer restrictions rather than add a second lock truth. |
| [ERC-4973](https://eips.ethereum.org/EIPS/eip-4973) | Account-bound tokens | Optional credentials should require consent; no compulsory social token. |
| [ERC-5484](https://eips.ethereum.org/EIPS/eip-5484) | Consensual soulbound tokens | Consent matters; permanent public credentials still carry disclosure risks. |
| [ERC-5516](https://eips.ethereum.org/EIPS/eip-5516) | Multi-owner soulbound tokens | Not a reason to make reversible circle participation permanently token-bound. |
| [ERC-7432](https://eips.ethereum.org/EIPS/eip-7432) | NFT roles | Existing external agent roles remain separate from human circle moderators. |

### Accounts, permissions and agent identity

| Specification | Primitive | Decision |
|---|---|---|
| [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551) | Token-bound accounts | Preserve. Canonical registry/proxy conventions matter; status is Review at this date. |
| [ERC-7656](https://eips.ethereum.org/EIPS/eip-7656) | Contract-linked services | Supports the case for small optional services outside the core. |
| [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) | Account abstraction | Future social gas sponsorship needs a real bundler/paymaster and bounded authority. |
| [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) | EOA code delegation | Not a blanket permission or a reason to auto-request delegation. |
| [ERC-7579](https://eips.ethereum.org/EIPS/eip-7579) | Modular smart accounts | Candidate for restricted sessions; unreviewed modules are not installed. |
| [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) | Wallet permission requests | Future sessions must expose expiry, limits and revocation; not shipped. |
| [EIP-5792](https://eips.ethereum.org/EIPS/eip-5792) | Wallet call API | Future batching must check wallet capability and atomicity; current writes are explicit. |
| [ERC-7662](https://eips.ethereum.org/EIPS/eip-7662) | Agent NFT descriptors | Preserve declared-model versus verified-execution distinction. |
| [ERC-7857](https://eips.ethereum.org/EIPS/eip-7857) | Private agent metadata | No claim that public Commons or an adapted sealed brain is a complete prover stack. |
| [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) | Agent identity/evidence registries | Read actual evidence; avoid invented or aggregated trust percentages. |
| [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126) | Agent verification reports | Preserve existing provider-bound surface; no fake report in the UI. |
| [ERC-8217](https://eips.ethereum.org/EIPS/eip-8217) | Identity bindings | Useful discovery, not transfer of a person's account or relationship history. |
| [ERC-7007](https://eips.ethereum.org/EIPS/eip-7007) | Verified AI-generated content | Keep content provenance distinct from agent ownership. |
| [ERC-8354](https://eips.ethereum.org/EIPS/eip-8354) | Confidential policy verdicts | Research candidate with proof dependencies, not existing execution privacy. |

## 6. Other ecosystems and social infrastructure

[Metaplex Core AppData](https://www.metaplex.com/docs/smart-contracts/core/external-plugins/app-data)
provides on-chain application data attached to Solana assets; it is a serious alternative
when an asset needs application state. [Bubblegum V2](https://www.metaplex.com/docs/smart-contracts/bubblegum-v2)
uses compressed representations: on-chain Merkle commitments, transaction data and DAS
indexing/proofs. A compressed asset is not the same storage/retrieval architecture as an EVM
contract holding every message body. Neither technology is transplanted into this EVM repo.

[Cardano CIP-68](https://cips.cardano.org/cip/cip-68) separates a metadata reference NFT
and user token using output datums. [NEAR NEP-171](https://nomicon.io/Standards/Tokens/NonFungibleToken/Core)
provides another NFT ownership/transfer model. These are examples of why the design space
cannot honestly be reduced to Ethereum ERC numbers alone. Their chain-specific execution,
authorization and storage models would require actual adapters or a separate implementation.

[Lens](https://lens.xyz/docs/protocol) distinguishes social components such as accounts,
graphs, feeds, groups and rules. [Farcaster](https://docs.farcaster.xyz/learn/architecture/overview)
uses a distinct identity/message architecture; current documentation should be used instead
of assuming its older architecture remains unchanged. These are interoperability candidates,
not backends secretly operating this release. Requiring either service here would change the
user's on-chain/source-of-truth assumptions and add delivery/indexing dependencies.

[XMTP user consent](https://docs.xmtp.org/chat-apps/user-consent/user-consent) distinguishes
unknown, allowed and denied relationships. It supports the design principle that receiving a
message and consenting to a relationship are separate acts. The shipped implementation uses
local muting and explicit circle admission, not XMTP transport. The preserved `AgentComms`
handles paid request commitments/refunds; its transport and actual encryption need separate
integration and review. A paid request is not a social follow, and an invitation is not privacy.

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) informs the human layer: keyboard access, visible
focus, meaningful targets, and a non-dragging path. These principles are relevant technology,
not cosmetic polish added after the blockchain work. The browser tests are narrow checks,
not a claim of WCAG certification.

## 7. Research decisions translated into code

1. **Composition outside the token.** Core runtime is already close to EIP-170's limit. Add
   `AnimaCommons`; do not mutate core/facet layout or import every discovered interface.
2. **Historical agent authority.** Publish with an expected token fingerprint and record the
   author/owner snapshot; test sale and ownership round trips.
3. **Human participation without asset purchase.** Address membership and explicit roles;
   no transferable circle token or wealth-ranked feed.
4. **Evidence rather than decorative credibility.** Read contracts at a recorded block;
   isolate local sample data; remove misleading fixed trust and balance labels.
5. **Public recoverability with honest costs.** Store public body/rules bytes, bound sizes and
   page reads; never claim hidden data has been deleted or encrypted.
6. **Conversations can lead to work without becoming accidental spending.** Keep briefs
   separate from escrow and check exact client/specification before linking.
7. **3D as a map, not a gate.** Actual geometry and native controls, with flat and CPU paths.
8. **Return through unfinished useful work.** Saved references, local drafts, finite catchup
   and purpose-led circles. Retention is a hypothesis for a consented pilot, not an achieved metric.

## 8. Rejected shortcuts

No claim of full ABI compatibility from using a similar idea. No bridge enabled merely because
ONFT exists. No LLM assumed from an iNFT label. No reputation score derived from likes. No
private chat simulated by a hidden HTML panel. No local sample represented as live money.
No animated number presented as chain state. No passkey/session permission requested simply
because account abstraction is fashionable. No imitation of the previous AWE builds.

The result is narrower than a marketing list but stronger as a usable upgrade: every enabled
chain-backed social action has an actual contract path, and important unimplemented surfaces
are explicitly named rather than concealed behind aspirational buttons.
