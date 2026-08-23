import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, parseAbi, parseEther } from "viem";
import {
  brainRoot as sdkBrainRoot,
  workRoot as sdkWorkRoot,
  replayAuditLog,
  manifestHash,
  serialiseManifest,
  lockedDownPolicy,
  handleKey as sdkHandleKey,
  canonicalise,
  deriveFacetCut,
  cutIsImmutable,
  DIAMOND_CUT_SELECTOR,
  lzReceiveOptions,
  ShardKind,
  type AgentManifest,
} from "../sdk/src/index.js";
import { deployProtocol, mintAgent, shard, AgentStatus, ZERO32 } from "./helpers.js";

/**
 * The SDK is the reference implementation of ANIMA's off-chain hashing rules. If it drifts from
 * the Solidity by one byte, every commitment the protocol makes becomes unverifiable — so the
 * agreement is asserted here rather than assumed.
 */
describe("SDK — agreement with the contracts", () => {
  it("derives the same brain root as BrainLib", async () => {
    const p = await deployProtocol();
    const shards = [
      shard("weights", "lora-adapter-v3", ShardKind.Weights),
      shard("memory", "18 months of conversations", ShardKind.Memory),
      shard("tools", "mcp servers", ShardKind.Tools),
    ];
    const id = await mintAgent(p, p.alice.account.address, { shards });
    assert.equal(await p.anima.read.brainRoot([id]), sdkBrainRoot(shards));
  });

  it("derives the same work root as InferenceMeter", async () => {
    const p = await deployProtocol();
    const receipts = [
      {
        requestHash: keccak256(toHex("what is the price of ETH")),
        responseHash: keccak256(toHex("$4,210")),
        modelHash: keccak256(toHex("claude-opus-5")),
        units: 1420n,
        attestationKind: 2,
        attestation: keccak256(toHex("tdx-quote")),
      },
      {
        requestHash: keccak256(toHex("summarise this")),
        responseHash: keccak256(toHex("...")),
        modelHash: keccak256(toHex("claude-opus-5")),
        units: 8300n,
        attestationKind: 0,
        attestation: ZERO32,
      },
    ];
    assert.equal(await p.meter.read.workRootOf([receipts]), sdkWorkRoot(receipts));
  });

  it("replays an agent's audit log to the exact on-chain root", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    const accountAddress = await p.anima.read.accountOf([id]);
    const account = await p.viem.getContractAt("AgentAccount", accountAddress);

    await p.anima.write.setPolicy(
      [id, { ...lockedDownPolicy(), perTxWei: parseEther("1"), dailyWei: parseEther("5"), allowUnlistedTargets: true }],
      { account: p.alice.account }
    );
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
    await account.write.grantSession([p.carol.account.address, 0n, 2n ** 63n, parseEther("5")], {
      account: p.alice.account,
    });
    await p.alice.sendTransaction({ to: accountAddress, value: parseEther("3") });

    // Three calls the agent made while its previous owner held it.
    for (const value of [parseEther("0.1"), parseEther("0.2"), parseEther("0.3")]) {
      await account.write.execute([p.bob.account.address, value, "0x", 0], { account: p.carol.account });
    }

    const logs = await p.publicClient.getContractEvents({
      address: accountAddress,
      abi: account.abi,
      eventName: "AuditEntry",
      fromBlock: 0n,
    });
    assert.equal(logs.length, 3);

    const entries = [];
    for (const log of logs) {
      const block = await p.publicClient.getBlock({ blockNumber: log.blockNumber });
      const a = log.args as Record<string, unknown>;
      entries.push({
        signer: a.signer as `0x${string}`,
        to: a.to as `0x${string}`,
        value: a.value as bigint,
        selector: a.selector as `0x${string}`,
        dataHash: a.dataHash as `0x${string}`,
        operation: 0,
        state: a.state as bigint,
        timestamp: block.timestamp,
      });
    }

    const replayed = replayAuditLog(accountAddress, BigInt(await p.publicClient.getChainId()), entries);
    assert.equal(
      replayed,
      await account.read.auditRoot(),
      "a buyer must be able to verify the history they were handed"
    );

    // Drop the middle entry, as a seller hiding something would: the chain must not close.
    const pruned = replayAuditLog(accountAddress, BigInt(await p.publicClient.getChainId()), [
      entries[0],
      entries[2],
    ]);
    assert.notEqual(pruned, await account.read.auditRoot());
  });

  it("produces a manifest hash the contract accepts", async () => {
    const p = await deployProtocol();
    const manifest: AgentManifest = {
      name: "Atlas",
      description: "A research agent",
      version: "1.0.0",
      skills: [{ id: "research", name: "Research", description: "Finds and synthesises sources" }],
      anima: {
        registry: `eip155:${await p.publicClient.getChainId()}:${p.anima.address}`,
        agentId: "1",
        mcp: [{ name: "search", url: "https://atlas.example/mcp", transport: "http" }],
        model: { modelId: "anthropic/claude-opus-5", weightsRoot: ZERO32, attestationKind: 1 },
      },
    };

    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setManifest([id, "https://atlas.example/card.json", manifestHash(manifest)], {
      account: p.alice.account,
    });

    const served = serialiseManifest(manifest);
    assert.equal(await p.anima.read.verifyManifest([id, toHex(served)]), true);

    // Key order must not matter to the producer, because canonicalisation sorts.
    const reordered: AgentManifest = { ...manifest, description: manifest.description };
    assert.equal(manifestHash(reordered), manifestHash(manifest));

    // But a changed endpoint must not validate.
    const swapped = structuredClone(manifest);
    swapped.anima.mcp![0].url = "https://evil.example/mcp";
    assert.equal(await p.anima.read.verifyManifest([id, toHex(serialiseManifest(swapped))]), false);
  });
});

describe("SDK — handle keys", () => {
  it("derives the same handle key as AgentHandles", async () => {
    const p = await deployProtocol();
    const handles = await p.viem.deployContract("AgentHandles", [
      p.anima.address,
      p.deployer.account.address,
    ]);
    for (const [name, kind] of [
      ["email", 0],
      ["meshPeer", 5],
    ] as const) {
      assert.equal(
        await handles.read.handleKey([kind, "atlas.agents.example"]),
        sdkHandleKey(name, "atlas.agents.example")
      );
    }
  });
});

describe("SDK — canonicalisation", () => {
  it("is stable under key reordering, as RFC 8785 requires", async () => {
    const a = { b: 1, a: { z: [3, 2], y: "x" } };
    const b = { a: { y: "x", z: [3, 2] }, b: 1 };
    assert.equal(canonicalise(a), canonicalise(b));
    assert.equal(canonicalise(a), '{"a":{"y":"x","z":[3,2]},"b":1}');
  });

  it("preserves array order, which is significant", async () => {
    assert.notEqual(canonicalise({ a: [1, 2] }), canonicalise({ a: [2, 1] }));
  });

  it("refuses values that would silently produce an unverifiable commitment", async () => {
    // JSON.stringify turns these into null, quietly changing the document that was signed.
    assert.throws(() => canonicalise({ a: NaN }), /no encoding/);
    assert.throws(() => canonicalise({ a: Infinity }), /no encoding/);
    // A lone surrogate has no well-defined UTF-8 encoding.
    assert.throws(() => canonicalise({ a: "\ud800" }), /surrogate/);
  });

  it("drops undefined rather than emitting it, matching A2A's default-value rule", async () => {
    assert.equal(canonicalise({ a: 1, b: undefined }), '{"a":1}');
  });
});

describe("SDK — deriving an EIP-2535 cut", () => {
  // Facets that share a base all carry the shared surface in their ABI, so the fixtures below
  // mirror that: `base` holds ERC-721's ownerOf, and every other facet repeats it.
  const shared = parseAbi(["function ownerOf(uint256) view returns (address)"]);
  const base = {
    name: "core",
    address: "0x0000000000000000000000000000000000000001" as const,
    abi: [...shared, ...parseAbi(["function totalMinted() view returns (uint256)"])],
  };
  const agent = {
    name: "agent",
    address: "0x0000000000000000000000000000000000000002" as const,
    abi: [...shared, ...parseAbi(["function statusOf(uint256) view returns (uint8)"])],
  };
  const loupe = {
    name: "loupe",
    address: "0x0000000000000000000000000000000000000003" as const,
    abi: parseAbi(["function facetAddresses() view returns (address[])"]),
  };
  const tokenAbi = [...base.abi, ...parseAbi(["function statusOf(uint256) view returns (uint8)"])];

  it("partitions the token's ABI, giving the base whatever nobody else claims", async () => {
    const cut = deriveFacetCut({ tokenAbi, base, specialised: [agent], additional: [loupe] });

    assert.deepEqual(
      cut.map((c) => [c.facetAddress, c.functionSelectors.length]),
      [
        [base.address, 2],
        [agent.address, 1],
        [loupe.address, 1],
      ]
    );
    const routed = cut.flatMap((c) => c.functionSelectors);
    assert.equal(new Set(routed).size, routed.length);
    assert.equal(cutIsImmutable(cut), true);
  });

  it("refuses a cut that would leave a token function unrouted", async () => {
    // The hazard this exists to prevent: welding the diamond shut around a missing function.
    assert.throws(
      () =>
        deriveFacetCut({
          tokenAbi: [...tokenAbi, ...parseAbi(["function brainRoot(uint256) view returns (bytes32)"])],
          base,
          specialised: [agent],
        }),
      /cannot serve/
    );
  });

  it("refuses a facet routing something the token never declared", async () => {
    assert.throws(
      () =>
        deriveFacetCut({
          tokenAbi,
          base,
          specialised: [
            { ...agent, abi: [...agent.abi, ...parseAbi(["function selfDestructPlease() external"])] },
          ],
        }),
      /does not declare/
    );
  });

  it("refuses two facets claiming one selector rather than silently preferring one", async () => {
    assert.throws(
      () => deriveFacetCut({ tokenAbi, base, specialised: [agent, { ...agent, name: "twin" }] }),
      /claimed by both/
    );
  });

  it("refuses an additional facet that collides with the token's own ABI", async () => {
    assert.throws(
      () =>
        deriveFacetCut({
          tokenAbi,
          base,
          specialised: [agent],
          additional: [{ ...loupe, abi: parseAbi(["function totalMinted() view returns (uint256)"]) }],
        }),
      /collides/
    );
  });

  it("knows the diamondCut selector EIP-2535 publishes, and calls a cut containing it mutable", async () => {
    assert.equal(
      DIAMOND_CUT_SELECTOR,
      keccak256(toHex("diamondCut((address,uint8,bytes4[])[],address,bytes)")).slice(0, 10)
    );
    assert.equal(
      cutIsImmutable([{ facetAddress: base.address, action: 0, functionSelectors: [DIAMOND_CUT_SELECTOR] }]),
      false
    );
  });
});

describe("SDK — LayerZero executor options", () => {
  it("builds the exact bytes LayerZero's own OptionsBuilder produces", async () => {
    // TYPE_3 | WORKER_ID 1 | length 0x0011 (16-byte gas + 1 type byte) | OPTION_TYPE_LZRECEIVE | gas
    assert.equal(lzReceiveOptions(300_000n), "0x000301001101000000000000000000000000000493e0");
    assert.equal(lzReceiveOptions(200_000n), "0x00030100110100000000000000000000000000030d40");

    // With a native drop the option grows by another uint128 and the length follows it.
    assert.equal(
      lzReceiveOptions(300_000n, 1n),
      "0x0003010021010000000000000000000000000004" + "93e0" + "00000000000000000000000000000001"
    );
  });

  it("never emits the empty options a mock endpoint would accept", async () => {
    // Quoting `0x` against Base Sepolia's live message library reverts. The value of this test is
    // that it fails loudly if anyone ever "simplifies" the builder back to a passthrough.
    assert.notEqual(lzReceiveOptions(300_000n), "0x");
    assert.ok(lzReceiveOptions(300_000n).startsWith("0x0003"), "must be a Type-3 options container");
  });
});
