# Agent NFT and discovery research — 2026-09-17

## Executive decision

ANIMA should be an **ERC-8004 identity with an ERC-6551 execution account**, not a new incompatible
“iNFT” format. ERC-7857 contributes private-state transfer ideas; LayerZero ONFT contributes a
transport pattern; A2A, MCP and OASF describe how a discovered agent communicates and classifies
skills; x402 can describe payment at an HTTP resource. None replaces the others.

The immediate interoperability defect found in this review was the custom manifest shape. ERC-8004
now specifies `registration-v1` fields (`type`, presentation, `services`, `x402Support`, `active`,
`registrations`, and optional `supportedTrust`). The schema, example, SDK types and verification
flow now use that shape while preserving the namespaced `anima` commitments.

## Landscape

| Layer | Primary standard | ANIMA position |
|---|---|---|
| NFT ownership | ERC-721; ERC-1155 for fungible/semi-fungible sets | ERC-721: one agent needs one unambiguous owner |
| Agent identity/discovery | ERC-8004 registration, reputation and validation | Native identity plus separate reputation/validation registries |
| Agent wallet | ERC-6551; ERC-4337 for user operations | Deterministic token-bound account with bounded sessions and audit root |
| Private agent state (“iNFT”) | ERC-7857 | Adapted commitments/re-keying with explicit seal levels and epochs |
| Security reports | ERC-8126 | Optional provider-curated reports in ValidationRegistry |
| Identity relationships | ERC-8217 | External immutable binding registry |
| Rental/roles/locks | ERC-4907, ERC-7432, ERC-5192/6454 | Implemented without confusing user, role and owner authority |
| Agent transport | A2A Agent Card; MCP Streamable HTTP/stdio | Advertised as ERC-8004 services; negotiated by the native protocol |
| Skill taxonomy | OASF | Advertisable in an ERC-8004 OASF service; not hard-coded onchain |
| HTTP payment | x402 | Advertise only for a resource that returns and settles the actual protocol |
| Cross-chain NFT | LayerZero ONFT/ONFT Adapter | Adapter-like escrow/mirror, extended with agent-state snapshots |
| Onchain web | ERC-4804 ecosystem gateways | Immutable token console, separate from identity and service claims |
| Optional services | ERC-7656 | Better future extension model than adding every feature to the token |
| Token scripts | ERC-5169 | Rejected as primary discovery: mutable executable pointers widen supply-chain risk |

## iNFT and ONFT are not competing identity standards

“iNFT” is an overloaded product label. ERC-7857 is the useful standardized core: private metadata
and transfer-time re-encryption evidence. It cannot ensure a previous plaintext holder forgot what
they saw, so ANIMA exposes the residual guarantee as `SealPolicy` rather than promising magical
erasure.

LayerZero documents two ONFT patterns: burn/mint and adapter lock/mint. Burn/mint is unsafe for an
agent whose work obligations, bond, reputation and account live on the home chain. ANIMA therefore
escrows the canonical token and creates a state-carrying mirror. A mirror is discoverable evidence,
not a second canonical agent, and account assets remain home-chain assets.

## Discovery and mesh networks

ERC-8004 is the chain root. Its registration can advertise A2A, MCP, OASF, ENS, DID, email and other
services and can list multiple chain registrations. An HTTPS endpoint can publish a matching
`.well-known/agent-registration.json` to prove domain control. ANIMA adds exact-byte commitment;
consumers must still verify the registration identifies the token they queried.

A2A provides task/message semantics and Agent Card discovery. MCP provides client/server tool,
resource and prompt negotiation; its 2025-06-18 Streamable HTTP transport replaces the older
HTTP+SSE pattern, while stdio remains important locally. They are complementary: A2A delegates a
task to another agent; MCP exposes tools/context to an agent.

OASF is a taxonomy, not a transport. Publishing its skill/domain identifiers improves search without
inventing ANIMA-only category strings. Libp2p or a Sovereign Agent Mesh can be advertised as a
service/handle, but an onchain peer-id attestation only binds identity; NAT traversal, availability,
routing, spam control and secure channel negotiation remain mesh responsibilities.

## What was learned from the related repositories

`IPSEITY-FINAL` was reviewed at its current default branch. Its strongest transferable ideas are:
immutable extension releases; exact dependency identities; per-token namespaced state; explicit
migration/recovery; finite recovery bounds; and a browser host that never lets untrusted modules
silently access wallet/network/parent DOM. ANIMA should reuse the formats only through an explicit
adapter because IPSEITY's Reach authority model is not ANIMA's AgentAccount ABI.

`MASTER-NFT-PROJECT` was subsequently reviewed directly at commit
`e12e0cd38ed231a0b2015d17fec302a359476de1`. Its portable package format, finite dependency graph,
permission vocabulary, exact-call automation, immutable archive model, per-token state branches,
recovery receipts, browser isolation, and explicit transaction review are documented in
`MASTER_NFT_INTEGRATION_2026-09-17.md`. This update adopts the portable package identity and exact
session restrictions while deliberately not importing MASTER's alternative collection/account
authority or treating its local deployment evidence as ANIMA public-chain evidence.

The right next implementation is an optional ERC-7656-style module service with immutable package
hashes, declared permissions, bounded recovery and explicit transaction review—not loading arbitrary
manifest JavaScript into the agent wallet.

## Adoption assessment

**Will agents want it?** Some will, if the rails are operational. ANIMA solves real integration pain:
identity continuity, payment attribution, bounded authority, counterpart risk, capability discovery,
and transfer-safe memory. It is unusually complete for agent commerce.

The barriers are more practical than conceptual:

1. no independent audit;
2. a testnet deployment and example-only service endpoints;
3. no production indexer/ranker for skill, price, trust and availability queries;
4. no published npm release or language SDK matrix;
5. no continuously tested live A2A/MCP agents;
6. no mainnet economic history, liquidity or dispute operators;
7. complex modules that integrators should adopt incrementally rather than all at once.

A credible route is: conforming registration → live transport → searchable OASF taxonomy → paid
reference task → independently reproducible receipt → audited limited mainnet pilot. More token
standards without these operations would reduce, not increase, usefulness.

## Primary sources reviewed

- Ethereum standards: [ERC-721](https://eips.ethereum.org/EIPS/eip-721),
  [ERC-1155](https://eips.ethereum.org/EIPS/eip-1155), [ERC-4907](https://eips.ethereum.org/EIPS/eip-4907),
  [ERC-5192](https://eips.ethereum.org/EIPS/eip-5192), [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551),
  [ERC-7857](https://eips.ethereum.org/EIPS/eip-7857), [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004),
  [ERC-8126](https://eips.ethereum.org/EIPS/eip-8126), [ERC-8217](https://eips.ethereum.org/EIPS/eip-8217),
  [ERC-5169](https://eips.ethereum.org/EIPS/eip-5169), [ERC-7572](https://eips.ethereum.org/EIPS/eip-7572),
  [ERC-7656](https://eips.ethereum.org/EIPS/eip-7656), and [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337).
- [A2A protocol specification](https://a2a-protocol.org/latest/specification/).
- [MCP 2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
- [Coinbase x402 documentation](https://docs.cdp.coinbase.com/x402/docs/welcome).
- [LayerZero V2 ONFT documentation](https://docs.layerzero.network/v2/developers/evm/onft/quickstart).
- `IPSEITY-FINAL`: `MASTER-INTEGRATION.md`, `COMPOSABILITY.md`, `packages/modules/README.md`, module
  contracts, browser host and module tests from the cloned default branch on 2026-09-17.
