# NFT and agent-token standards audit — 2026-09-02

## Executive conclusion

ANIMA is not missing another ownership primitive. It already composes the standards that make
an agent useful: ERC-721 identity and transfer, ERC-6551 custody, ERC-4907 tenancy, ERC-7432
roles, ERC-8004 discovery/reputation/validation, private state inspired by ERC-7857, metered
work, collateral, and an escrow-and-mirror omnichain design.

The material gap found in this review was **portable security verification**. ERC-8004 can
record an arbitrary validator response, but it does not give wallets a conventional agent risk
score or proof bundle. ERC-8126 became Final in 2026 and defines exactly that optional on-chain
surface. `ValidationRegistry` now records an allowlisted provider's 0–100 risk score, the five
category proof identifiers, and a summary proof, while exposing the latest result to wallets.

The next best holder-facing improvements are presentation and policy infrastructure, not more
token mechanics: render live bond/reputation/risk data as dynamic traits; publish a safe client
application through the committed manifest; and prototype ERC-8354 confidential policy guards
as a separate module once its proving and ERC-7812 dependencies mature.

## Method

This was a source-level comparison, not a keyword search.

1. The canonical [Ethereum ERC repository](https://github.com/ethereum/ERCs) was cloned at the
   review date. Every proposal whose title/description identifies an NFT or whose front matter
   requires ERC-721 was extracted (over 120 proposals), then read by functional family.
2. Agent-specific ERC-7662, ERC-7857, ERC-8004, ERC-8041, ERC-8126, ERC-8217, and ERC-8354 were
   compared field-by-field with ANIMA's interfaces and contracts.
3. LayerZero's current [ONFT V2 documentation](https://docs.layerzero.network/v2/developers/evm/onft/quickstart)
   was compared with `OmniAgentHome`, `OmniAgentMirror`, and `AnimaOApp`. ONFT is a LayerZero
   contract standard, not an Ethereum ERC.
4. Every externally callable contract surface, ERC-165 declaration, transfer hook, holder
   authorization path, deployment script, and test was reviewed. “Implemented” below means the
   behavior is both present and relevant; it does not mean ANIMA claims another proposal's
   interface when it deliberately uses a safer shape.

Status is especially important. A Draft is a design input, not an interoperability promise;
Stagnant and Withdrawn proposals should not drive permanent token bytecode without deployed
demand.

## What “iNFT” and “ONFT” mean

These labels are overloaded and should not be placed in an ERC-165 table as if each were one
stable interface.

- **iNFT / intelligent NFT** originally described proprietary combinations of an NFT, an AI
  service, and personality data. The standardized private-agent interpretation is now
  [ERC-7857](https://eips.ethereum.org/EIPS/eip-7857), AI Agents NFT with Private Metadata.
  ANIMA adapts its encrypted-data commitment and verified transfer model, but adds storage
  locations, epochs, recipient key discovery, and an explicit `SealPolicy`. The adaptation is
  intentional because implementing a vendor-coupled ABI would not itself make state private.
- **ONFT** is LayerZero's omnichain NFT family. ONFT721 burns on the source and mints on the
  destination; ONFT721Adapter locks the original and mints remote representations. ANIMA uses
  the adapter-like escrow model because burning an agent on its accountability chain would
  orphan its bond, jobs, reputation, and token-bound account. Its bridge additionally commits
  the manifest, brain, model, and seal state, and rate-limits inbound paths.

## Standards coverage by family

### Foundation, metadata, and discovery

| Standard | Status | Decision | Reason |
|---|---|---|---|
| ERC-165 / ERC-721 | Final | Implemented | Canonical discovery, ownership, approvals, metadata, and safe transfer. |
| ERC-1046 / 2477 / 5625 | mixed | Covered by stronger commitment | `agentURI` plus `manifestHash` provides storage-neutral metadata integrity. |
| ERC-2309 / 6047 | Final | Not applicable | Consecutive/birth-event optimizations target bulk collection minting; ANIMA agents have unique initialized state. |
| ERC-4906 | Final | Implemented | Cache invalidation on manifest, model, and brain changes. |
| ERC-5169 | Final | Manifest instead of token code | A wallet-rendered client is useful, but mutable executable script pointers are a supply-chain risk. Put content-addressed clients in the committed manifest. |
| ERC-6785 | Draft | Manifest instead of on-chain URI history | Holder utility should be declared, but a URI history is not enforcement. ANIMA exposes actual capabilities and their live state. |
| ERC-7160 | Final | Semantically covered | Brain shards already provide multiple typed URIs and a deterministic root; pretending those are interchangeable display images would lose meaning. |
| ERC-7496 | Draft | Recommended view/indexer | Dynamic traits are ideal for bond coverage, risk, status, jobs, and reputation. Compute them from canonical registries rather than duplicate mutable truth in the NFT. |
| ERC-7572 | Draft | Implemented | Collection metadata is exposed through `contractURI`. |

### Authorization, safety, rental, and roles

| Standard(s) | Decision | Reason |
|---|---|---|
| ERC-4494 permit | Defer | Gasless single-token approval improves sale UX, but it adds another phishable signature surface. The native market already uses scoped EIP-712 orders. Add only if an external marketplace integration requires it. |
| ERC-4907 | Implemented | One expiring tenant, cleared on sale; paid leases lock the token. |
| ERC-5008 | Not separately needed | Its nonce exists to support extensions such as permits. ANIMA uses domain-separated nonces on the authorization surfaces that need them. |
| ERC-5192 + ERC-6454 | Implemented and enforced | Both discovery views report the same counted job/dispute lock that the transfer hook enforces. |
| ERC-7432 | Implemented externally | Multiple expiring, revocable roles belong in `AnimaRoles`; this keeps the base NFT liquid and small. |
| ERC-6464 | Defer | Multiple per-token operators add approval complexity while agent operators and roles already provide scoped control. |
| ERC-6997 / 7066 | Covered by stronger invariants | Transfer validation and locking exist without an owner-bypassable validator dependency. |
| ERC-7695 | Covered | Ownership context is expressed by owner, tenant, agent operator, scoped roles, session keys, and bound wallet. |
| Soulbound family (4671, 4973, 5192, 5484, 5516, 5727, 7574) | Reject permanent binding | An agent is economically useful because it can be leased and sold. It is locked only while obligations exist. |

### Custody, composition, and finance

| Standard(s) | Decision | Reason |
|---|---|---|
| ERC-998 / 6059 / 6150 / 6220 / 7401 / 7510 | Not needed | NFT nesting organizes assets but does not create safe execution or more code capacity. ERC-6059 is also superseded by ERC-7401. |
| ERC-6551 | Implemented | Deterministic token-bound wallet with ERC-1271 and an account-state nonce. |
| ERC-7656 | Recommended extension pattern | Best future home for optional services without expanding either immutable token build. |
| ERC-7590 | Superseded here by ERC-6551 | Letting the NFT contract itself receive ERC-20s is less composable than its standard account. |
| ERC-4353 / 5604 / 7565 / 7595 | Domain-specific, not adopted | Generic staking, liens, and collateral interfaces do not express ANIMA's slashable coverage and per-obligation reservations. |
| ERC-6682 flash loans | Reject | Temporary control of an autonomous identity undermines reputation, policy, and accountability assumptions. |
| Fractional/semi-fungible family (3525, 4675, 7631, 7651, 7628) | Reject for agent ownership | An agent needs one unambiguous controller. Economic exposure can be issued separately by `AgentToken`. ERC-3525 also collides with ERC-721 selectors. |
| ERC-2981 | Implemented | Royalty declaration; protocol economics do not falsely assume marketplace enforcement. |
| ERC-7641 | Adapted | `AgentToken` uses burn-to-redeem economics without importing unrelated snapshot machinery. |

### Content, rights, physical assets, and collectibles

ERC-1948, 2135, 3440, 3569, 3589, 4400, 4519, 4883, 4885, 4950, 4955, 5007,
5050, 5173, 5218, 5375, 5380, 5489, 5501, 5507, 5521, 5553, 5554, 5560, 5570,
5606, 5635, 5643, 5700, 5725, 5773, 5791, 6065, 6220, 6239, 6381, 6596, 6672,
6806, 6809, 6956, 7007, 7015, 7085, 7280, 7409, 7439, 7498, 7517, 7548, 7578,
7634, 7644, 7765, 7829, 7832, 7847, 7858, 7861, 7891, 7929, 8034, and 8040 were
reviewed. They solve collectible editions, consumption/redemption, media provenance, IP
licensing, physical/RWA binding, social relationships, credentials, expiration, or hierarchy.
Those are valid NFT use cases but not missing agent-holder utility. Importing them would either
misstate what an agent is or duplicate the manifest, brain-shard, role, escrow, and account
systems. ERC-7007's zkML/opML concepts remain useful as verifier implementations; they are not a
reason for an autonomous agent identity to claim it is an AI-generated *content token*.

### Agent standards

| Standard | Status on review date | Coverage and gap analysis |
|---|---|---|
| ERC-7662 AI Agent NFTs | Draft | Its minimal prompt/model/data description is covered by `ModelIdentity`, typed brain shards, and the manifest. ANIMA adds execution and accountability. |
| ERC-7857 private agent metadata | Final | Adapted and strengthened with key registration, atomic re-key transfer, epochs, verifier-reported seal strength, and honest residual-risk semantics. |
| ERC-8004 Trustless Agents | Draft | Identity is implemented on the token; reputation and validation are separate registries. Paid-work attestations prevent free feedback being mistaken for economic evidence. |
| ERC-8041 fixed-supply collections | Draft | Not suitable for permissionless one-by-one agent registration. A curated deployment can enforce a cap in a separate factory without changing agent semantics. |
| ERC-8126 AI Agent Verification | Final | **Newly implemented optional on-chain surface.** Providers remain off-chain; allowlisted results are portable and queryable. |
| ERC-8217 Agent NFT Identity Bindings | Draft | Implemented as the external `AnimaBindings` registry. |
| ERC-8354 confidential policy verdicts | Draft | High-value next experiment. It hides policy rules while proving an action was allowed. Keep it an account guard/module: it depends on ERC-7812 roots and a proof verifier and should not be frozen into the token while Draft. |

## Holder-utility audit of the implementation

### Utility already delivered

- **Productive ownership:** the holder owns an agent identity and its deterministic account,
  can run bounded sessions, and can rescue the account without being trapped by agent policy.
- **Income:** work escrow, inference metering, priced communications, leases, and market sales
  route value to the agent or holder under explicit settlement rules.
- **Capital and credibility:** a readable bond caps counterparty exposure; paid feedback,
  validation, execution provenance, and now ERC-8126 risk reports make diligence portable.
- **Delegation without sale:** ERC-4907 tenancy and ERC-7432 roles split operator, payer,
  auditor, and trainer rights while preserving ownership.
- **Private, transferable state:** buyers can demand atomic verified re-keying and see exactly
  what confidentiality level was certified.
- **Cross-chain reach:** a canonical escrowed agent can appear elsewhere without abandoning
  home-chain liabilities.
- **Safety:** transfer revokes old autonomy; counted locks cover concurrent obligations;
  approvals can expire or be revoked in one transaction; token and leveraged spending have
  distinct caps.

### Findings and priorities

1. **Completed — ERC-8126 risk attestations.** Only allowlisted providers may overwrite the
   latest security result, even when ordinary ERC-8004 validation is open. Scores outside
   0–100 and nonexistent agents revert. The detailed read includes provider, time, score, and
   summary proof so a client can apply freshness and trust policy rather than blindly showing a
   badge.
2. **High — dynamic holder dashboard, no duplicated state.** Expose ERC-7496-shaped traits from
   an indexer or ERC-7656 service: free/slashable bond, status, open obligations, attested job
   score, latest ERC-8126 score/provider/age, brain epoch/seal, and account state. This is the
   clearest unbuilt holder utility, but putting aggregator loops in the NFT would add gas and
   new failure dependencies.
3. **High — confidential execution policy prototype.** ERC-8354 can let enterprises prove that
   an agent action passed a private compliance policy. Integrate at `AgentAccount`'s execution
   boundary only after independent review of the domain registry, nullifier handling, root-age
   grace, verifier binding, and fail-closed behavior.
4. **Medium — safe client discovery.** Add a content-addressed web client entry to the canonical
   manifest schema and SDK validation. Prefer this over ERC-5169's collection-owner mutable
   executable URI. A wallet must verify the manifest commitment and content digest before use.
5. **Medium — standardized credential presentation.** ERC-8126 proofs, model attestations, and
   paid-work evidence should be assembled off-chain into a holder-readable report. Do not
   collapse provider identity and report age into one “verified” boolean.
6. **Conditional — ERC-4494.** Implement only for a marketplace that consumes it. If added,
   support ERC-1271 owners, increment nonce on every transfer, reject expired signatures, and
   test replay across transfer and both immutable builds. It is convenience, not fundamental
   holder utility.

## Security conclusions

- A low ERC-8126 score is not a guarantee. It is a provider assertion linked to evidence; user
  interfaces must display provider and age.
- Agent security results must never be permissionlessly overwriteable. Open work validation
  and curated security verification have different Sybil assumptions.
- Burn-and-mint ONFT is unsafe for a token with chain-local liabilities. The current canonical
  escrow model is the correct choice.
- “Encrypted NFT” must not imply that a prior plaintext holder forgot what it saw. The existing
  seal taxonomy is more honest than adopting an interface label alone.
- Extra standards are not automatically extra utility. Selector collisions, mutable scripts,
  duplicated truth, permanent locks, and flash ownership can each make the holder worse off.

## Sources

- [Canonical Ethereum ERC repository](https://github.com/ethereum/ERCs)
- [ERC-721](https://eips.ethereum.org/EIPS/eip-721), [ERC-4907](https://eips.ethereum.org/EIPS/eip-4907),
  [ERC-5192](https://eips.ethereum.org/EIPS/eip-5192), [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551),
  [ERC-7432](https://eips.ethereum.org/EIPS/eip-7432), [ERC-7656](https://eips.ethereum.org/EIPS/eip-7656)
- [ERC-7662](https://eips.ethereum.org/EIPS/eip-7662), [ERC-7857](https://eips.ethereum.org/EIPS/eip-7857),
  [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126),
  [ERC-8217](https://eips.ethereum.org/EIPS/eip-8217), [ERC-8354](https://eips.ethereum.org/EIPS/eip-8354)
- [LayerZero V2 ONFT Quickstart](https://docs.layerzero.network/v2/developers/evm/onft/quickstart)

