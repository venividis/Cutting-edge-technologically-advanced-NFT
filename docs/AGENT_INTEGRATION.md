# Integrating an AI agent with ANIMA

This guide is the shortest machine-oriented route into ANIMA. ANIMA is an **unaudited reference
implementation**. Its published deployment is on Base Sepolia, where assets have no real value.
Treat every endpoint in a manifest as untrusted until the exact document bytes match the on-chain
commitment.

## Discovery model

ANIMA separates discovery into two independently useful layers:

1. The ERC-8004-compatible identity registry returns an `agentURI`.
2. ANIMA's `manifestOf(agentId)` also returns a `manifestHash` and version. The hash is
   `keccak256` over the **exact bytes served by the URI**.

The manifest is an A2A-inspired capability card with ANIMA extensions for on-chain identity,
MCP endpoints, pricing, model commitments, handles, and interfaces. It is not a claim that every
ANIMA manifest is a conforming A2A Agent Card. A provider that supports A2A should also publish its
standards-conforming Agent Card at the well-known location required by the A2A version it supports.

MCP servers should use the standard `stdio` or `streamable-http` transport. `sse` exists in the
schema only for compatibility with legacy MCP servers. A manifest advertises an MCP server; normal
MCP initialization and capability negotiation still happen after connecting.

## Verify before use

Install dependencies from this repository:

```bash
npm install
npm run sdk:build
```

This minimal client reads and verifies a manifest without parsing untrusted bytes first:

```ts
import { createPublicClient, http, keccak256 } from "viem";
import { baseSepolia } from "viem/chains";

const ANIMA = "0x0aeb6f783ebade8fd5ffca74317266d4ea3e71b3";
const agentId = 2n;
const abi = [{
  type: "function",
  name: "manifestOf",
  stateMutability: "view",
  inputs: [{ name: "agentId", type: "uint256" }],
  outputs: [
    { name: "agentURI", type: "string" },
    { name: "manifestHash", type: "bytes32" },
    { name: "version", type: "uint32" },
  ],
}] as const;

const client = createPublicClient({ chain: baseSepolia, transport: http() });
const [uri, committedHash, version] = await client.readContract({
  address: ANIMA,
  abi,
  functionName: "manifestOf",
  args: [agentId],
});

if (!uri) throw new Error("agent has no discovery URI");
if (/^0x0{64}$/.test(committedHash)) throw new Error("manifest is not integrity-bound");

const response = await fetch(uri, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (keccak256(bytes) !== committedHash) throw new Error("manifest hash mismatch");

const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
console.log({ version, name: manifest.name, skills: manifest.skills, mcp: manifest.anima?.mcp });
```

Production clients should additionally enforce a response-size limit, request timeout, redirect
policy, HTTPS or explicitly supported content-addressed URI scheme, JSON Schema validation, and
network egress policy. Hashing `JSON.stringify(await response.json())` is wrong: parsing and
re-serializing can change the committed bytes.

## Publishing a manifest

Use the [v1 JSON Schema](../schemas/anima-agent-manifest-v1.schema.json) and start from the
[illustrative example](../examples/manifests/base-sepolia-example.json). The example's
`agent.example` endpoints are intentionally non-operational.

The SDK's `serialiseManifest` implements the repository's canonical JSON encoding and
`manifestHash` computes its commitment:

```ts
import { manifestHash, serialiseManifest, type AgentManifest } from "@anima/sdk";

const manifest: AgentManifest = {
  name: "Atlas",
  description: "A bounded research agent",
  version: "1.0.0",
  skills: [{ id: "research", name: "Research", description: "Research with citations" }],
  anima: {
    registry: "eip155:84532:0x0aeb6f783ebade8fd5ffca74317266d4ea3e71b3",
    agentId: "2",
    mcp: [{ name: "atlas", url: "https://atlas.example/mcp", transport: "streamable-http" }],
  },
};

const body = serialiseManifest(manifest);
console.log(manifestHash(manifest));
// Serve `body` verbatim, then call setManifest(agentId, URI, hash) as an authorized controller.
```

Never calculate the hash and then allow a CDN, CMS, or formatter to rewrite the response. Fetch
the deployed URI and verify it against the intended hash before submitting `setManifest`.

## Decide whether to transact

A valid manifest proves only that the token controller committed to those bytes. Before hiring or
paying an agent, independently check its current owner/controller, lifecycle status, ERC-6551
account, autonomy policy, work locks, bond coverage, and the attested rather than open reputation
summary. See the [security model](SECURITY.md) and [Base Sepolia deployment record](../deployments/84532.json).

After selecting a transport, follow that transport's own handshake and authentication rules.
Do not infer successful delivery, payment, or trustworthy output merely from endpoint discovery.

## SDK consumption

`@anima/sdk` is prepared as an ESM package but is not claimed to be published to the public npm
registry. From a checkout, build and create an installable tarball with:

```bash
npm run sdk:build
npm pack ./sdk
```

The public API and examples are documented in [`sdk/README.md`](../sdk/README.md).

## Primary interoperability references

- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [MCP transports specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785)
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-6551](https://eips.ethereum.org/EIPS/eip-6551)
