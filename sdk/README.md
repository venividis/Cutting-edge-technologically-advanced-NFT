# `@anima/sdk`

Typed ESM helpers for reproducing ANIMA's Solidity commitments off-chain. The package covers
manifest canonicalization, brain and inference-receipt roots, private-envelope hashes, audit-log
replay, policies, marketplace typed data, immutable-diamond construction, and the byte-compatible
immutable extension format adopted from MASTER-NFT-PROJECT.

The package is not claimed to be published on npm yet. Build or pack it from the repository:

```bash
npm install
npm run sdk:build
npm pack ./sdk
```

Then install the emitted tarball in a consumer project. Node.js 20 or newer and `viem` are required.

```ts
import { fetchVerifiedManifest, manifestHash, serialiseManifest, type AgentManifest } from "@anima/sdk";

const manifest: AgentManifest = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Atlas",
  description: "Example research agent",
  image: "https://atlas.example/avatar.png",
  services: [{ name: "MCP", endpoint: "https://atlas.example/mcp", version: "2025-06-18" }],
  x402Support: false,
  active: true,
  registrations: [{ agentId: 2, agentRegistry: "eip155:84532:0xb3d92c766e3cb356db381feb21958a9ebb974365" }],
  anima: {
    registry: "eip155:84532:0xb3d92c766e3cb356db381feb21958a9ebb974365",
    agentId: "2",
  },
};

const exactBytesToPublish = serialiseManifest(manifest);
const onChainCommitment = manifestHash(manifest);

const verified = await fetchVerifiedManifest("https://atlas.example/registration.json", onChainCommitment, {
  expectedRegistry: manifest.anima.registry,
  expectedAgentId: 2,
});
```

See the [agent integration guide](../docs/AGENT_INTEGRATION.md) for the fetch-before-parse
verification flow and the [manifest schema](../schemas/anima-agent-manifest-v1.schema.json) for
portable validation outside TypeScript.

## Immutable extension releases

`serialiseExtensionManifest`, `extensionManifestHash`, and `resolveExtensionGraph` implement the
portable `anima.extension-release/1` identity. The validator accepts only the bounded host
capabilities `identity.read`, `state.read`, `state.write`, `transaction.propose`, and
`journal.propose`; verifies canonical resource declarations; and limits resolution to an acyclic
graph of 64 releases at depth 16. These helpers do not fetch archives, execute package code, grant
wallet permission, or imply that an extension registry is deployed.
