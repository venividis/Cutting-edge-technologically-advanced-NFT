import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, parseEther, zeroAddress, maxUint256, encodeFunctionData, pad } from "viem";
import { deployProtocol, mintAgent, shard, expectRevert, AgentStatus, DAY, ZERO32 } from "./helpers.js";
import {
  manifestHash,
  serialiseManifest,
  lockedDownPolicy,
  lzReceiveOptions,
  ShardKind,
  type AgentManifest,
} from "../sdk/src/index.js";

/** Real executor options — the live endpoint rejects the `0x` a mock accepts. */
const LZ_OPTIONS = lzReceiveOptions(300_000n);

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;

/**
 * One agent, from mint to resale, touching every layer. Unit tests prove each contract is
 * correct in isolation; this proves they compose — which is where systems of this size actually
 * fail.
 */
describe("Lifecycle — an agent's whole life", () => {
  it("is born, armed, hired, paid, reviewed, bridged, and sold", async () => {
    const p = await deployProtocol();
    const chainId = await p.publicClient.getChainId();

    /* ---------------- 1. birth: a committed identity and a sealed brain ---------------- */

    const brain = [
      shard("weights", "lora-v3", ShardKind.Weights),
      shard("memory", "empty", ShardKind.Memory),
      shard("prompt", "you are a research agent", ShardKind.SystemPrompt),
    ];
    const agentId = await mintAgent(p, p.alice.account.address, {
      shards: brain,
      modelId: "anthropic/claude-opus-5",
    });

    const manifest: AgentManifest = {
      name: "Atlas",
      description: "Research agent",
      version: "1.0.0",
      anima: {
        registry: `eip155:${chainId}:${p.anima.address}`,
        agentId: agentId.toString(),
        mcp: [{ name: "search", url: "https://atlas.example/mcp", transport: "http" }],
        pricing: { unit: "1k tokens", amount: "1000", token: p.usdc.address },
      },
    };
    await p.anima.write.setManifest([agentId, "https://atlas.example/card.json", manifestHash(manifest)], {
      account: p.alice.account,
    });
    assert.equal(await p.anima.read.verifyManifest([agentId, toHex(serialiseManifest(manifest))]), true);

    /* ---------------- 2. arming: a wallet with a published leash ---------------- */

    await p.anima.write.deployAccount([agentId]);
    const accountAddress = await p.anima.read.accountOf([agentId]);
    const account = await p.viem.getContractAt("AgentAccount", accountAddress);

    await p.anima.write.setPolicy(
      [
        agentId,
        {
          ...lockedDownPolicy(),
          perTxWei: parseEther("0.5"),
          dailyWei: parseEther("1"),
          allowUnlistedTargets: true,
        },
      ],
      { account: p.alice.account }
    );
    await p.anima.write.setGuardian([agentId, p.guardian.account.address], { account: p.alice.account });
    await p.anima.write.setOperator([agentId, p.carol.account.address, true], { account: p.alice.account });
    await account.write.grantSession([p.carol.account.address, 0n, 2n ** 63n, parseEther("2")], {
      account: p.alice.account,
    });
    await p.anima.write.setStatus([agentId, AgentStatus.Active], { account: p.alice.account });

    // Anyone can read the leash before dealing with it.
    const policy = await p.anima.read.policyOf([agentId]);
    assert.equal(policy.perTxWei, parseEther("0.5"));

    /* ---------------- 3. collateral: bounding the maximum lie ---------------- */

    await p.usdc.write.mint([p.alice.account.address, USDC(2000)]);
    await p.usdc.write.approve([p.bonds.address, USDC(2000)], { account: p.alice.account });
    await p.bonds.write.deposit([agentId, USDC(2000)], { account: p.alice.account });
    assert.equal(await p.bonds.read.availableCoverage([agentId]), USDC(2000));

    /* ---------------- 4. hiring: escrowed work with real consequences ---------------- */

    await p.usdc.write.mint([p.bob.account.address, USDC(500)]);
    await p.usdc.write.approve([p.escrow.address, USDC(500)], { account: p.bob.account });

    const now = BigInt(await p.networkHelpers.time.latest());
    await p.escrow.write.offerJob(
      [
        agentId,
        USDC(500),
        USDC(1000),
        now + 3n * DAY,
        BigInt(3600),
        p.validator.account.address,
        keccak256(toHex("find me three sources")),
        "ipfs://spec",
      ],
      { account: p.bob.account }
    );

    // Pledging collateral is the owner's decision alone — an operator may run the agent but
    // not commit its capital.
    await expectRevert(
      p.escrow.write.acceptJob([1n], { account: p.carol.account }),
      "OnlyOwnerMayPledge"
    );
    await p.escrow.write.acceptJob([1n], { account: p.alice.account });
    assert.equal(await p.anima.read.locked([agentId]), true);
    assert.equal(await p.bonds.read.availableCoverage([agentId]), USDC(1000));

    // Mid-job, the agent cannot be sold or bridged out from under its client.
    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, p.deployer.account.address, agentId], {
        account: p.alice.account,
      }),
      "AgentLocked"
    );

    /* ---------------- 5. the agent works, and remembers ---------------- */

    const learned = [brain[0], shard("memory", "three sources on X", ShardKind.Memory), brain[2]];
    await p.anima.write.updateBrain([agentId, learned, 1n], { account: p.carol.account });
    assert.equal(await p.anima.read.brainEpoch([agentId]), 2n);

    await p.escrow.write.deliver([1n, keccak256(toHex("the answer")), "ipfs://delivery"], {
      account: p.carol.account,
    });
    await p.escrow.write.acceptDelivery([1n, 92n, 0, "research", "ipfs://feedback", ZERO32], {
      account: p.bob.account,
    });

    // Paid into its own account, not its owner's wallet.
    assert.equal(await p.usdc.read.balanceOf([accountAddress]), USDC(495)); // 1% fee
    assert.equal(await p.anima.read.locked([agentId]), false);

    const [attestedCount, attestedScore, weight] = await p.reputation.read.getAttestedSummary([
      agentId,
      [],
      "",
      "",
    ]);
    assert.equal(attestedCount, 1n);
    assert.equal(attestedScore, 9200n);
    assert.equal(weight, USDC(500));

    /* ---------------- 6. the agent spends its own earnings ---------------- */

    // Topping up its own bond out of what it earned: an agent that funds itself.
    await account.write.execute(
      [
        p.usdc.address,
        0n,
        encodeFunctionData({ abi: p.usdc.abi, functionName: "approve", args: [p.bonds.address, USDC(495)] }),
        0,
      ],
      { account: p.alice.account }
    );
    await account.write.execute(
      [
        p.bonds.address,
        0n,
        encodeFunctionData({ abi: p.bonds.abi, functionName: "deposit", args: [agentId, USDC(495)] }),
        0,
      ],
      { account: p.alice.account }
    );
    assert.equal(await p.bonds.read.availableCoverage([agentId]), USDC(2495));

    /* ---------------- 7. the guardian stops it ---------------- */

    await p.anima.write.guardianPause([agentId], { account: p.guardian.account });
    await p.alice.sendTransaction({ to: accountAddress, value: parseEther("1") });
    await expectRevert(
      account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account }),
      "AgentNotActive"
    );
    // The owner can still rescue.
    await account.write.execute([p.alice.account.address, parseEther("1"), "0x", 0], {
      account: p.alice.account,
    });
    await p.anima.write.setStatus([agentId, AgentStatus.Active], { account: p.alice.account });

    /* ---------------- 8. it travels, and comes back ---------------- */

    const endpointHome = await p.viem.deployContract("MockLZEndpoint", [30101]);
    const endpointAway = await p.viem.deployContract("MockLZEndpoint", [30184]);
    const home = await p.viem.deployContract("OmniAgentHome", [
      p.anima.address,
      endpointHome.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    const mirror = await p.viem.deployContract("OmniAgentMirror", [
      "ANIMA Mirror",
      "mANIMA",
      endpointAway.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    await home.write.setPeer([30184, pad(mirror.address)]);
    await mirror.write.setPeer([30101, pad(home.address)]);

    const fee = { nativeFee: 10n ** 15n, lzTokenFee: 0n };
    await p.anima.write.approve([home.address, agentId], { account: p.alice.account });
    await home.write.send(
      [30184, pad(p.alice.account.address), agentId, LZ_OPTIONS, fee, p.alice.account.address, false],
      { account: p.alice.account, value: fee.nativeFee }
    );
    await endpointAway.write.deliver([endpointHome.address, 0n, mirror.address, ZERO32]);

    // The replica knows what it represents, and says it is only a replica.
    const replica = await mirror.read.replicaOf([agentId]);
    assert.equal(replica.brainRoot, await p.anima.read.brainRoot([agentId]));
    assert.equal(await mirror.read.verifyManifest([agentId, toHex(serialiseManifest(manifest))]), true);
    assert.equal(await mirror.read.isReplica(), true);

    await mirror.write.send([30101, pad(p.alice.account.address), agentId, LZ_OPTIONS, fee, p.alice.account.address], {
      account: p.alice.account,
      value: fee.nativeFee,
    });
    await endpointHome.write.deliver([endpointAway.address, 0n, home.address, ZERO32]);
    assert.equal(getAddress(await p.anima.read.ownerOf([agentId])), getAddress(p.alice.account.address));

    /* ---------------- 9. it is sold, and the buyer gets what they saw ---------------- */

    const [accountState, root, epoch, coverage] = await p.market.read.currentIntegrity([agentId]);
    const order = {
      kind: 0,
      maker: p.alice.account.address,
      taker: zeroAddress,
      agentId,
      payToken: zeroAddress,
      price: parseEther("5"),
      start: 0n,
      expiry: BigInt(await p.networkHelpers.time.latest()) + 3600n,
      duration: 0n,
      nonce: 7n,
      makerEpoch: 0n,
      expectedAccountState: accountState,
      expectedBrainRoot: root,
      expectedBrainEpoch: epoch,
      minBondCoverage: coverage,
    } as const;

    const types = {
      Order: [
        { name: "kind", type: "uint8" },
        { name: "maker", type: "address" },
        { name: "taker", type: "address" },
        { name: "agentId", type: "uint256" },
        { name: "payToken", type: "address" },
        { name: "price", type: "uint256" },
        { name: "start", type: "uint64" },
        { name: "expiry", type: "uint64" },
        { name: "duration", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "makerEpoch", type: "uint256" },
        { name: "expectedAccountState", type: "uint256" },
        { name: "expectedBrainRoot", type: "bytes32" },
        { name: "expectedBrainEpoch", type: "uint64" },
        { name: "minBondCoverage", type: "uint256" },
      ],
    } as const;
    const domain = {
      name: "AnimaMarket",
      version: "1",
      chainId,
      verifyingContract: p.market.address,
    } as const;

    const signature = await p.alice.signTypedData({ domain, types, primaryType: "Order", message: order });
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });
    await p.market.write.fillOrder([order, signature], {
      account: p.deployer.account,
      value: parseEther("5"),
    });

    /* ---------------- 10. the buyer inherits the asset, not the seller's staff ------------- */

    assert.equal(getAddress(await p.anima.read.ownerOf([agentId])), getAddress(p.deployer.account.address));
    assert.equal(await p.anima.read.isOperator([agentId, p.carol.account.address]), false);
    assert.equal(getAddress(await p.anima.read.guardianOf([agentId])), getAddress(zeroAddress));
    assert.equal(await p.anima.read.statusOf([agentId]), AgentStatus.Paused);
    assert.equal((await p.anima.read.policyOf([agentId])).perTxWei, 0n);

    // The seller's session key is dead outright — not merely blocked by the paused status, but
    // void because it was granted by the previous owner. A buyer must never inherit a live,
    // funded key belonging to the person who just sold them the agent.
    await expectRevert(
      account.write.execute([p.carol.account.address, 1n, "0x", 0], { account: p.carol.account }),
      "SessionNotValid"
    );

    // Even re-arming the agent does not revive it; the buyer must grant their own.
    await p.anima.write.setStatus([agentId, AgentStatus.Active], { account: p.deployer.account });
    await p.anima.write.setPolicy(
      [agentId, { ...lockedDownPolicy(), perTxWei: parseEther("1"), dailyWei: parseEther("1"), allowUnlistedTargets: true }],
      { account: p.deployer.account }
    );
    await expectRevert(
      account.write.execute([p.carol.account.address, 1n, "0x", 0], { account: p.carol.account }),
      "SessionNotValid"
    );

    // The bond, the memory and the earned reputation all came with it.
    assert.equal(await p.bonds.read.availableCoverage([agentId]), USDC(2495));
    assert.equal(await p.anima.read.brainRoot([agentId]), root);
    const [countAfter] = await p.reputation.read.getAttestedSummary([agentId, [], "", ""]);
    assert.equal(countAfter, 1n);
  });
});
