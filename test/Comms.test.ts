import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, zeroAddress, getAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, ZERO32 } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;
const HASH = keccak256(toHex("ciphertext"));

async function inbox(p: Awaited<ReturnType<typeof deployProtocol>>, opts: { postage?: bigint; open?: boolean } = {}) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.comms.write.configureInbox(
    [id, p.usdc.address, opts.postage ?? USDC(5), 3600n, opts.open ?? true],
    { account: p.alice.account }
  );
  await p.usdc.write.mint([p.bob.account.address, USDC(100)]);
  await p.usdc.write.approve([p.comms.address, USDC(100)], { account: p.bob.account });
  return id;
}

describe("AgentComms — priced attention", () => {
  it("escrows postage on send and pays it to the agent's account on reply", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    const agentAccount = await p.anima.read.accountOf([id]);

    await p.comms.write.send([id, 0n, ZERO32, HASH, "xmtp://topic", p.usdc.address, USDC(1000)], { account: p.bob.account });
    assert.equal(await p.usdc.read.balanceOf([p.comms.address]), USDC(5));
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), 0n);

    await p.comms.write.reply([1n, keccak256(toHex("answer")), "xmtp://reply"], {
      account: p.alice.account,
    });
    // Collected only by answering.
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(5));
  });

  it("refunds the sender when the agent ignores the message", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    await p.comms.write.send([id, 0n, ZERO32, HASH, "xmtp://topic", p.usdc.address, USDC(1000)], { account: p.bob.account });

    await expectRevert(p.comms.write.refund([1n]), "ReplyWindowOpen");
    await p.networkHelpers.time.increase(3601);
    // Permissionless, so a sender is never left chasing an unresponsive agent.
    await p.comms.write.refund([1n], { account: p.carol.account });
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(100));

    // Once refunded, the more specific error wins over the window check.
    await expectRevert(
      p.comms.write.reply([1n, HASH, ""], { account: p.alice.account }),
      "AlreadyRefunded"
    );
  });

  it("refuses a late reply even when nobody has claimed the refund yet", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    await p.comms.write.send([id, 0n, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account });

    await p.networkHelpers.time.increase(3601);
    await expectRevert(
      p.comms.write.reply([1n, HASH, ""], { account: p.alice.account }),
      "ReplyWindowClosed"
    );
    // The postage is still the sender's to reclaim.
    await p.comms.write.refund([1n]);
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(100));
  });

  it("refuses a reply after a refund and a refund after a reply", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    await p.comms.write.send([id, 0n, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account });
    await p.comms.write.reply([1n, HASH, ""], { account: p.alice.account });

    await p.networkHelpers.time.increase(3601);
    await expectRevert(p.comms.write.refund([1n]), "AlreadyAnswered");
  });

  it("enforces the allowlist on a closed inbox", async () => {
    const p = await deployProtocol();
    const id = await inbox(p, { open: false });

    await expectRevert(
      p.comms.write.send([id, 0n, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account }),
      "SenderNotAllowed"
    );
    await p.comms.write.setSenderAllowed([id, p.bob.account.address, true], { account: p.alice.account });
    await p.comms.write.send([id, 0n, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account });
  });

  it("allowlists a peer by agent id, so rotating session keys does not break it", async () => {
    const p = await deployProtocol();
    const recipient = await inbox(p, { open: false });
    const sender = await mintAgent(p, p.bob.account.address);

    await p.comms.write.setAgentSenderAllowed([recipient, sender, true], { account: p.alice.account });
    await p.comms.write.send([recipient, sender, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account });

    const m = await p.comms.read.messageOf([1n]);
    assert.equal(m.fromAgentId, sender);
  });
});

describe("AgentComms — authenticated identity", () => {
  it("refuses to let anyone write as an agent they do not control", async () => {
    const p = await deployProtocol();
    const recipient = await inbox(p);
    const otherAgent = await mintAgent(p, p.carol.account.address);

    // Agent impersonation is the attack that breaks every agent-to-agent protocol that
    // assumes good faith.
    await expectRevert(
      p.comms.write.send([recipient, otherAgent, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.bob.account }),
      "NotAgentController"
    );
  });

  it("lets an operator write as the agent, and stops doing so once it is sold", async () => {
    const p = await deployProtocol();
    const recipient = await inbox(p);
    const sender = await mintAgent(p, p.bob.account.address);
    await p.anima.write.setOperator([sender, p.carol.account.address, true], { account: p.bob.account });

    await p.usdc.write.mint([p.carol.account.address, USDC(100)]);
    await p.usdc.write.approve([p.comms.address, USDC(100)], { account: p.carol.account });
    await p.comms.write.send([recipient, sender, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.carol.account });

    await p.anima.write.transferFrom([p.bob.account.address, p.deployer.account.address, sender], {
      account: p.bob.account,
    });
    await expectRevert(
      p.comms.write.send([recipient, sender, ZERO32, HASH, "", p.usdc.address, USDC(1000)], { account: p.carol.account }),
      "NotAgentController"
    );
  });

  it("refuses a broadcast from a non-controller", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await expectRevert(
      p.comms.write.broadcast([id, keccak256(toHex("topic")), HASH, "ipfs://x"], { account: p.bob.account }),
      "NotAgentController"
    );
    await p.comms.write.broadcast([id, keccak256(toHex("topic")), HASH, "ipfs://x"], {
      account: p.alice.account,
    });
  });

  it("rejects an empty payload commitment", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    await expectRevert(
      p.comms.write.send([id, 0n, ZERO32, ZERO32, "", p.usdc.address, USDC(1000)], { account: p.bob.account }),
      "EmptyPayload"
    );
  });
});

describe("AgentComms — enforced private envelopes", () => {
  it("pins the exact recipient key and rejects missing, stale, or rotated keys", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);

    await expectRevert(
      p.comms.write.sendPrivate(
        [id, 0n, ZERO32, HASH, "xmtp://ciphertext", p.usdc.address, USDC(1000), HASH],
        { account: p.bob.account }
      ),
      "NoEncryptionKey"
    );

    const firstKey = toHex("alice-x25519-public-key");
    await p.keyRegistry.write.setEncryptionKey([1, firstKey], { account: p.alice.account });
    const firstKeyId = keccak256(firstKey);

    await expectRevert(
      p.comms.write.sendPrivate(
        [id, 0n, ZERO32, HASH, "xmtp://ciphertext", p.usdc.address, USDC(1000), ZERO32],
        { account: p.bob.account }
      ),
      "EncryptionKeyChanged"
    );
    await p.comms.write.sendPrivate(
      [id, 0n, ZERO32, HASH, "xmtp://ciphertext", p.usdc.address, USDC(1000), firstKeyId],
      { account: p.bob.account }
    );
    assert.equal(await p.comms.read.recipientKeyOf([1n]), firstKeyId);

    await p.keyRegistry.write.setEncryptionKey([1, toHex("rotated-key")], { account: p.alice.account });
    await expectRevert(
      p.comms.write.sendPrivate(
        [id, 0n, ZERO32, HASH, "xmtp://ciphertext-2", p.usdc.address, USDC(1000), firstKeyId],
        { account: p.bob.account }
      ),
      "EncryptionKeyChanged"
    );
  });

  it("pins an encrypted reply to the original sender's key", async () => {
    const p = await deployProtocol();
    const id = await inbox(p);
    const aliceKey = toHex("alice-key");
    const bobKey = toHex("bob-key");
    await p.keyRegistry.write.setEncryptionKey([1, aliceKey], { account: p.alice.account });
    await p.keyRegistry.write.setEncryptionKey([1, bobKey], { account: p.bob.account });

    await p.comms.write.sendPrivate(
      [id, 0n, ZERO32, HASH, "waku://request", p.usdc.address, USDC(1000), keccak256(aliceKey)],
      { account: p.bob.account }
    );
    await p.comms.write.replyPrivate([1n, keccak256(toHex("encrypted answer")), "waku://reply", keccak256(bobKey)], {
      account: p.alice.account,
    });
    assert.equal(await p.comms.read.replyKeyOf([1n]), keccak256(bobKey));
  });
});
