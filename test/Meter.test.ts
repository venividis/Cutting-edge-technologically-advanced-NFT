import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";
import { deployProtocol, mintAgent, expectRevert, DAY, ZERO32 } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;

function receipts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    requestHash: keccak256(toHex(`req-${i}`)),
    responseHash: keccak256(toHex(`res-${i}`)),
    modelHash: keccak256(toHex("claude-opus-5")),
    units: BigInt(1000 + i),
    attestationKind: 2,
    attestation: keccak256(toHex(`quote-${i}`)),
  }));
}

async function channel(p: Awaited<ReturnType<typeof deployProtocol>>, deposit = USDC(1000)) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.usdc.write.mint([p.bob.account.address, deposit]);
  await p.usdc.write.approve([p.meter.address, deposit], { account: p.bob.account });
  await p.meter.write.openChannel([id, p.usdc.address, deposit], { account: p.bob.account });
  return { id, channelId: 1n };
}

async function voucher(
  p: Awaited<ReturnType<typeof deployProtocol>>,
  channelId: bigint,
  cumulative: bigint,
  batch: ReturnType<typeof receipts>
) {
  const workRoot = await p.meter.read.workRootOf([batch]);
  const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
  const signature = await p.bob.signTypedData({
    domain: {
      name: "AnimaInferenceMeter",
      version: "1",
      chainId: await p.publicClient.getChainId(),
      verifyingContract: p.meter.address,
    },
    types: {
      Voucher: [
        { name: "channelId", type: "uint256" },
        { name: "cumulativeAmount", type: "uint256" },
        { name: "workRoot", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Voucher",
    message: { channelId, cumulativeAmount: cumulative, workRoot, deadline },
  });
  return { signature, deadline, workRoot };
}

describe("InferenceMeter — settling a thousand calls in one transaction", () => {
  it("pays the delta between cumulative vouchers, into the agent's own account", async () => {
    const p = await deployProtocol();
    const { id, channelId } = await channel(p);
    const agentAccount = await p.anima.read.accountOf([id]);

    const batch1 = receipts(3);
    const v1 = await voucher(p, channelId, USDC(100), batch1);
    await p.meter.write.settle([channelId, USDC(100), v1.deadline, v1.signature, batch1], {
      account: p.alice.account,
    });
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(100));

    const batch2 = receipts(5);
    const v2 = await voucher(p, channelId, USDC(250), batch2);
    await p.meter.write.settle([channelId, USDC(250), v2.deadline, v2.signature, batch2], {
      account: p.alice.account,
    });
    // Only the increment is paid, not the whole cumulative total again.
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(250));
    assert.equal(await p.meter.read.remaining([channelId]), USDC(750));
  });

  it("makes a superseded voucher worthless without any nonce bookkeeping", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);

    const batch = receipts(2);
    const v1 = await voucher(p, channelId, USDC(100), batch);
    const v2 = await voucher(p, channelId, USDC(200), batch);

    await p.meter.write.settle([channelId, USDC(200), v2.deadline, v2.signature, batch], {
      account: p.alice.account,
    });
    await expectRevert(
      p.meter.write.settle([channelId, USDC(100), v1.deadline, v1.signature, batch], {
        account: p.alice.account,
      }),
      "NotMonotonic"
    );
  });

  it("refuses to pay beyond what the client actually escrowed", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p, USDC(100));
    const batch = receipts(1);
    const v = await voucher(p, channelId, USDC(500), batch);
    await expectRevert(
      p.meter.write.settle([channelId, USDC(500), v.deadline, v.signature, batch], {
        account: p.alice.account,
      }),
      "ExceedsDeposit"
    );
  });

  it("binds the voucher to the exact batch, so an agent cannot invent work", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);

    const agreed = receipts(2);
    const v = await voucher(p, channelId, USDC(100), agreed);
    const fabricated = receipts(9);

    // Same signature, different receipts: the workRoot no longer matches what was signed.
    await expectRevert(
      p.meter.write.settle([channelId, USDC(100), v.deadline, v.signature, fabricated], {
        account: p.alice.account,
      }),
      "InvalidSignature"
    );
  });

  it("refuses a settlement from anyone but the agent's controller", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);
    const batch = receipts(1);
    const v = await voucher(p, channelId, USDC(50), batch);
    await expectRevert(
      p.meter.write.settle([channelId, USDC(50), v.deadline, v.signature, batch], {
        account: p.carol.account,
      }),
      "NotAgentController"
    );
  });

  it("rejects an expired voucher", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);
    const batch = receipts(1);
    const v = await voucher(p, channelId, USDC(50), batch);
    await p.networkHelpers.time.increase(3601);
    await expectRevert(
      p.meter.write.settle([channelId, USDC(50), v.deadline, v.signature, batch], {
        account: p.alice.account,
      }),
      "VoucherExpired"
    );
  });

  it("advances a per-agent work log that binds every settled batch", async () => {
    const p = await deployProtocol();
    const { id, channelId } = await channel(p);
    assert.equal(await p.meter.read.workLog([id]), ZERO32);

    const batch = receipts(2);
    const v = await voucher(p, channelId, USDC(10), batch);
    await p.meter.write.settle([channelId, USDC(10), v.deadline, v.signature, batch], {
      account: p.alice.account,
    });

    const expected = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, uint256, bytes32, uint256"), [
        ZERO32,
        channelId,
        v.workRoot,
        USDC(10),
      ])
    );
    assert.equal(await p.meter.read.workLog([id]), expected);
  });
});

describe("InferenceMeter — closing", () => {
  it("makes the client wait out a challenge window before refunding", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);

    await p.meter.write.requestClose([channelId], { account: p.bob.account });
    await expectRevert(p.meter.write.close([channelId]), "ChallengeWindowOpen");

    // The agent can still settle work already delivered.
    const batch = receipts(1);
    const v = await voucher(p, channelId, USDC(400), batch);
    await p.meter.write.settle([channelId, USDC(400), v.deadline, v.signature, batch], {
      account: p.alice.account,
    });

    await p.networkHelpers.time.increase(Number(3n * DAY) + 1);
    await p.meter.write.close([channelId], { account: p.carol.account });
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(600));
  });

  it("refuses a close request from anyone but the client", async () => {
    const p = await deployProtocol();
    const { channelId } = await channel(p);
    await expectRevert(p.meter.write.requestClose([channelId], { account: p.alice.account }), "NotClient");
  });
});
