import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, pad, toFunctionSelector, zeroAddress } from "viem";
import { deployProtocol, mintAgent, shard, model, expectRevert, DAY, SealPolicy, AgentStatus } from "./helpers.js";

/**
 * The diamond exists to remove EIP-170's ceiling without acquiring an admin who can rewrite
 * an agent's rules after you have bought it. Two claims follow from that, and this file tests
 * both:
 *
 *   1. It is the same token. The other fourteen test files are the real proof — every one of
 *      them runs unmodified against this build under `npm run test:diamond`. What is added
 *      here is the direct comparison: the same script of operations applied to both builds
 *      must produce the same ERC-5646 fingerprint, which is a single hash over the whole of
 *      an agent's mutable state.
 *   2. It cannot be changed. No `diamondCut` selector is routed, no facet exposes one, and
 *      the initialiser is unreachable after construction.
 */

/** Deterministic so the two builds are compared at the same block timestamp. */
const PINNED = 2_000_000_000;

const INTERFACE_IDS = {
  "ERC-165": "0x01ffc9a7",
  "ERC-721": "0x80ac58cd",
  "ERC-721Metadata": "0x5b5e139f",
  "ERC-2981": "0x2a55205a",
  "ERC-4906": "0x49064906",
  "ERC-4907": "0xad092b5c",
  "ERC-5192": "0xb45a3c0e",
  "ERC-6454": "0x91a6262f",
  "ERC-7572": "0xe8a3d485",
  "ERC-5646": "0xf5112315",
  unsupported: "0xffffffff",
} as const;

const DIAMOND_LOUPE_ID = "0x48e2b093" as const;

const DIAMOND_CUT_SELECTOR = toFunctionSelector(
  "function diamondCut((address,uint8,bytes4[])[],address,bytes)"
);

/**
 * Drives an agent through every kind of state change the fingerprint covers, then reports
 * what the contract says about it. Run against both builds, the two reports must be equal.
 */
async function exercise(impl: "monolith" | "diamond") {
  const p = await deployProtocol({ impl });
  await p.networkHelpers.time.setNextBlockTimestamp(PINNED);

  const shards = [shard("memory", "the-same-bytes"), shard("prompt", "the-same-persona", 2)];
  const id = await mintAgent(p, p.alice.account.address, {
    uri: "https://agents.example/equivalence.json",
    manifest: "manifest-bytes",
    shards,
    seal: SealPolicy.Committed,
    modelId: "anthropic/claude-opus-5",
  });
  const alice = { account: p.alice.account };

  await p.anima.write.declareModel([id, model("anthropic/claude-opus-5", "weights-v2")], alice);
  await p.anima.write.setGuardian([id, p.guardian.account.address], alice);
  await p.anima.write.setPolicy(
    [
      id,
      {
        perTxWei: 10n ** 17n,
        dailyWei: 10n ** 18n,
        expiry: BigInt(PINNED) + 90n * DAY,
        allowDelegateCall: false,
        allowUnlistedTargets: false,
        targetsRoot: "0x" + "11".repeat(32),
      },
    ],
    alice
  );
  await p.anima.write.setOperator([id, p.bob.account.address, true], alice);
  await p.anima.write.setUser([id, p.carol.account.address, BigInt(PINNED) + 30n * DAY], alice);
  await p.anima.write.setStatus([id, AgentStatus.Active], alice);
  await p.anima.write.updateBrain([id, [shard("memory", "learned-something-new")], 1n], alice);
  await p.anima.write.setMetadata([id, "endpoint", "0xdeadbeef"], alice);

  const [uri, manifestHash, version] = await p.anima.read.manifestOf([id]);

  return {
    p,
    id,
    report: {
      fingerprint: await p.anima.read.getStateFingerprint([id]),
      owner: await p.anima.read.ownerOf([id]),
      uri,
      manifestHash,
      version,
      tokenURI: await p.anima.read.tokenURI([id]),
      brainRoot: await p.anima.read.brainRoot([id]),
      brainEpoch: await p.anima.read.brainEpoch([id]),
      seal: await p.anima.read.sealPolicyOf([id]),
      status: await p.anima.read.statusOf([id]),
      guardian: await p.anima.read.guardianOf([id]),
      user: await p.anima.read.userOf([id]),
      userExpires: await p.anima.read.userExpires([id]),
      isOperator: await p.anima.read.isOperator([id, p.bob.account.address]),
      model: await p.anima.read.modelOf([id]),
      policy: await p.anima.read.policyOf([id]),
      metadata: await p.anima.read.getMetadata([id, "endpoint"]),
      locked: await p.anima.read.locked([id]),
      totalMinted: await p.anima.read.totalMinted(),
      name: await p.anima.read.name(),
      symbol: await p.anima.read.symbol(),
      royalty: await p.anima.read.royaltyInfo([id, 10_000n]),
      brain: await p.anima.read.brainOf([id]),
    },
  };
}

describe("AnimaDiamond — the same token, assembled from facets", () => {
  it("produces the identical ERC-5646 fingerprint for an identically-lived agent", async () => {
    const monolith = await exercise("monolith");
    const diamond = await exercise("diamond");

    // The fingerprint is one keccak over the packed core struct, the declared weights root,
    // the bound wallet, the lease, the policy and the account nonce. If any field had moved,
    // been re-ordered, or been written differently by a facet, these would differ.
    assert.equal(
      diamond.report.fingerprint,
      monolith.report.fingerprint,
      "diamond and monolith disagree about the state of an identically-lived agent"
    );
    assert.deepEqual(diamond.report, monolith.report);
  });

  it("answers ERC-165 exactly as the monolith does, plus the loupe it genuinely implements", async () => {
    const mono = await deployProtocol({ impl: "monolith" });
    const dia = await deployProtocol({ impl: "diamond" });

    for (const [name, id] of Object.entries(INTERFACE_IDS)) {
      assert.equal(
        await dia.anima.read.supportsInterface([id]),
        await mono.anima.read.supportsInterface([id]),
        `${name} (${id}) disagrees between builds`
      );
    }
    assert.equal(await mono.anima.read.supportsInterface([DIAMOND_LOUPE_ID]), false);
    assert.equal(await dia.anima.read.supportsInterface([DIAMOND_LOUPE_ID]), true);
  });

  it("reports the same EIP-712 domain, so a wallet-binding signature means the same thing", async () => {
    const mono = await deployProtocol({ impl: "monolith" });
    const dia = await deployProtocol({ impl: "diamond" });
    const m = await mono.anima.read.eip712Domain();
    const d = await dia.anima.read.eip712Domain();

    assert.deepEqual([d[0], d[1], d[2], d[3], d[5], d[6]], [m[0], m[1], m[2], m[3], m[5], m[6]]);
    // Field 4 is `verifyingContract`, which is each build's own address — necessarily
    // different, and necessarily so: a signature for one must not replay against the other.
    assert.equal(getAddress(d[4]), getAddress(dia.anima.address));
    assert.notEqual(getAddress(d[4]), getAddress(m[4]));
  });
});

describe("AnimaDiamond — the routing table", () => {
  it("partitions the monolith's ABI: every function routed, exactly once", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { selectors, loupe } = p.diamond!;

    const routed = [...selectors.core, ...selectors.agent, ...selectors.brain];
    assert.equal(new Set(routed).size, routed.length, "a selector was assigned to two facets");

    for (const selector of routed) {
      assert.notEqual(
        await loupe.read.facetAddress([selector]),
        zeroAddress,
        `${selector} is in the ABI but resolves to no facet`
      );
    }

    const facets = await loupe.read.facets();
    assert.equal(facets.length, 4);
    const flattened = facets.flatMap((f: { functionSelectors: string[] }) => f.functionSelectors);
    assert.equal(flattened.length, routed.length + 4, "loupe's own four selectors are unaccounted for");
    assert.equal(new Set(flattened).size, flattened.length);
  });

  it("resolves each selector to the facet the loupe says holds it", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { loupe, facets } = p.diamond!;

    for (const [name, address] of Object.entries(facets)) {
      const held = await loupe.read.facetFunctionSelectors([address]);
      assert.ok(held.length > 0, `${name} facet holds nothing`);
      for (const selector of held) {
        assert.equal(getAddress(await loupe.read.facetAddress([selector])), getAddress(address));
      }
    }
    assert.deepEqual(
      (await loupe.read.facetAddresses()).map(getAddress).sort(),
      Object.values(facets).map(getAddress).sort()
    );
  });

  it("keeps the two ERC-7201 namespaces where it claims they are, and slot 0 empty", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const address = p.diamond!.address;

    // Nothing may occupy the compiler-assigned slots: that is the whole point of ERC-7201,
    // and a facet that forgot and declared a plain state variable would land right here.
    for (const slot of [0n, 1n, 2n]) {
      assert.equal(
        await p.publicClient.getStorageAt({ address, slot: pad(`0x${slot.toString(16)}`) }),
        `0x${"00".repeat(32)}`
      );
    }

    // anima.storage.core field 0 is the ERC-6551 registry, written once by the initialiser.
    const animaSlot = "0x2134dd8a40292237c0a0658c1368c4805ba84a926576fc8c56170c3a72e5a700";
    const raw = await p.publicClient.getStorageAt({ address, slot: animaSlot });
    assert.equal(getAddress(`0x${raw!.slice(-40)}`), getAddress(p.registry.address));
  });
});

describe("AnimaDiamond — immutability", () => {
  it("routes no diamondCut, on the diamond or on any facet", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { loupe, facets } = p.diamond!;

    assert.equal(await loupe.read.facetAddress([DIAMOND_CUT_SELECTOR]), zeroAddress);

    // Not merely unrouted — absent. If a facet held one, a future deployment of the same
    // facets could wire it in, and the immutability claim would be about this deployment
    // rather than about the code.
    for (const [name, address] of Object.entries(facets)) {
      const code = await p.publicClient.getCode({ address: address as `0x${string}` });
      assert.ok(
        !code!.includes(DIAMOND_CUT_SELECTOR.slice(2)),
        `${name} facet contains the diamondCut selector`
      );
    }
  });

  it("rejects a call to a function it does not have, rather than silently succeeding", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    await expectRevert(
      p.publicClient.call({ to: p.diamond!.address, data: "0xdeadbeef" }),
      "FunctionNotFound"
    );
  });

  it("refuses a bare ETH transfer, exactly as the monolith does", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    await expectRevert(
      p.deployer.sendTransaction({ to: p.diamond!.address, value: 10n ** 15n }),
      "FunctionNotFound"
    );
  });

  it("leaves the initialiser unreachable once construction is over", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const init = await p.viem.getContractAt("AnimaInit", p.diamond!.address);

    // Two independent guards, either of which would be sufficient: the selector was never
    // routed, so the fallback rejects it before `initializer` is ever consulted.
    await expectRevert(
      init.write.init([
        "Hijacked",
        "HIJ",
        p.bob.account.address,
        p.registry.address,
        p.accountImpl.address,
        "0x" + "00".repeat(32),
        p.nullVerifier.address,
        p.keyRegistry.address,
        p.bob.account.address,
        0n,
      ]),
      "FunctionNotFound"
    );
    assert.equal(getAddress(await p.anima.read.owner()), getAddress(p.deployer.account.address));
  });

  it("is unaffected by anyone initialising the deployed initialiser directly", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const standalone = await p.viem.getContractAt("AnimaInit", p.diamond!.init);

    await standalone.write.init(
      [
        "Someone Else's Token",
        "NOPE",
        p.bob.account.address,
        p.registry.address,
        p.accountImpl.address,
        "0x" + "00".repeat(32),
        p.nullVerifier.address,
        p.keyRegistry.address,
        p.bob.account.address,
        0n,
      ],
      { account: p.bob.account }
    );

    // It wrote to its own storage, which no diamond reads.
    assert.equal(await p.anima.read.name(), "ANIMA Agents");
    assert.equal(getAddress(await p.anima.read.owner()), getAddress(p.deployer.account.address));
  });

  it("holds facets that are inert when called directly", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const core = await p.viem.getContractAt("AnimaCoreFacet", p.diamond!.facets.core);
    const brain = await p.viem.getContractAt("AnimaBrainFacet", p.diamond!.facets.brain);

    // A facet's own storage has no owner, so administration reverts rather than taking hold.
    await expectRevert(core.write.setModule([p.bob.account.address, true]), "OwnableUnauthorizedAccount");

    // Minting against a facet mints in the facet's own ledger and changes nothing here.
    await brain.write.mintAgent([
      p.bob.account.address,
      "https://elsewhere.example/1.json",
      "0x" + "00".repeat(32),
      { weightsRoot: "0x" + "00".repeat(32), runtimeMeasurement: "0x" + "00".repeat(32), attestationKind: 0, modelId: "" },
      [],
      SealPolicy.None,
      [],
    ]);
    assert.equal(await p.anima.read.totalMinted(), 0n);
  });
});

describe("AnimaDiamond — construction", () => {
  it("refuses two facets claiming the same selector instead of picking one", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { core, agent } = p.diamond!.facets;
    const selector = toFunctionSelector("function totalMinted() view returns (uint256)");

    await expectRevert(
      p.viem.deployContract("AnimaDiamond", [
        [
          { facetAddress: core, action: 0, functionSelectors: [selector] },
          { facetAddress: agent, action: 0, functionSelectors: [selector] },
        ],
        zeroAddress,
        "0x",
      ]),
      "SelectorAlreadyBound"
    );
  });

  it("refuses anything but an addition, and refuses a facet with no code", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { core } = p.diamond!.facets;
    const selector = toFunctionSelector("function totalMinted() view returns (uint256)");

    await expectRevert(
      p.viem.deployContract("AnimaDiamond", [
        [{ facetAddress: core, action: 1, functionSelectors: [selector] }],
        zeroAddress,
        "0x",
      ]),
      "NotAnAddition"
    );
    await expectRevert(
      p.viem.deployContract("AnimaDiamond", [
        [{ facetAddress: p.bob.account.address, action: 0, functionSelectors: [selector] }],
        zeroAddress,
        "0x",
      ]),
      "FacetHasNoCode"
    );
  });

  it("bubbles up an initialiser revert rather than deploying a half-built diamond", async () => {
    const p = await deployProtocol({ impl: "diamond" });
    const { core } = p.diamond!.facets;
    const init = await p.viem.getContractAt("AnimaInit", p.diamond!.init);
    const cut = [
      {
        facetAddress: core,
        action: 0,
        functionSelectors: [toFunctionSelector("function totalMinted() view returns (uint256)")],
      },
    ];

    // A real initialiser call that fails its own checks: the reason reaches the deployer
    // intact, instead of the deployment quietly succeeding with an uninitialised diamond.
    await expectRevert(
      p.viem.deployContract("AnimaDiamond", [
        cut,
        p.diamond!.init,
        encodeFunctionData({
          abi: init.abi,
          functionName: "init",
          args: [
            "Broken",
            "BRK",
            p.deployer.account.address,
            zeroAddress, // no ERC-6551 registry
            p.accountImpl.address,
            `0x${"00".repeat(32)}`,
            p.nullVerifier.address,
            p.keyRegistry.address,
            zeroAddress,
            0n,
          ],
        }),
      ]),
      "ZeroAddress"
    );

    // And when the callee reverts with nothing to say — here, calldata matching no function
    // on a contract with no fallback — the diamond supplies its own reason rather than
    // reporting a success it cannot vouch for.
    await expectRevert(
      p.viem.deployContract("AnimaDiamond", [cut, p.diamond!.init, "0xdeadbeef"]),
      "InitializationFailed"
    );
  });
});
