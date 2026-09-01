import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, parseEther, pad, keccak256, toHex, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, shard, brainRoot, ZERO32 } from "./helpers.js";

import { lzReceiveOptions } from "../sdk/src/index.js";

/**
 * Real Type-3 executor options, not the `0x` a mock will happily swallow.
 *
 * `MockLZEndpoint` ignores options entirely, so these tests passed for months with `0x` — while
 * quoting `0x` against Base Sepolia's live message library reverts. A suite that models the mock
 * rather than the endpoint would have shipped a bridge that could never send a message.
 */
const LZ_OPTIONS = lzReceiveOptions(300_000n);

const EID_HOME = 30101;
const EID_AWAY = 30184;
const EID_OTHER_HOME = 30231;
const FEE = { nativeFee: 10n ** 15n, lzTokenFee: 0n };

async function bridge(p: Awaited<ReturnType<typeof deployProtocol>>) {
  const endpointHome = await p.viem.deployContract("MockLZEndpoint", [EID_HOME]);
  const endpointAway = await p.viem.deployContract("MockLZEndpoint", [EID_AWAY]);

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

  await home.write.setPeer([EID_AWAY, pad(mirror.address)]);
  await mirror.write.setPeer([EID_HOME, pad(home.address)]);

  return { endpointHome, endpointAway, home, mirror };
}

describe("OmniAgentHome — leaving", () => {
  it("escrows the agent and carries a verifiable snapshot across", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const shards = [shard("memory", "a long history")];
    const id = await mintAgent(p, p.alice.account.address, { shards, manifest: "card-v1" });

    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false],
      { account: p.alice.account, value: FEE.nativeFee }
    );

    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(b.home.address));
    assert.equal(await b.home.read.awayOn([id]), EID_AWAY);

    await b.endpointAway.write.deliver([b.endpointHome.address, 0n, b.mirror.address, ZERO32]);

    assert.equal(getAddress(await b.mirror.read.ownerOf([id])), getAddress(p.alice.account.address));
    const replica = await b.mirror.read.replicaOf([id]);
    assert.equal(replica.brainRoot, brainRoot(shards));
    assert.equal(replica.manifestHash, keccak256(toHex("card-v1")));
    assert.equal(replica.homeChainId, BigInt(await p.publicClient.getChainId()));
    assert.equal(getAddress(`0x${replica.homeToken.slice(26)}`), getAddress(p.anima.address));
    // The mirror can prove what it represents even though it cannot enforce it.
    assert.equal(await b.mirror.read.verifyManifest([id, toHex("card-v1")]), true);
    assert.equal(await b.mirror.read.verifyManifest([id, toHex("card-v2")]), false);
    assert.equal(await b.mirror.read.isReplica(), true);
  });

  it("refuses to bridge an agent that owes someone work", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setModule([p.deployer.account.address, true]);
    await p.anima.write.lockAgent([id]);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });

    // Letting collateral cross to a chain the escrow cannot reach is absconding.
    await expectRevert(
      b.home.write.send([EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false], {
        account: p.alice.account,
        value: FEE.nativeFee,
      }),
      "AgentBusy"
    );
  });

  it("refuses to strand assets in the home account without an explicit acknowledgement", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.alice.sendTransaction({
      to: await p.anima.read.accountOf([id]),
      value: parseEther("2"),
    });
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });

    await expectRevert(
      b.home.write.send([EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false], {
        account: p.alice.account,
        value: FEE.nativeFee,
      }),
      "HomeAccountHoldsAssets"
    );

    // Deliberate friction in front of an irreversible mistake, not a wall.
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, true],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(b.home.address));
  });

  it("refuses to bridge an agent the caller does not own", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await expectRevert(
      b.home.write.send([EID_AWAY, pad(p.bob.account.address), id, LZ_OPTIONS, FEE, p.bob.account.address, false], {
        account: p.bob.account,
        value: FEE.nativeFee,
      }),
      "NotAgentOwner"
    );
  });
});

describe("OmniAgent — bridge authentication", () => {
  it("rejects a message that did not come from the local endpoint", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    // Nobody can hand the OApp a fabricated Origin directly.
    await expectRevert(
      b.mirror.write.lzReceive(
        [{ srcEid: EID_HOME, sender: pad(b.home.address), nonce: 1n }, ZERO32, "0x", zeroAddress, "0x"],
        { account: p.bob.account }
      ),
      "OnlyEndpoint"
    );
  });

  it("rejects a message from an unregistered peer on a configured chain", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false],
      { account: p.alice.account, value: FEE.nativeFee }
    );

    // The payload is genuine; the claimed sender is not the configured peer.
    await expectRevert(
      b.endpointAway.write.deliver([
        b.endpointHome.address,
        0n,
        b.mirror.address,
        pad(p.carol.account.address),
      ]),
      "UntrustedPeer"
    );
  });

  it("rejects a return message for an agent that never left", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);

    // Mint a mirror by bridging a *different* agent out, then try to send back the id that
    // stayed home. A compromised peer must not be able to mint a claim on it.
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    await b.endpointAway.write.deliver([b.endpointHome.address, 0n, b.mirror.address, ZERO32]);

    // Bring it home, clearing awayOn.
    await b.mirror.write.send(
      [EID_HOME, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    await b.endpointHome.write.deliver([b.endpointAway.address, 0n, b.home.address, ZERO32]);
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));

    // A second, replayed arrival must find nothing to release.
    await b.endpointAway.write.setNativeFee([FEE.nativeFee]);
    await expectRevert(
      b.endpointHome.write.deliver([b.endpointAway.address, 0n, b.home.address, ZERO32]),
      "already delivered"
    );
  });

  it("refuses to send to a chain with no configured peer", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await expectRevert(
      b.home.write.send([9999, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false], {
        account: p.alice.account,
        value: FEE.nativeFee,
      }),
      "NoPeerConfigured"
    );
  });
});

describe("OmniAgentMirror — coming home", () => {
  it("rejects a second home route before it can strand a colliding source NFT", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);

    // Numeric ERC-721 ids are collection-local. Refuse the incompatible route during setup,
    // while its owner can still deploy a separate mirror, rather than after send() has escrowed
    // a source NFT and left it with no deliverable destination.
    const endpointOther = await p.viem.deployContract("MockLZEndpoint", [EID_OTHER_HOME]);
    const homeOther = await p.viem.deployContract("OmniAgentHome", [
      p.anima.address,
      endpointOther.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    await homeOther.write.setPeer([EID_AWAY, pad(b.mirror.address)]);
    await expectRevert(
      b.mirror.write.setPeer([EID_OTHER_HOME, pad(homeOther.address)]),
      "OnlyOneHomeRoute"
    );
  });

  it("burns the mirror and releases the original", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address, { shards: [shard("m", "x")] });

    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    await b.endpointAway.write.deliver([b.endpointHome.address, 0n, b.mirror.address, ZERO32]);

    await b.mirror.write.send(
      [EID_HOME, pad(p.bob.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    // The mirror is gone the moment it is sent, so it cannot exist on two chains at once.
    await expectRevert(b.mirror.read.ownerOf([id]));

    await b.endpointHome.write.deliver([b.endpointAway.address, 0n, b.home.address, ZERO32]);
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.bob.account.address));
    assert.equal(await b.home.read.awayOn([id]), 0);
  });

  it("refuses to send a mirror the caller does not hold", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send(
      [EID_AWAY, pad(p.alice.account.address), id, LZ_OPTIONS, FEE, p.alice.account.address, false],
      { account: p.alice.account, value: FEE.nativeFee }
    );
    await b.endpointAway.write.deliver([b.endpointHome.address, 0n, b.mirror.address, ZERO32]);

    await expectRevert(
      b.mirror.write.send([EID_HOME, pad(p.bob.account.address), id, LZ_OPTIONS, FEE, p.bob.account.address], {
        account: p.bob.account,
        value: FEE.nativeFee,
      }),
      "NotMirrorOwner"
    );
  });
});
