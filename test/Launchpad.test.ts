import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, AgentStatus } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;
const TOKENS = (n: bigint) => n * 10n ** 18n;

const TOTAL_SUPPLY = TOKENS(1_000_000_000n);
const CURVE_SUPPLY = TOKENS(800_000_000n);
const VIRTUAL_QUOTE = USDC(1000);
// With virtualQuote = $1,000 and 800M of a 1B supply on the curve, the maximum the curve
// can ever raise is $4,000 — at that point baseSold hits curveSupply. The target has to sit
// inside that, or graduation would depend entirely on the exhaustion fallback.
const GRADUATION = USDC(3000);

async function setupLaunch(
  p: Awaited<ReturnType<typeof deployProtocol>>,
  opts: { fairWindow?: bigint; maxBuy?: bigint; snipeTax?: number } = {}
) {
  const launchpad = await p.viem.deployContract("AgentLaunchpad", [
    p.usdc.address,
    p.anima.address,
    p.anima.address,
    p.deployer.account.address,
    p.treasury.account.address,
    { protocolBps: 100, treasuryBps: 100, agentBps: 100 }, // 1% each, 3% total
  ]);
  const deployer = await p.viem.deployContract("MockLiquidityDeployer");
  await launchpad.write.setLiquidityDeployer([deployer.address]);

  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });

  await launchpad.write.createLaunch(
    [
      {
        agentId: id,
        name: "Agent One",
        symbol: "AGENT1",
        totalSupply: TOTAL_SUPPLY,
        curveSupply: CURVE_SUPPLY,
        virtualQuote: VIRTUAL_QUOTE,
        graduationTarget: GRADUATION,
        startsAt: 0n,
        fairWindow: opts.fairWindow ?? 0n,
        maxBuyInWindow: opts.maxBuy ?? USDC(100),
        snipeTaxStartBps: opts.snipeTax ?? 0,
        lpRecipient: "0x000000000000000000000000000000000000dEaD",
      },
    ],
    { account: p.alice.account }
  );

  const launch = await launchpad.read.launchOf([1n]);
  const token = await p.viem.getContractAt("AgentToken", launch.token);
  return { launchpad, deployer, id, token, launchId: 1n };
}

async function buy(p: any, launchpad: any, who: any, amount: bigint) {
  await p.usdc.write.mint([who.account.address, amount]);
  await p.usdc.write.approve([launchpad.address, amount], { account: who.account });
  return await launchpad.write.buy([1n, amount, 0n], { account: who.account });
}

describe("AgentLaunchpad — the curve", () => {
  it("refuses a launch from anyone but the agent's owner, and refuses a second one", async () => {
    const p = await deployProtocol();
    const { launchpad, id } = await setupLaunch(p);
    const params = {
      agentId: id,
      name: "x",
      symbol: "X",
      totalSupply: TOTAL_SUPPLY,
      curveSupply: CURVE_SUPPLY,
      virtualQuote: VIRTUAL_QUOTE,
      graduationTarget: GRADUATION,
      startsAt: 0n,
      fairWindow: 0n,
      maxBuyInWindow: USDC(100),
      snipeTaxStartBps: 0,
      lpRecipient: "0x000000000000000000000000000000000000dEaD" as const,
    };
    await expectRevert(launchpad.write.createLaunch([params], { account: p.bob.account }), "NotAgentOwner");
    await expectRevert(launchpad.write.createLaunch([params], { account: p.alice.account }), "AlreadyLaunched");
  });

  it("rejects curve parameters that would let the base reserve reach zero", async () => {
    const p = await deployProtocol();
    const { launchpad } = await setupLaunch(p);
    const id2 = await mintAgent(p, p.alice.account.address);
    await expectRevert(
      launchpad.write.createLaunch(
        [
          {
            agentId: id2,
            name: "x",
            symbol: "X",
            totalSupply: TOTAL_SUPPLY,
            curveSupply: TOTAL_SUPPLY, // selling the entire reserve is a division by zero
            virtualQuote: VIRTUAL_QUOTE,
            graduationTarget: GRADUATION,
            startsAt: 0n,
            fairWindow: 0n,
            maxBuyInWindow: USDC(100),
            snipeTaxStartBps: 0,
            lpRecipient: "0x000000000000000000000000000000000000dEaD",
          },
        ],
        { account: p.alice.account }
      ),
      "BadCurveParameters"
    );
  });

  it("prices later buyers higher than earlier ones", async () => {
    const p = await deployProtocol();
    const { launchpad, token } = await setupLaunch(p);

    await buy(p, launchpad, p.bob, USDC(500));
    const first = await token.read.balanceOf([p.bob.account.address]);
    await buy(p, launchpad, p.carol, USDC(500));
    const second = await token.read.balanceOf([p.carol.account.address]);

    assert.ok(second < first, "a constant-product curve must get more expensive as it fills");
  });

  it("never lets a round trip extract more than was put in", async () => {
    const p = await deployProtocol();
    const { launchpad, token } = await setupLaunch(p);

    await buy(p, launchpad, p.bob, USDC(500));
    const held = await token.read.balanceOf([p.bob.account.address]);
    const spent = USDC(500);

    await token.write.approve([launchpad.address, held], { account: p.bob.account });
    await launchpad.write.sell([1n, held, 0n], { account: p.bob.account });

    const back = await p.usdc.read.balanceOf([p.bob.account.address]);
    assert.ok(back < spent, `round trip must lose to fees and rounding: got ${back} vs ${spent}`);
  });

  it("honours a slippage floor", async () => {
    const p = await deployProtocol();
    const { launchpad } = await setupLaunch(p);
    await p.usdc.write.mint([p.bob.account.address, USDC(500)]);
    await p.usdc.write.approve([launchpad.address, USDC(500)], { account: p.bob.account });
    await expectRevert(
      launchpad.write.buy([1n, USDC(500), TOKENS(999_000_000n)], { account: p.bob.account }),
      "SlippageExceeded"
    );
  });

  it("caps per-address buying during the fair window, then lifts the cap", async () => {
    const p = await deployProtocol();
    const { launchpad } = await setupLaunch(p, { fairWindow: 3600n, maxBuy: USDC(100) });

    await buy(p, launchpad, p.bob, USDC(100));
    await expectRevert(buy(p, launchpad, p.bob, USDC(50)), "FairWindowCapExceeded");

    await p.networkHelpers.time.increase(3601);
    await buy(p, launchpad, p.bob, USDC(1000)); // cap no longer applies
  });
});

describe("AgentToken — the redemption floor", () => {
  it("routes a share of every trade into the treasury, raising the floor", async () => {
    const p = await deployProtocol();
    const { launchpad, token, id } = await setupLaunch(p);

    assert.equal(await token.read.floorPerToken(), 0n);
    await buy(p, launchpad, p.bob, USDC(1000));

    // 1% of the trade goes to the redemption treasury...
    assert.equal(await token.read.treasury(), USDC(10));
    assert.ok((await token.read.floorPerToken()) > 0n);
    // ...1% to the protocol, and 1% to the agent's own account.
    assert.equal(await p.usdc.read.balanceOf([await p.anima.read.accountOf([id])]), USDC(10));
    assert.equal(await p.usdc.read.balanceOf([p.treasury.account.address]), USDC(10));
  });

  it("pays out pro-rata on burn and leaves the floor per token unchanged", async () => {
    const p = await deployProtocol();
    const { launchpad, token } = await setupLaunch(p);
    await buy(p, launchpad, p.bob, USDC(2000));

    const floorBefore = await token.read.floorPerToken();
    const held = await token.read.balanceOf([p.bob.account.address]);
    const preview = await token.read.previewRedeem([held / 2n]);
    const usdcBefore = await p.usdc.read.balanceOf([p.bob.account.address]);

    await token.write.redeem([held / 2n], { account: p.bob.account });

    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]) - usdcBefore, preview);
    const floorAfter = await token.read.floorPerToken();
    // The invariant that matters: redeeming never dilutes the holders who stayed. Rounding
    // is deliberately in their favour, so the floor may tick up by dust but never down.
    assert.ok(floorAfter >= floorBefore, `floor fell from ${floorBefore} to ${floorAfter}`);
    assert.ok(
      (floorAfter - floorBefore) * 1_000_000n < floorBefore,
      `floor drift should be dust, moved ${floorBefore} -> ${floorAfter}`
    );
  });

  it("recognises revenue sent by a plain transfer only when synced", async () => {
    const p = await deployProtocol();
    const { token } = await setupLaunch(p);

    await p.usdc.write.mint([p.bob.account.address, USDC(500)]);
    await p.usdc.write.transfer([token.address, USDC(500)], { account: p.bob.account });

    // Tracking treasury explicitly means a stray transfer cannot silently move the floor.
    assert.equal(await token.read.treasury(), 0n);
    await token.write.sync();
    assert.equal(await token.read.treasury(), USDC(500));
  });

  it("has no mint function, so the floor cannot be diluted", async () => {
    const p = await deployProtocol();
    const { token } = await setupLaunch(p);
    assert.equal(
      token.abi.some((e: any) => e.type === "function" && e.name === "mint"),
      false
    );
    assert.equal(await token.read.totalSupply(), TOTAL_SUPPLY);
  });
});

describe("AgentLaunchpad — graduation", () => {
  it("refuses to graduate before the target is met", async () => {
    const p = await deployProtocol();
    const { launchpad } = await setupLaunch(p);
    await buy(p, launchpad, p.bob, USDC(100));
    await expectRevert(launchpad.write.graduate([1n]), "NotGraduatable");
  });

  it("moves the raise and the unsold supply into locked liquidity, permissionlessly", async () => {
    const p = await deployProtocol();
    const { launchpad, deployer, token } = await setupLaunch(p);
    await buy(p, launchpad, p.bob, USDC(3500));

    const raised = await launchpad.read.raisedOf([1n]);
    assert.ok(raised >= GRADUATION);

    // Anyone may graduate: it must not depend on the creator showing up.
    await launchpad.write.graduate([1n], { account: p.carol.account });

    assert.equal((await launchpad.read.launchOf([1n])).graduated, true);
    assert.equal(await deployer.read.lastQuoteAmount(), raised);
    assert.equal(
      getAddress(await deployer.read.lastLpRecipient()),
      getAddress("0x000000000000000000000000000000000000dEaD")
    );
    assert.ok((await deployer.read.lastTokenAmount()) > 0n);
    assert.equal(await token.read.balanceOf([launchpad.address]), 0n);

    await expectRevert(buy(p, launchpad, p.carol, USDC(10)), "AlreadyGraduated");
  });
});

describe("AgentLaunchpad — the anti-snipe tax", () => {
  it("charges 99% at the opening block and decays it to nothing", async () => {
    const p = await deployProtocol();
    const { launchpad, token } = await setupLaunch(p, { fairWindow: 100n, snipeTax: 9900 });

    assert.equal(await launchpad.read.snipeTaxBps([1n]), 9900n);

    // A sniper in the first block keeps almost nothing...
    await buy(p, launchpad, p.bob, USDC(1000));
    const sniped = await token.read.balanceOf([p.bob.account.address]);

    // ...and what they gave up went to the redemption treasury, not to a fee wallet.
    assert.ok((await token.read.treasury()) > USDC(900), "the tax must land with honest buyers");

    await p.networkHelpers.time.increase(101);
    assert.equal(await launchpad.read.snipeTaxBps([1n]), 0n);

    await buy(p, launchpad, p.carol, USDC(1000));
    const patient = await token.read.balanceOf([p.carol.account.address]);

    // Waiting out the window beats sniping, even though the curve got more expensive.
    assert.ok(patient > sniped, `patient ${patient} should beat sniped ${sniped}`);
  });

  it("cannot be escaped by splitting across addresses, unlike a per-address cap", async () => {
    const p = await deployProtocol();
    const { launchpad, token } = await setupLaunch(p, { fairWindow: 1000n, snipeTax: 9900 });

    // Three sybil addresses, each under any plausible per-address cap.
    for (const w of [p.bob, p.carol, p.deployer]) {
      await buy(p, launchpad, w, USDC(100));
    }
    // The tax is priced by time, not identity, so every one of them paid it.
    assert.ok((await token.read.treasury()) > USDC(250));
  });

  it("refuses a tax that would leave a buyer with nothing", async () => {
    const p = await deployProtocol();
    const { launchpad } = await setupLaunch(p);
    const id = await mintAgent(p, p.alice.account.address);
    await expectRevert(
      launchpad.write.createLaunch(
        [
          {
            agentId: id,
            name: "x",
            symbol: "X",
            totalSupply: TOTAL_SUPPLY,
            curveSupply: CURVE_SUPPLY,
            virtualQuote: VIRTUAL_QUOTE,
            graduationTarget: GRADUATION,
            startsAt: 0n,
            fairWindow: 100n,
            maxBuyInWindow: USDC(100),
            snipeTaxStartBps: 10_000,
            lpRecipient: "0x000000000000000000000000000000000000dEaD",
          },
        ],
        { account: p.alice.account }
      ),
      "SnipeTaxTooHigh"
    );
  });
});
