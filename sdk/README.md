# `@anima/sdk`

Typed ESM helpers for reproducing ANIMA's Solidity commitments off-chain. The package covers
manifest canonicalization, brain and inference-receipt roots, private-envelope hashes, audit-log
replay, policies, marketplace typed data, and immutable-diamond construction.

The package is not claimed to be published on npm yet. Build or pack it from the repository:

```bash
npm install
npm run sdk:build
npm pack ./sdk
```

Then install the emitted tarball in a consumer project. Node.js 20 or newer and `viem` are required.

```ts
import { manifestHash, serialiseManifest, type AgentManifest } from "@anima/sdk";

const manifest: AgentManifest = {
  name: "Atlas",
  description: "Example research agent",
  version: "1.0.0",
  anima: {
    registry: "eip155:84532:0x0aeb6f783ebade8fd5ffca74317266d4ea3e71b3",
    agentId: "2",
  },
};

const exactBytesToPublish = serialiseManifest(manifest);
const onChainCommitment = manifestHash(manifest);
```

See the [agent integration guide](../docs/AGENT_INTEGRATION.md) for the fetch-before-parse
verification flow and the [manifest schema](../schemas/anima-agent-manifest-v1.schema.json) for
portable validation outside TypeScript.
