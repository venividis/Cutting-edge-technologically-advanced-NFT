import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { deployProtocol, mintAgent, expectRevert, AgentStatus } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;
const MARKET = keccak256(toHex("AI10-PERP"));

async function desk(p: Awaited<ReturnType<typeof deployProtocol>>) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
  const accountAddress = await p.anima.read.accountOf([id]);
  const account = await p.viem.getContractAt("AgentAccount", accountAddress);

  const d = await p.viem.deployContract("AgentDerivativesDesk", [
    p.usdc.address,
    p.anima.address,
    p.anima.address,
    p.deployer.account.address,
  ]);
  const venue = await p.viem.deployContract("MockPerpVenue", [p.usdc.address]);
  await d.write.setVenue([venue.address, venue.address]);

  await p.usdc.write.mint([accountAddress, USDC(10_000)]);
  await account.write.execute(
    [
      p.usdc.address,
      0n,
      encodeFunctionData({ abi: p.usdc.abi, functionName: "approve", args: [d.address, USDC(10_000)] }),
      0,
    ],
    { account: p.alice.account }
  );

  const doTrade = async (marginIn: bigint) => {
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    return account.write.execute(
      [
        d.address,
        0n,
        encodeFunctionData({
          abi: d.abi,
          functionName: "trade",
          args: [
            {
              agentId: id,
              market: MARKET,
              venue: venue.address,
              marginIn,
              deadline,
              venueCalldata: encodeFunctionData({
                abi: venue.abi,
                functionName: "open",
                args: [accountAddress, MARKET, marginIn],
              }),
            },
          ],
        }),
        0,
      ],
      { account: p.alice.account }
    );
  };

  return { id, d, venue, account, accountAddress, doTrade };
}

describe("AgentDerivativesDesk — the leash survives leverage", () => {
  it("refuses a market the owner never opened", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await expectRevert(t.doTrade(USDC(100)), "MarketNotAllowed");
  });

  it("permits a trade inside the notional and leverage caps", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    // 10x venue: $100 margin becomes $1,000 notional.
    await t.d.write.setLimit([t.id, MARKET, USDC(2000), USDC(500), 1000], { account: p.alice.account });

    await t.doTrade(USDC(100));

    const pos = await t.d.read.positionOf([t.id, MARKET]);
    assert.equal(pos.marginAtRisk, USDC(100));
    assert.equal(pos.lastNotional, USDC(1000));
    assert.equal(await t.d.read.leverageX100([t.id, MARKET]), 1000n);
  });

  it("binds opaque venue calldata to the authenticated account and allowed market", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    const disallowedMarket = keccak256(toHex("DISALLOWED-PERP"));
    await t.d.write.setLimit([t.id, MARKET, USDC(2000), USDC(500), 1000], { account: p.alice.account });

    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    const trade = (account: `0x${string}`, market: `0x${string}`) =>
      t.account.write.execute(
        [
          t.d.address,
          0n,
          encodeFunctionData({
            abi: t.d.abi,
            functionName: "trade",
            args: [{
              agentId: t.id,
              market: MARKET,
              venue: t.venue.address,
              marginIn: USDC(100),
              deadline,
              venueCalldata: encodeFunctionData({
                abi: t.venue.abi,
                functionName: "open",
                args: [account, market, USDC(100)],
              }),
            }],
          }),
          0,
        ],
        { account: p.alice.account }
      );

    await expectRevert(trade(t.accountAddress, disallowedMarket), "InvalidVenueCalldata");
    await expectRevert(trade(p.bob.account.address, MARKET), "InvalidVenueCalldata");
    assert.equal(await t.venue.read.positionNotional([t.accountAddress, disallowedMarket]), 0n);
  });

  it("catches leverage the agent did not declare, by asking the venue what happened", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    // The owner permits 5x. The margin posted is small and perfectly within its cap...
    await t.d.write.setLimit([t.id, MARKET, USDC(100_000), USDC(5000), 500], { account: p.alice.account });
    // ...but the venue turns it into 25x, which no spot budget anywhere would notice.
    await t.venue.write.setLeverageX100([2500n]);

    await expectRevert(t.doTrade(USDC(100)), "LeverageCapExceeded");
  });

  it("caps absolute notional independently of leverage", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1500), USDC(5000), 1000], { account: p.alice.account });

    await t.doTrade(USDC(100)); // $1,000 notional — fine
    // A second trade at the same leverage would take the book to $2,000.
    await expectRevert(t.doTrade(USDC(100)), "NotionalCapExceeded");
  });

  it("caps the collateral that can be put at risk", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(150), 10_000], { account: p.alice.account });
    await t.doTrade(USDC(100));
    await expectRevert(t.doTrade(USDC(100)), "MarginCapExceeded");
  });

  it("caps collateral across the whole portfolio, not just per market", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    const other = keccak256(toHex("DEFENSE10-PERP"));
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(1_000_000), 10_000], {
      account: p.alice.account,
    });
    await t.d.write.setLimit([t.id, other, USDC(1_000_000), USDC(1_000_000), 10_000], {
      account: p.alice.account,
    });
    await t.d.write.setPortfolioLimit([t.id, USDC(150)], { account: p.alice.account });

    await t.doTrade(USDC(100));
    await expectRevert(t.doTrade(USDC(100)), "PortfolioCapExceeded");
  });

  it("refuses a position the desk cannot see collateral behind", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(5000), 10_000], { account: p.alice.account });
    // The venue opens a position while consuming none of the posted margin — cross-margined
    // from elsewhere, or an adapter reporting nonsense. Either way it is unbounded leverage.
    await t.venue.write.setMarginToConsumeBps([0n]);
    await expectRevert(t.doTrade(USDC(100)), "LeverageCapExceeded");
  });

  it("returns unconsumed collateral to the agent rather than holding it", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(5000), 10_000], { account: p.alice.account });
    await t.venue.write.setMarginToConsumeBps([5000n]); // venue takes only half

    await t.doTrade(USDC(100));

    assert.equal((await t.d.read.positionOf([t.id, MARKET])).marginAtRisk, USDC(50));
    assert.equal(await p.usdc.read.balanceOf([t.d.address]), 0n);
    assert.equal(await p.usdc.read.balanceOf([t.accountAddress]), USDC(9950));
  });

  it("stops trading when the agent is paused, and when a guardian halts the market", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(5000), 10_000], { account: p.alice.account });
    await p.anima.write.setGuardian([t.id, p.guardian.account.address], { account: p.alice.account });

    await p.anima.write.setStatus([t.id, AgentStatus.Paused], { account: p.alice.account });
    await expectRevert(t.doTrade(USDC(10)), "AgentNotActive");
    await p.anima.write.setStatus([t.id, AgentStatus.Active], { account: p.alice.account });

    await t.d.write.haltMarket([t.id, MARKET], { account: p.guardian.account });
    await expectRevert(t.doTrade(USDC(10)), "MarketNotAllowed");
  });

  it("refuses an unlisted venue and a caller that is not the agent's account", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await t.d.write.setLimit([t.id, MARKET, USDC(1_000_000), USDC(5000), 10_000], { account: p.alice.account });

    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    await expectRevert(
      t.d.write.trade(
        [{ agentId: t.id, market: MARKET, venue: t.venue.address, marginIn: 1n, deadline, venueCalldata: "0x" }],
        { account: p.alice.account }
      ),
      "NotAgentAccount"
    );

    await t.d.write.setVenue([t.venue.address, "0x0000000000000000000000000000000000000000"]);
    await expectRevert(t.doTrade(USDC(10)), "VenueNotAllowed");
  });

  it("rejects a leverage limit below 1x as a configuration error", async () => {
    const p = await deployProtocol();
    const t = await desk(p);
    await expectRevert(
      t.d.write.setLimit([t.id, MARKET, USDC(100), USDC(100), 50], { account: p.alice.account }),
      "BadLeverage"
    );
  });
});
