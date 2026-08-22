import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, parseEther, keccak256, toHex, zeroAddress, maxUint256, encodeFunctionData } from "viem";
import { deployProtocol, mintAgent, expectRevert, shard, AgentStatus, ZERO32 } from "./helpers.js";

const SKIP = maxUint256;

async function signedOrder(
  p: Awaited<ReturnType<typeof deployProtocol>>,
  overrides: Record<string, unknown> = {}
) {
  const now = BigInt(await p.networkHelpers.time.latest());
  const order = {
    kind: 0,
    maker: p.alice.account.address,
    taker: zeroAddress,
    agentId: 1n,
    payToken: zeroAddress,
    price: parseEther("1"),
    start: 0n,
    expiry: now + 3600n,
    duration: 0n,
    nonce: 1n,
    expectedAccountState: SKIP,
    expectedBrainRoot: ZERO32,
    expectedBrainEpoch: 0n,
    minBondCoverage: 0n,
    ...overrides,
  } as const;

  const signature = await p.alice.signTypedData({
    domain: {
      name: "AnimaMarket",
      version: "1",
      chainId: await p.publicClient.getChainId(),
      verifyingContract: p.market.address,
    },
    types: {
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
        { name: "expectedAccountState", type: "uint256" },
        { name: "expectedBrainRoot", type: "bytes32" },
        { name: "expectedBrainEpoch", type: "uint64" },
        { name: "minBondCoverage", type: "uint256" },
      ],
    },
    primaryType: "Order",
    message: order,
  });

  return { order, signature };
}

describe("AgentMarket — settlement", () => {
  it("fills a sale, splitting protocol fee and declared royalty", async () => {
    const p = await deployProtocol();
    await mintAgent(p, p.alice.account.address);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });

    const { order, signature } = await signedOrder(p);
    const makerBefore = await p.publicClient.getBalance({ address: p.alice.account.address });

    await p.market.write.fillOrder([order, signature, 0n], {
      account: p.bob.account,
      value: parseEther("1"),
    });

    assert.equal(getAddress(await p.anima.read.ownerOf([1n])), getAddress(p.bob.account.address));
    const makerAfter = await p.publicClient.getBalance({ address: p.alice.account.address });
    // 2.5% market fee + 5% royalty, both to the treasury account in this fixture.
    assert.equal(makerAfter - makerBefore, parseEther("0.925"));
  });

  it("rejects a replayed order", async () => {
    const p = await deployProtocol();
    await mintAgent(p, p.alice.account.address);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });
    const { order, signature } = await signedOrder(p);

    await p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") });
    await p.anima.write.transferFrom([p.bob.account.address, p.alice.account.address, 1n], {
      account: p.bob.account,
    });
    await expectRevert(
      p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") }),
      "OrderAlreadySettled"
    );
  });

  it("lets a maker invalidate every order they ever signed", async () => {
    const p = await deployProtocol();
    await mintAgent(p, p.alice.account.address);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });
    const { order, signature } = await signedOrder(p);

    await p.market.write.bumpMakerEpoch([], { account: p.alice.account });
    await expectRevert(
      p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") }),
      "OrderAlreadySettled"
    );
    // The taker must pass the epoch they priced against, so a bump cannot be used to
    // front-run a fill that was already in flight at the old epoch.
    await p.market.write.fillOrder([order, signature, 1n], {
      account: p.bob.account,
      value: parseEther("1"),
    });
  });

  it("rejects a forged signature", async () => {
    const p = await deployProtocol();
    await mintAgent(p, p.alice.account.address);
    const { order } = await signedOrder(p);
    const forged = await p.bob.signTypedData({
      domain: {
        name: "AnimaMarket",
        version: "1",
        chainId: await p.publicClient.getChainId(),
        verifyingContract: p.market.address,
      },
      types: {
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
          { name: "expectedAccountState", type: "uint256" },
          { name: "expectedBrainRoot", type: "bytes32" },
          { name: "expectedBrainEpoch", type: "uint64" },
          { name: "minBondCoverage", type: "uint256" },
        ],
      },
      primaryType: "Order",
      message: order,
    });
    await expectRevert(
      p.market.write.fillOrder([order, forged, 0n], { account: p.bob.account, value: parseEther("1") }),
      "BadSignature"
    );
  });
});

describe("AgentMarket — orders bind to the agent's substance", () => {
  it("reverts when the seller drained the bound account after quoting", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });

    const accountAddress = await p.anima.read.accountOf([id]);
    await p.alice.sendTransaction({ to: accountAddress, value: parseEther("3") });

    const [accountState] = await p.market.read.currentIntegrity([id]);
    const { order, signature } = await signedOrder(p, { expectedAccountState: accountState });

    // The seller empties the wallet the buyer is paying for.
    const account = await p.viem.getContractAt("AgentAccount", accountAddress);
    await account.write.execute([p.alice.account.address, parseEther("3"), "0x", 0], {
      account: p.alice.account,
    });

    await expectRevert(
      p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") }),
      "AgentStateChanged"
    );
  });

  it("fills when the bound account is untouched", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });

    const [accountState] = await p.market.read.currentIntegrity([id]);
    const { order, signature } = await signedOrder(p, { expectedAccountState: accountState });
    await p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") });
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.bob.account.address));
  });

  it("reverts when the seller wipes the agent's memory after quoting", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, { shards: [shard("memory", "years of work")] });
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });

    const [, root, epoch] = await p.market.read.currentIntegrity([id]);
    const { order, signature } = await signedOrder(p, {
      expectedBrainRoot: root,
      expectedBrainEpoch: epoch,
    });

    await p.anima.write.updateBrain([id, [shard("memory", "wiped")], epoch], { account: p.alice.account });

    await expectRevert(
      p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") }),
      "BrainChanged"
    );
  });

  it("reverts when the bond a buyer is paying for is already on its way out", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setApprovalForAll([p.market.address, true], { account: p.alice.account });

    await p.usdc.write.mint([p.alice.account.address, 1000n]);
    await p.usdc.write.approve([p.bonds.address, 1000n], { account: p.alice.account });
    await p.bonds.write.deposit([id, 1000n], { account: p.alice.account });

    const { order, signature } = await signedOrder(p, { minBondCoverage: 1000n });

    await p.bonds.write.requestUnbond([id, 1000n], { account: p.alice.account });

    await expectRevert(
      p.market.write.fillOrder([order, signature, 0n], { account: p.bob.account, value: parseEther("1") }),
      "InsufficientCoverage"
    );
  });
});

describe("AgentMarket — rental", () => {
  it("grants the tenant control and locks the agent for the term", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const { order, signature } = await signedOrder(p, { kind: 1, duration: 3600n, price: parseEther("0.1") });

    await p.market.write.fillOrder([order, signature, 0n], {
      account: p.bob.account,
      value: parseEther("0.1"),
    });

    assert.equal(getAddress(await p.anima.read.userOf([id])), getAddress(p.bob.account.address));
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));
    assert.equal(await p.anima.read.isController([id, p.bob.account.address]), true);

    // The lessor cannot sell the agent out from under a paying tenant.
    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, p.carol.account.address, id], {
        account: p.alice.account,
      }),
      "AgentLocked"
    );
  });

  it("returns control to the owner when the term ends", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const { order, signature } = await signedOrder(p, { kind: 1, duration: 3600n, price: parseEther("0.1") });
    await p.market.write.fillOrder([order, signature, 0n], {
      account: p.bob.account,
      value: parseEther("0.1"),
    });

    await expectRevert(p.market.write.endRental([id]), "RentalStillActive");
    await p.networkHelpers.time.increase(3601);
    // Permissionless: the owner should not need the tenant's cooperation to get it back.
    await p.market.write.endRental([id], { account: p.carol.account });

    assert.equal(getAddress(await p.anima.read.userOf([id])), getAddress(zeroAddress));
    assert.equal(await p.anima.read.locked([id]), false);
  });
});
