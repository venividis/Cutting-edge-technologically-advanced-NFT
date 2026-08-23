import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, parseEther, pad, zeroAddress, encodeFunctionData } from "viem";
import { deployProtocol, mintAgent, expectRevert, shard, AgentStatus, DAY, ZERO32 } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;
const FOREVER = 2n ** 63n;

/**
 * One test per vulnerability found in adversarial review. Each reproduces the original exploit
 * path, so a regression re-opens as a failure rather than as an incident.
 */
describe("Regressions — session keys do not survive a sale", () => {
  it("voids a key the seller granted, and empties the allowlist they opened", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    const accountAddress = await p.anima.read.accountOf([id]);
    const account = await p.viem.getContractAt("AgentAccount", accountAddress);
    const token = await p.viem.deployContract("MockERC20", ["T", "T", 18]);
    await token.write.mint([accountAddress, 1000n]);

    // Ordinary-looking setup, done long before listing.
    const transferSel = "0xa9059cbb" as const;
    await account.write.setAllowedCall([token.address, transferSel, true], { account: p.alice.account });
    await account.write.grantSession([p.carol.account.address, 0n, FOREVER, parseEther("100")], {
      account: p.alice.account,
    });
    assert.equal(await account.read.allowedCall([token.address, transferSel]), true);

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });

    // The buyer re-arms the agent exactly as they would in production.
    await p.anima.write.setPolicy(
      [
        id,
        {
          perTxWei: parseEther("1"),
          dailyWei: parseEther("1"),
          expiry: 0n,
          allowDelegateCall: false,
          allowUnlistedTargets: false,
          targetsRoot: ZERO32,
        },
      ],
      { account: p.bob.account }
    );
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.bob.account });

    // The seller's key must be dead, and their allowlist gone with it.
    assert.equal(await account.read.allowedCall([token.address, transferSel]), false);
    await expectRevert(
      account.write.execute(
        [
          token.address,
          0n,
          encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [p.alice.account.address, 1000n] }),
          0,
        ],
        { account: p.carol.account }
      ),
      "SessionNotValid"
    );
    assert.equal(await token.read.balanceOf([accountAddress]), 1000n);
  });

  it("bumps ERC-6551 state when the allowlist changes, so an integrity pin catches it", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    const account = await p.viem.getContractAt("AgentAccount", await p.anima.read.accountOf([id]));

    const before = await account.read.state();
    await account.write.setAllowedCall([p.usdc.address, "0xa9059cbb", true], { account: p.alice.account });
    // Widening what a dormant key may do is a change to the wallet, and a buyer pinning
    // expectedAccountState is asking exactly whether anything changed since they quoted.
    assert.equal(await account.read.state(), before + 1n);
  });
});

describe("Regressions — collateral belongs to whoever put it up", () => {
  it("stops a buyer cancelling and re-queueing the seller's pending withdrawal", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.usdc.write.mint([p.alice.account.address, USDC(500)]);
    await p.usdc.write.approve([p.bonds.address, USDC(500)], { account: p.alice.account });
    await p.bonds.write.deposit([id, USDC(500)], { account: p.alice.account });
    await p.bonds.write.requestUnbond([id, USDC(500)], { account: p.alice.account });

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });

    await expectRevert(p.bonds.write.cancelUnbond([id], { account: p.bob.account }), "NotAgentOwner");

    await p.networkHelpers.time.increase(Number(7n * DAY) + 1);
    await p.bonds.write.withdraw([id]);
    assert.equal(await p.usdc.read.balanceOf([p.alice.account.address]), USDC(500));
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), 0n);
  });
});

describe("Regressions — a tenant cannot spend the owner's bond", () => {
  it("refuses a job accepted by a rental tenant", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
    await p.usdc.write.mint([p.alice.account.address, USDC(2000)]);
    await p.usdc.write.approve([p.bonds.address, USDC(2000)], { account: p.alice.account });
    await p.bonds.write.deposit([id, USDC(2000)], { account: p.alice.account });

    // A free lease is enough to make the tenant a controller.
    await p.anima.write.setUser([id, p.carol.account.address, FOREVER], { account: p.alice.account });
    assert.equal(await p.anima.read.isController([id, p.carol.account.address]), true);

    await p.usdc.write.mint([p.bob.account.address, 1n]);
    await p.usdc.write.approve([p.escrow.address, 1n], { account: p.bob.account });
    const now = BigInt(await p.networkHelpers.time.latest());
    await p.escrow.write.offerJob(
      [id, 1n, USDC(2000), now + 120n, 3600n, p.validator.account.address, ZERO32, ""],
      { account: p.bob.account }
    );

    // Accepting for one unit of USDC would pin the owner's entire 2000 USDC bond, then be
    // deliberately failed to forfeit it.
    await expectRevert(p.escrow.write.acceptJob([1n], { account: p.carol.account }), "NotAgentPrincipal");

    // An operator, who is the owner's own staff, still can.
    await p.anima.write.setOperator([id, p.carol.account.address, true], { account: p.alice.account });
    await p.escrow.write.acceptJob([1n], { account: p.carol.account });
  });

  it("refuses a job whose named validator holds the agent", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.usdc.write.mint([p.bob.account.address, USDC(10)]);
    await p.usdc.write.approve([p.escrow.address, USDC(10)], { account: p.bob.account });
    const now = BigInt(await p.networkHelpers.time.latest());
    // The client names a validator, unaware the agent is about to be moved to them.
    await p.escrow.write.offerJob([id, USDC(10), 0n, now + 3600n, 3600n, p.carol.account.address, ZERO32, ""], {
      account: p.bob.account,
    });

    await p.anima.write.transferFrom([p.alice.account.address, p.carol.account.address, id], {
      account: p.alice.account,
    });

    // Accepting would leave the client unable to ever open a dispute, since the registry
    // refuses a validator who holds the agent — a trap that only springs after delivery.
    await expectRevert(p.escrow.write.acceptJob([1n], { account: p.carol.account }), "ValidatorOwnsAgent");
  });
});

describe("Regressions — status cannot be used to strand a counterparty", () => {
  it("refuses to retire an agent that owes work", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setModule([p.deployer.account.address, true]);
    await p.anima.write.lockAgent([id]);

    // Retirement is terminal and kills every session key, so standing an agent down mid-lease
    // would be a way to keep the rent and hand back a corpse.
    await expectRevert(
      p.anima.write.setStatus([id, AgentStatus.Retired], { account: p.alice.account }),
      "AgentLocked"
    );
  });

  it("keeps an agent disputed until the last open dispute resolves", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setModule([p.deployer.account.address, true]);

    await p.anima.write.setDisputed([id, true]);
    await p.anima.write.setDisputed([id, true]);
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Disputed);

    await p.anima.write.setDisputed([id, false]);
    // One resolution must not hand spending authority back while another client is still owed.
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Disputed);
    assert.equal(await p.anima.read.locked([id]), true);

    await p.anima.write.setDisputed([id, false]);
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Paused);
    assert.equal(await p.anima.read.locked([id]), false);
  });
});

describe("Regressions — a recipient cannot price their own mail", () => {
  it("refuses postage raised above what the sender agreed to", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.comms.write.configureInbox([id, p.usdc.address, USDC(1), 3600n, true], {
      account: p.alice.account,
    });
    await p.usdc.write.mint([p.bob.account.address, USDC(10_000)]);
    await p.usdc.write.approve([p.comms.address, USDC(10_000)], { account: p.bob.account });

    // The recipient front-runs the pending send, raising postage to the sender's allowance.
    await p.comms.write.configureInbox([id, p.usdc.address, USDC(10_000), 3600n, true], {
      account: p.alice.account,
    });

    await expectRevert(
      p.comms.write.send([id, 0n, ZERO32, keccak256(toHex("m")), "", p.usdc.address, USDC(2)], {
        account: p.bob.account,
      }),
      "PostageAboveLimit"
    );
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(10_000));
  });

  it("refuses a fee token the sender did not price against", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const other = await p.viem.deployContract("MockERC20", ["X", "X", 18]);
    await p.comms.write.configureInbox([id, other.address, 5n, 3600n, true], { account: p.alice.account });

    await expectRevert(
      p.comms.write.send([id, 0n, ZERO32, keccak256(toHex("m")), "", p.usdc.address, USDC(1000)], {
        account: p.bob.account,
      }),
      "UnexpectedFeeToken"
    );
  });
});

describe("Regressions — the bridge cannot strand an agent", () => {
  async function bridge(p: Awaited<ReturnType<typeof deployProtocol>>) {
    const endpointHome = await p.viem.deployContract("MockLZEndpoint", [30101]);
    const endpointAway = await p.viem.deployContract("MockLZEndpoint", [30184]);
    const endpointThird = await p.viem.deployContract("MockLZEndpoint", [30110]);
    const home = await p.viem.deployContract("OmniAgentHome", [
      p.anima.address,
      endpointHome.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    const mirror = await p.viem.deployContract("OmniAgentMirror", [
      "M",
      "M",
      endpointAway.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    const third = await p.viem.deployContract("OmniAgentMirror", [
      "M3",
      "M3",
      endpointThird.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    await home.write.setPeer([30184, pad(mirror.address)]);
    await mirror.write.setPeer([30101, pad(home.address)]);
    await mirror.write.setPeer([30110, pad(third.address)]);
    await third.write.setPeer([30184, pad(mirror.address)]);
    return { endpointHome, endpointAway, home, mirror, third };
  }

  const FEE = { nativeFee: 10n ** 15n, lzTokenFee: 0n };

  it("rejects a right-padded receiver before the token is committed", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });

    // Non-zero as a word, but decodes to address(0) on arrival — after the escrow.
    const dirty = (p.alice.account.address + "000000000000000000000000") as `0x${string}`;
    await expectRevert(
      b.home.write.send([30184, dirty, id, "0x", FEE, p.alice.account.address, false], {
        account: p.alice.account,
        value: FEE.nativeFee,
      }),
      "InvalidReceiver"
    );
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));
  });

  it("refuses to forward a mirror off its return route", async () => {
    const p = await deployProtocol();
    const b = await bridge(p);
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.approve([b.home.address, id], { account: p.alice.account });
    await b.home.write.send([30184, pad(p.alice.account.address), id, "0x", FEE, p.alice.account.address, false], {
      account: p.alice.account,
      value: FEE.nativeFee,
    });
    await b.endpointAway.write.deliver([b.endpointHome.address, 0n, b.mirror.address, ZERO32]);

    // Hopping to a third chain would burn the mirror here while the home side still expects it
    // back from 30184, stranding the escrowed original on every retry.
    await expectRevert(
      b.mirror.write.send([30110, pad(p.alice.account.address), id, "0x", FEE, p.alice.account.address], {
        account: p.alice.account,
        value: FEE.nativeFee,
      }),
      "OnlyHomeRoute"
    );

    // The home route still works.
    await b.mirror.write.send([30101, pad(p.alice.account.address), id, "0x", FEE, p.alice.account.address], {
      account: p.alice.account,
      value: FEE.nativeFee,
    });
    await b.endpointHome.write.deliver([b.endpointAway.address, 0n, b.home.address, ZERO32]);
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));
  });
});
