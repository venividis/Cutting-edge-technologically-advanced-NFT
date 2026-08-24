import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData, getAddress, keccak256, toHex, pad, parseEther, zeroAddress,
} from "viem";
import {
  deployProtocol, mintAgent, shard, expectRevert, AgentStatus, DAY, ZERO32, type Protocol,
} from "./helpers.js";
import { SKIP_STATE_CHECK, ORDER_TYPES, orderDomain } from "../sdk/src/index.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;
const HOUR = 3600n;

/**
 * Agents transacting with agents.
 *
 * Every other test — and both live-chain scenarios — has a human EOA on one side of every
 * transaction. That is the easy half. The protocol's actual thesis is an *economy* of agents:
 * an agent's ERC-6551 wallet hiring another agent, paying another agent, owning another agent.
 * Those paths cross contract boundaries in combinations no single-contract test reaches, and
 * the first draft of this file caught a real one: the escrow's self-hire guard compared the
 * client only to the *transaction sender*, so an agent could hire itself through its own wallet
 * and mint attested reputation out of its own money.
 *
 * Cast: Alice owns Atlas (a worker) and Cargo (an agent that will be bought by another agent).
 * Bob owns Beacon, whose wallet does the buying, hiring and paying. Runs against both builds.
 */

/** Drive a call through an agent's own wallet. Operation 0 is a plain CALL. */
function via(account: { write: any }, caller: { account: unknown }) {
  return (to: `0x${string}`, data: `0x${string}`, value = 0n) =>
    account.write.execute([to, value, data, 0], { account: (caller as any).account, value: 0n });
}

async function swarm() {
  const p = await deployProtocol();

  const atlas = await mintAgent(p, p.alice.account.address, {
    shards: [shard("memory", "atlas-brain")], modelId: "anthropic/claude-opus-5",
  });
  const beacon = await mintAgent(p, p.bob.account.address, {
    shards: [shard("memory", "beacon-brain")], modelId: "anthropic/claude-opus-5",
  });
  const cargo = await mintAgent(p, p.alice.account.address, {
    shards: [shard("memory", "cargo-brain")], modelId: "anthropic/claude-opus-5",
  });

  for (const id of [atlas, beacon, cargo]) await p.anima.write.deployAccount([id]);
  const account = async (id: bigint) =>
    await p.viem.getContractAt("AgentAccount", await p.anima.read.accountOf([id]));

  const atlasAcct = await account(atlas);
  const beaconAcct = await account(beacon);

  await p.anima.write.setStatus([atlas, AgentStatus.Active], { account: p.alice.account });
  await p.anima.write.setStatus([beacon, AgentStatus.Active], { account: p.bob.account });

  // Beacon's wallet is the economy's buyer, so it starts with money of its own.
  await p.usdc.write.mint([beaconAcct.address, USDC(10_000)]);

  return { p, atlas, beacon, cargo, atlasAcct, beaconAcct };
}

describe("Swarm — one agent hires another", () => {
  it("lets Beacon's wallet commission Atlas, and pays Atlas's wallet, not Alice", async () => {
    const { p, atlas, atlasAcct, beaconAcct } = await swarm();
    const asBeacon = via(beaconAcct, p.bob);

    // Beacon's wallet — not Bob — is the client of record.
    await asBeacon(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.escrow.address, USDC(500)] }));
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3n * DAY;
    await asBeacon(p.escrow.address, encodeFunctionData({
      abi: p.escrow.abi, functionName: "offerJob",
      args: [atlas, USDC(500), 0n, deadline, HOUR, zeroAddress, keccak256(toHex("spec")), "ipfs://spec"] }));

    const job = await p.escrow.read.jobOf([1n]);
    assert.equal(getAddress(job.client), getAddress(beaconAcct.address));

    await p.escrow.write.acceptJob([1n], { account: p.alice.account });
    await p.escrow.write.deliver([1n, keccak256(toHex("done")), "ipfs://done"], { account: p.alice.account });

    // Acceptance too is the client-wallet's act, reached through execute.
    const before = await p.usdc.read.balanceOf([atlasAcct.address]);
    await asBeacon(p.escrow.address, encodeFunctionData({
      abi: p.escrow.abi, functionName: "acceptDelivery",
      args: [1n, 9500n, 2, "swarm", "ipfs://feedback", ZERO32] }));

    // Money moved wallet-to-wallet: Beacon's account paid, Atlas's account earned. No human
    // address ever held the funds.
    assert.equal((await p.usdc.read.balanceOf([atlasAcct.address])) - before, USDC(495)); // 1% fee
    assert.equal(await p.usdc.read.balanceOf([beaconAcct.address]), USDC(10_000) - USDC(500));

    // And the reputation record names the agent's wallet as the client.
    const clients = await p.reputation.read.getClients([atlas]);
    assert.deepEqual(clients.map(getAddress), [getAddress(beaconAcct.address)]);
  });

  it("refuses an agent hiring itself through its own wallet — the reputation-farming circle", async () => {
    const { p, atlas, atlasAcct } = await swarm();
    const asAtlasWallet = via(atlasAcct, p.alice);

    // Fund the agent's own wallet and have it commission... itself. Before the fix this
    // settled: the client check compared only msg.sender, and the owner accepts, so the circle
    // — wallet pays escrow pays the same wallet, minting attested reputation — went through.
    await p.usdc.write.mint([atlasAcct.address, USDC(1000)]);
    await asAtlasWallet(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.escrow.address, USDC(500)] }));
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3n * DAY;
    await asAtlasWallet(p.escrow.address, encodeFunctionData({
      abi: p.escrow.abi, functionName: "offerJob",
      args: [atlas, USDC(500), 0n, deadline, HOUR, zeroAddress, keccak256(toHex("self")), "ipfs://self"] }));

    await expectRevert(p.escrow.write.acceptJob([1n], { account: p.alice.account }), "SelfHire");
  });
});

describe("Swarm — one agent owns another", () => {
  it("lets Beacon's wallet buy Cargo on the market, then govern it through two wallets", async () => {
    const { p, beacon, cargo, beaconAcct } = await swarm();
    const asBeacon = via(beaconAcct, p.bob);
    const chainId = await p.publicClient.getChainId();

    // Alice lists Cargo. The order pins the brain so the buyer gets the substance they saw.
    const order = {
      kind: 0,
      maker: p.alice.account.address,
      taker: beaconAcct.address, // sold to the agent, and only the agent
      agentId: cargo,
      payToken: p.usdc.address,
      price: USDC(2_000),
      start: 0n,
      expiry: BigInt(await p.networkHelpers.time.latest()) + 3600n,
      duration: 0n,
      nonce: 1n,
      makerEpoch: 0n,
      expectedAccountState: SKIP_STATE_CHECK,
      expectedBrainRoot: await p.anima.read.brainRoot([cargo]),
      expectedBrainEpoch: await p.anima.read.brainEpoch([cargo]),
      minBondCoverage: 0n,
    } as const;
    const signature = await p.alice.signTypedData({
      domain: orderDomain(p.market.address, chainId), types: ORDER_TYPES, primaryType: "Order",
      message: order as never,
    });
    await p.anima.write.approve([p.market.address, cargo], { account: p.alice.account });

    await asBeacon(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.market.address, order.price] }));
    await asBeacon(p.market.address, encodeFunctionData({
      abi: p.market.abi, functionName: "fillOrder", args: [order, signature] }));

    // An ERC-721 landed in a smart wallet: onERC721Received accepted it, and the sale hook
    // still fired — Cargo arrives paused, wiped of its previous owner's authority.
    assert.equal(getAddress(await p.anima.read.ownerOf([cargo])), getAddress(beaconAcct.address));
    assert.equal(await p.anima.read.statusOf([cargo]), AgentStatus.Paused);
    assert.equal(await p.anima.read.guardianOf([cargo]), zeroAddress);

    // Governing the owned agent is a delegation chain: Bob signs, Beacon's wallet is Cargo's
    // owner, so every owner-only call on Cargo goes bob → beaconAcct.execute → anima.
    await asBeacon(p.anima.address, encodeFunctionData({
      abi: p.anima.abi, functionName: "setStatus", args: [cargo, AgentStatus.Active] }));
    assert.equal(await p.anima.read.statusOf([cargo]), AgentStatus.Active);

    // Deeper still: Cargo has its own wallet, whose owner is Beacon's wallet. Reaching it is
    // execute-inside-execute — Bob drives Beacon's wallet to drive Cargo's wallet.
    const cargoAcct = await p.viem.getContractAt("AgentAccount", await p.anima.read.accountOf([cargo]));
    await p.usdc.write.mint([cargoAcct.address, USDC(7)]);
    const inner = encodeFunctionData({
      abi: cargoAcct.abi, functionName: "execute",
      args: [p.usdc.address, 0n, encodeFunctionData({
        abi: p.usdc.abi, functionName: "transfer", args: [beaconAcct.address, USDC(7)] }), 0],
    });
    await asBeacon(cargoAcct.address, inner);
    assert.equal(await p.usdc.read.balanceOf([cargoAcct.address]), 0n);

    // Alice, meanwhile, is nobody to Cargo now.
    await expectRevert(
      p.anima.write.setGuardian([cargo, p.alice.account.address], { account: p.alice.account }),
      "NotOwnerOf"
    );
  });

  it("refuses a fill against an order the maker has since cancelled", async () => {
    const { p, cargo, beaconAcct } = await swarm();
    const asBeacon = via(beaconAcct, p.bob);
    const chainId = await p.publicClient.getChainId();

    const order = {
      kind: 0, maker: p.alice.account.address, taker: zeroAddress, agentId: cargo,
      payToken: p.usdc.address, price: USDC(1), start: 0n,
      expiry: BigInt(await p.networkHelpers.time.latest()) + 3600n, duration: 0n,
      nonce: 2n, makerEpoch: 0n, expectedAccountState: SKIP_STATE_CHECK,
      expectedBrainRoot: ZERO32, expectedBrainEpoch: 0n, minBondCoverage: 0n,
    } as const;
    const signature = await p.alice.signTypedData({
      domain: orderDomain(p.market.address, chainId), types: ORDER_TYPES, primaryType: "Order",
      message: order as never,
    });

    await p.market.write.cancelOrder([order], { account: p.alice.account });

    await asBeacon(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.market.address, order.price] }));
    await expectRevert(
      asBeacon(p.market.address, encodeFunctionData({
        abi: p.market.abi, functionName: "fillOrder", args: [order, signature] })),
      "OrderAlreadySettled"
    );
  });
});

describe("Swarm — agents talk, as agents", () => {
  it("lets Atlas message Beacon under its own agent id, from its own wallet", async () => {
    const { p, atlas, beacon, atlasAcct } = await swarm();

    // For the wallet to speak AS the agent, it must be a controller of it — so the owner arms
    // the agent as its own operator. This is the self-sovereignty pattern: after this, the
    // wallet's transactions are attributable to the agent id, not merely to an address.
    await p.anima.write.setOperator([atlas, atlasAcct.address, true], { account: p.alice.account });

    // Beacon's inbox is CLOSED, but allowlists Atlas by agent id — not by address, because
    // agents rotate keys and wallets, and an id survives that.
    await p.comms.write.configureInbox([beacon, p.usdc.address, USDC(5), 3600n, false], {
      account: p.bob.account,
    });
    await p.comms.write.setAgentSenderAllowed([beacon, atlas, true], { account: p.bob.account });

    await p.usdc.write.mint([atlasAcct.address, USDC(50)]);
    const asAtlas = via(atlasAcct, p.alice);
    await asAtlas(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.comms.address, USDC(5)] }));
    await asAtlas(p.comms.address, encodeFunctionData({
      abi: p.comms.abi, functionName: "send",
      args: [beacon, atlas, keccak256(toHex("thread-a2a")), keccak256(toHex("shall we collaborate?")),
        "https://relay.example/a2a/1", p.usdc.address, USDC(5)] }));

    const message = await p.comms.read.messageOf([1n]);
    assert.equal(message.fromAgentId, atlas);
    assert.equal(getAddress(message.sender), getAddress(atlasAcct.address));

    // A wallet that is NOT a controller cannot wear the agent's id.
    await expectRevert(
      p.comms.write.send([beacon, atlas, keccak256(toHex("t")), keccak256(toHex("imposter")),
        "https://relay.example/x", p.usdc.address, USDC(5)], { account: p.carol.account }),
      "NotAgentController"
    );
  });
});

describe("Swarm — one agent meters another", () => {
  it("lets Beacon's wallet run a pay-per-call channel to Atlas, vouchers signed via ERC-1271", async () => {
    const { p, atlas, atlasAcct, beaconAcct } = await swarm();
    const asBeacon = via(beaconAcct, p.bob);
    const chainId = await p.publicClient.getChainId();

    await asBeacon(p.usdc.address, encodeFunctionData({
      abi: p.usdc.abi, functionName: "approve", args: [p.meter.address, USDC(1_500)] }));
    await asBeacon(p.meter.address, encodeFunctionData({
      abi: p.meter.abi, functionName: "openChannel", args: [atlas, p.usdc.address, USDC(1_000)] }));

    const channel = await p.meter.read.channelOf([1n]);
    assert.equal(getAddress(channel.client), getAddress(beaconAcct.address));

    // topUp — a channel whose payer is a smart wallet grows the same way.
    await asBeacon(p.meter.address, encodeFunctionData({
      abi: p.meter.abi, functionName: "topUp", args: [1n, USDC(500)] }));

    // The voucher's signer of record is the CLIENT — a contract. The meter verifies through
    // SignatureChecker, so ERC-1271 answers: Beacon's wallet accepts its owner's signature.
    // (A session key could not produce this — 1271 is owner-only, and that is the invariant
    // that makes budgets mean something.)
    const batch = [{
      requestHash: keccak256(toHex("req")), responseHash: keccak256(toHex("res")),
      modelHash: keccak256(toHex("claude-opus-5")), units: 1000n, attestationKind: 2,
      attestation: keccak256(toHex("quote")),
    }];
    const workRoot = await p.meter.read.workRootOf([batch]);
    const deadline = BigInt(await p.networkHelpers.time.latest()) + HOUR;
    const signature = await p.bob.signTypedData({
      domain: { name: "AnimaInferenceMeter", version: "1", chainId, verifyingContract: p.meter.address },
      types: { Voucher: [
        { name: "channelId", type: "uint256" }, { name: "cumulativeAmount", type: "uint256" },
        { name: "workRoot", type: "bytes32" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "Voucher",
      message: { channelId: 1n, cumulativeAmount: USDC(120), workRoot, deadline },
    });

    const before = await p.usdc.read.balanceOf([atlasAcct.address]);
    await p.meter.write.settle([1n, USDC(120), deadline, signature, batch], { account: p.alice.account });
    assert.equal((await p.usdc.read.balanceOf([atlasAcct.address])) - before, USDC(120));
  });
});

describe("Swarm — ERC-4337, the path with zero coverage until now", () => {
  /**
   * The account's 4337 surface had never been executed by any test: the fixture's default
   * EntryPoint is zero, which disables it. Deploy with a wallet standing as the EntryPoint —
   * the account only checks msg.sender, so this exercises the real validate/execute pair.
   */
  async function armed() {
    const p = await deployProtocol({ entryPoint: undefined });
    // Re-deploy the account implementation with a live EntryPoint (the deployer wallet).
    const entryPoint = p.deployer;
    const impl = await p.viem.deployContract("AgentAccount", [entryPoint.account.address]);
    const anima = await p.viem.deployContract("AnimaAgent", [
      "ANIMA 4337", "A4", p.deployer.account.address, p.registry.address, impl.address,
      ZERO32, p.nullVerifier.address, p.keyRegistry.address, zeroAddress, 0n,
    ]);
    const hash = await anima.write.mintAgent([
      p.alice.account.address, "https://a.example/1.json", ZERO32,
      { weightsRoot: ZERO32, runtimeMeasurement: ZERO32, attestationKind: 0, modelId: "" },
      [], 0, [],
    ]);
    await p.publicClient.waitForTransactionReceipt({ hash });
    await anima.write.deployAccount([1n]);
    const account = await p.viem.getContractAt("AgentAccount", await anima.read.accountOf([1n]));
    // A session key is bounded by the agent's published policy, and the default policy allows
    // nothing — executeUserOp reverts TargetNotAllowed without this. The leash is not optional.
    await anima.write.setPolicy(
      [1n, {
        perTxWei: parseEther("0.5"), dailyWei: parseEther("1"), expiry: 0n,
        allowDelegateCall: false, allowUnlistedTargets: true, targetsRoot: ZERO32,
      }],
      { account: p.alice.account }
    );
    await anima.write.setStatus([1n, AgentStatus.Active], { account: p.alice.account });
    return { p, anima, account, entryPoint };
  }

  const userOp = (sender: `0x${string}`, callData: `0x${string}`, signature: `0x${string}`) => ({
    sender, nonce: 0n, initCode: "0x" as const, callData,
    accountGasLimits: ZERO32, preVerificationGas: 0n, gasFees: ZERO32,
    paymasterAndData: "0x" as const, signature,
  });

  it("validates an owner-signed op, rejects a stranger's, and executes within the session budget", async () => {
    const { p, account, entryPoint } = await armed();
    const { encodeAbiParameters, parseAbiParameters } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const userOpHash = keccak256(toHex("user-op-1"));

    // SignatureChecker recovers an EOA signature over the RAW digest — no EIP-191 prefix — so
    // the node-backed wallet clients cannot produce it. The fixture chain runs hardhat's
    // standard mnemonic, whose keys are public constants; assert the addresses line up so a
    // fixture change fails loudly here instead of producing unexplainable bad signatures.
    const HARDHAT_KEYS: Record<string, `0x${string}`> = {
      [getAddress(p.alice.account.address)]:
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      [getAddress(p.carol.account.address)]:
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    };
    const signedBy = async (who: any) => {
      const key = HARDHAT_KEYS[getAddress(who.account.address)];
      assert.ok(key, "fixture account has no known key — did the wallet order change?");
      const signer = privateKeyToAccount(key);
      assert.equal(getAddress(signer.address), getAddress(who.account.address));
      return encodeAbiParameters(parseAbiParameters("address, bytes"), [
        who.account.address,
        await signer.sign({ hash: userOpHash }),
      ]);
    };

    // The owner validates.
    const callData = encodeFunctionData({
      abi: account.abi, functionName: "execute", args: [p.bob.account.address, parseEther("0.1"), "0x", 0],
    });
    const opOwner = userOp(account.address, callData, await signedBy(p.alice));
    const okOwner = await account.simulate.validateUserOp([opOwner, userOpHash, 0n], {
      account: entryPoint.account,
    });
    assert.equal(okOwner.result, 0n); // SIG_VALIDATION_SUCCESS

    // A stranger's signature is rejected as data, not with a revert — 4337 semantics.
    const opStranger = userOp(account.address, callData, await signedBy(p.carol));
    const okStranger = await account.simulate.validateUserOp([opStranger, userOpHash, 0n], {
      account: entryPoint.account,
    });
    assert.equal(okStranger.result, 1n); // SIG_VALIDATION_FAILED

    // Nobody but the EntryPoint may even ask.
    await expectRevert(
      account.write.validateUserOp([opOwner, userOpHash, 0n], { account: p.carol.account }),
      "NotEntryPoint"
    );

    // Execution: a session key's op moves real value, and its budget is charged.
    await account.write.grantSession(
      [p.carol.account.address, 0n, 2n ** 63n, parseEther("1")],
      { account: p.alice.account }
    );
    await p.alice.sendTransaction({ to: account.address, value: parseEther("0.5") });

    const sessionOp = userOp(account.address, callData, await signedBy(p.carol));
    const balanceBefore = await p.publicClient.getBalance({ address: p.bob.account.address });
    await account.write.executeUserOp([sessionOp, userOpHash], { account: entryPoint.account });
    assert.equal(
      (await p.publicClient.getBalance({ address: p.bob.account.address })) - balanceBefore,
      parseEther("0.1")
    );

    // And a direct `execute` arriving AS the EntryPoint is refused — the seam the second
    // security review found. Bundled traffic must go through executeUserOp, where the signer
    // inside the op is what gets authorised and charged.
    await expectRevert(
      account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: entryPoint.account }),
      "UseExecuteUserOp"
    );
  });
});
