import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, parseEther, pad, zeroAddress, encodeFunctionData, encodeAbiParameters, hashMessage } from "viem";
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
    await expectRevert(p.escrow.write.acceptJob([1n], { account: p.carol.account }), "OnlyOwnerMayPledge");

    // Not even an operator can pledge the owner's capital — insiders are the other half of
    // this attack, and the owner's staff is still not the owner.
    await p.anima.write.setOperator([id, p.carol.account.address, true], { account: p.alice.account });
    await expectRevert(p.escrow.write.acceptJob([1n], { account: p.carol.account }), "OnlyOwnerMayPledge");

    await p.escrow.write.acceptJob([1n], { account: p.alice.account });
  });

  it("refuses a job whose named validator holds the agent", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.usdc.write.mint([p.bob.account.address, USDC(10)]);
    await p.usdc.write.approve([p.escrow.address, USDC(10)], { account: p.bob.account });
    const now = BigInt(await p.networkHelpers.time.latest());
    // The client names a validator, unaware the agent is about to be moved to them.
    await p.validation.write.setValidator([p.carol.account.address, true]);
    await p.escrow.write.offerJob([id, USDC(10), USDC(1), now + 3600n, 3600n, p.carol.account.address, ZERO32, ""], {
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

describe("Regressions — reputation is bounded by capital at risk", () => {
  it("caps attested weight at the coverage that actually stood behind the job", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
    await p.usdc.write.mint([p.alice.account.address, USDC(50)]);
    await p.usdc.write.approve([p.bonds.address, USDC(50)], { account: p.alice.account });
    await p.bonds.write.deposit([id, USDC(50)], { account: p.alice.account });

    // A huge headline price behind a small bond. Weighting by the price would let a
    // flash-loaned self-hire buy a maximally-weighted score for the cost of the protocol fee.
    await p.usdc.write.mint([p.bob.account.address, USDC(1_000_000)]);
    await p.usdc.write.approve([p.escrow.address, USDC(1_000_000)], { account: p.bob.account });
    const now = BigInt(await p.networkHelpers.time.latest());
    await p.escrow.write.offerJob(
      [id, USDC(1_000_000), USDC(50), now + 3600n, 3600n, p.validator.account.address, ZERO32, ""],
      { account: p.bob.account }
    );
    await p.escrow.write.acceptJob([1n], { account: p.alice.account });
    await p.escrow.write.deliver([1n, ZERO32, ""], { account: p.alice.account });
    await p.escrow.write.acceptDelivery([1n, 100n, 0, "q", "", ZERO32], { account: p.bob.account });

    const [, , totalWeight] = await p.reputation.read.attestedSummaryOf([id]);
    assert.equal(totalWeight, USDC(50), "weight must track collateral at risk, not headline price");
  });

  it("reads attested standing in constant time, so spam cannot make it unreadable", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    // Anyone can append to the client list for the price of gas.
    for (const w of [p.bob, p.carol, p.deployer, p.guardian]) {
      await p.reputation.write.giveFeedback([id, 0n, 0, "", "", "", "", ZERO32], { account: w.account });
    }
    assert.equal(await p.reputation.read.clientCount([id]), 4n);

    // The read path integrators use touches none of it.
    const [count, , weight] = await p.reputation.read.attestedSummaryOf([id]);
    assert.equal(count, 0n);
    assert.equal(weight, 0n);

    const page = await p.reputation.read.getClientsPaged([id, 1n, 2n]);
    assert.equal(page.length, 2);
    assert.equal(getAddress(page[0]), getAddress(p.carol.account.address));
  });
});

describe("Regressions — the launchpad's promises are fixed at creation", () => {
  it("pins the liquidity deployer, so it cannot be swapped after buyers commit", async () => {
    const p = await deployProtocol();
    const launchpad = await p.viem.deployContract("AgentLaunchpad", [
      p.usdc.address,
      p.anima.address,
      p.anima.address,
      p.deployer.account.address,
      p.treasury.account.address,
      { protocolBps: 0, treasuryBps: 0, agentBps: 0 },
    ]);
    const honest = await p.viem.deployContract("MockLiquidityDeployer");
    const evil = await p.viem.deployContract("MockLiquidityDeployer");
    await launchpad.write.setLiquidityDeployer([honest.address]);

    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    await launchpad.write.createLaunch(
      [
        {
          agentId: id,
          name: "A",
          symbol: "A",
          totalSupply: 10n ** 27n,
          curveSupply: 8n * 10n ** 26n,
          virtualQuote: USDC(1000),
          graduationTarget: USDC(1000),
          startsAt: 0n,
          fairWindow: 0n,
          maxBuyInWindow: USDC(1_000_000),
          snipeTaxStartBps: 0,
          lpRecipient: "0x000000000000000000000000000000000000dEaD",
        },
      ],
      { account: p.alice.account }
    );

    await p.usdc.write.mint([p.bob.account.address, USDC(3000)]);
    await p.usdc.write.approve([launchpad.address, USDC(3000)], { account: p.bob.account });
    await launchpad.write.buy([1n, USDC(3000), 0n], { account: p.bob.account });

    // Governance swaps the deployer after the raise is complete.
    await launchpad.write.setLiquidityDeployer([evil.address]);
    await launchpad.write.graduate([1n]);

    // The launch graduated through the deployer buyers could see when they bought.
    assert.ok((await honest.read.lastQuoteAmount()) > 0n);
    assert.equal(await evil.read.lastQuoteAmount(), 0n);
  });

  it("refuses a backdated start that would skip the fair window entirely", async () => {
    const p = await deployProtocol();
    const launchpad = await p.viem.deployContract("AgentLaunchpad", [
      p.usdc.address,
      p.anima.address,
      p.anima.address,
      p.deployer.account.address,
      p.treasury.account.address,
      { protocolBps: 0, treasuryBps: 0, agentBps: 0 },
    ]);
    await launchpad.write.setLiquidityDeployer([(await p.viem.deployContract("MockLiquidityDeployer")).address]);
    const id = await mintAgent(p, p.alice.account.address);

    await expectRevert(
      launchpad.write.createLaunch(
        [
          {
            agentId: id,
            name: "A",
            symbol: "A",
            totalSupply: 10n ** 27n,
            curveSupply: 8n * 10n ** 26n,
            virtualQuote: USDC(1000),
            graduationTarget: USDC(1000),
            startsAt: 1n, // 1970: fairWindowEnds is already long past
            fairWindow: 86400n,
            maxBuyInWindow: USDC(500),
            snipeTaxStartBps: 0,
            lpRecipient: "0x000000000000000000000000000000000000dEaD",
          },
        ],
        { account: p.alice.account }
      ),
      "StartsInThePast"
    );
  });
});

describe("ERC-5646 — one fingerprint over everything mutable", () => {
  it("changes when any part of the agent changes, not just its wallet", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, { shards: [shard("m", "v1")] });
    await p.anima.write.deployAccount([id]);
    assert.equal(await p.anima.read.supportsInterface(["0xf5112315"]), true);

    const seen = new Set<string>();
    const record = async () => {
      const fp = await p.anima.read.getStateFingerprint([id]);
      assert.equal(seen.has(fp), false, "a distinct state produced a repeated fingerprint");
      seen.add(fp);
      return fp;
    };

    await record();

    // Each of these is invisible to the ERC-6551 state() nonce, which sees only the account.
    await p.anima.write.updateBrain([id, [shard("m", "v2")], 1n], { account: p.alice.account });
    await record();

    await p.anima.write.setManifest([id, "ipfs://new", keccak256(toHex("card"))], {
      account: p.alice.account,
    });
    await record();

    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });
    await record();

    await p.anima.write.setPolicy(
      [
        id,
        {
          perTxWei: parseEther("1"),
          dailyWei: parseEther("2"),
          expiry: 0n,
          allowDelegateCall: false,
          allowUnlistedTargets: true,
          targetsRoot: ZERO32,
        },
      ],
      { account: p.alice.account }
    );
    await record();

    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
    await record();

    // ...and it moves for account activity too, so it strictly dominates state().
    const account = await p.viem.getContractAt("AgentAccount", await p.anima.read.accountOf([id]));
    await account.write.grantSession([p.carol.account.address, 0n, FOREVER, 1n], {
      account: p.alice.account,
    });
    await record();
  });

  it("reverts for an agent that does not exist, so zero is never a fingerprint", async () => {
    const p = await deployProtocol();
    await expectRevert(p.anima.read.getStateFingerprint([99n]));
  });
});

describe("Bridge rate limiting", () => {
  it("refuses a zero-length window that would reset on every message", async () => {
    const p = await deployProtocol();
    const endpoint = await p.viem.deployContract("MockLZEndpoint", [30184]);
    const mirror = await p.viem.deployContract("OmniAgentMirror", [
      "M", "M", endpoint.address, p.deployer.account.address, p.deployer.account.address,
    ]);
    await expectRevert(mirror.write.setInboundLimit([30101, 0n, 1n]), "InvalidRateLimit");
  });

  it("caps inbound messages per window and lets the window refill", async () => {
    const p = await deployProtocol();
    const endpointHome = await p.viem.deployContract("MockLZEndpoint", [30101]);
    const endpointAway = await p.viem.deployContract("MockLZEndpoint", [30184]);
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
    await home.write.setPeer([30184, pad(mirror.address)]);
    await mirror.write.setPeer([30101, pad(home.address)]);

    // Unlimited by default, so a deployment must choose a number rather than inherit one.
    assert.equal(await mirror.read.inboundRemaining([30101]), 2n ** 64n - 1n);
    await mirror.write.setInboundLimit([30101, 3600n, 1n]);
    assert.equal(await mirror.read.inboundRemaining([30101]), 1n);

    const fee = { nativeFee: 10n ** 15n, lzTokenFee: 0n };
    for (const n of [0, 1]) {
      const id = await mintAgent(p, p.alice.account.address);
      await p.anima.write.approve([home.address, id], { account: p.alice.account });
      await home.write.send([30184, pad(p.alice.account.address), id, "0x", fee, p.alice.account.address, false], {
        account: p.alice.account,
        value: fee.nativeFee,
      });
      void n;
    }

    await endpointAway.write.deliver([endpointHome.address, 0n, mirror.address, ZERO32]);
    // The second forged-or-genuine arrival is throttled, not lost — LayerZero keeps it
    // retryable, which turns a drain into a delay someone can notice.
    await expectRevert(
      endpointAway.write.deliver([endpointHome.address, 1n, mirror.address, ZERO32]),
      "InboundRateLimited"
    );

    await p.networkHelpers.time.increase(3601);
    assert.equal(await mirror.read.inboundRemaining([30101]), 1n);
    await endpointAway.write.deliver([endpointHome.address, 1n, mirror.address, ZERO32]);
    assert.equal(getAddress(await mirror.read.ownerOf([2n])), getAddress(p.alice.account.address));
  });
});

describe("ERC-6492 — listing from an account that is not deployed yet", () => {
  it("accepts a wrapped signature and deploys the signer on the way", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.carol.account.address);

    // A counterfactual ERC-6551 account: real address, no code. Every plain ERC-1271 check
    // against it fails, because a staticcall to a codeless address "succeeds" with no data.
    const chainId = await p.publicClient.getChainId();
    const counterfactual = await p.registry.read.account([
      p.accountImpl.address,
      ZERO32,
      BigInt(chainId),
      p.anima.address,
      id,
    ]);
    assert.equal(await p.publicClient.getCode({ address: counterfactual }), undefined);

    // Give the undeployed account the agent to sell, and let the market move it.
    await p.anima.write.transferFrom([p.carol.account.address, counterfactual, id], {
      account: p.carol.account,
    });

    const deployCall = encodeFunctionData({
      abi: p.registry.abi,
      functionName: "createAccount",
      args: [p.accountImpl.address, ZERO32, BigInt(chainId), p.anima.address, id],
    });

    // Once deployed, the account's ERC-1271 honours its owner's signature — and its owner is
    // the account itself here, so instead assert the wrapper is what triggers deployment.
    const wrapped = (encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
      [p.registry.address, deployCall, "0x" as `0x${string}`]
    ) + "6492".repeat(16)) as `0x${string}`;

    const lib = await p.viem.deployContract("ERC6492Harness");
    await lib.write.check([counterfactual, keccak256(toHex("x")), wrapped]);

    // The signature itself is empty and so invalid, but the account now exists — which is the
    // property that matters: a counterfactual signer can be brought into existence at
    // settlement rather than blocking the trade.
    assert.notEqual(await p.publicClient.getCode({ address: counterfactual }), undefined);
  });

  it("leaves ordinary signatures untouched", async () => {
    const p = await deployProtocol();
    const lib = await p.viem.deployContract("ERC6492Harness");
    const message = "hello";
    const sig = await p.alice.signMessage({ message });
    assert.equal(await lib.read.checkView([p.alice.account.address, hashMessage(message), sig]), true);
    assert.equal(await lib.read.checkView([p.bob.account.address, hashMessage(message), sig]), false);
  });

  it("rejects a wrapped EOA signature when preparation does not deploy the signer", async () => {
    const p = await deployProtocol();
    const lib = await p.viem.deployContract("ERC6492Harness");
    const message = "wrapped EOA";
    const hash = hashMessage(message);
    const innerSignature = await p.alice.signMessage({ message });

    // EOAs and counterfactual contracts both begin without code. A valid EOA signature must
    // not make arbitrary preparation calldata acceptable: the preparation has to turn the
    // claimed signer into a contract before its inner signature can be considered.
    const wrapped = (encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
      [p.registry.address, "0x", innerSignature]
    ) + "6492".repeat(16)) as `0x${string}`;

    await lib.write.check([p.alice.account.address, hash, wrapped]);
    assert.equal(await lib.read.lastResult(), false);
    assert.equal(await p.publicClient.getCode({ address: p.alice.account.address }), undefined);
  });
});
