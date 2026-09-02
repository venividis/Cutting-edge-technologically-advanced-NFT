import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseEther } from "viem";
import { deployProtocol, mintAgent, expectRevert, AgentStatus, ZERO32 } from "./helpers.js";

const UNIT = (n: number | bigint) => BigInt(n) * 10n ** 18n;

async function tradingAgent(p: Awaited<ReturnType<typeof deployProtocol>>) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
  const accountAddress = await p.anima.read.accountOf([id]);
  const account = await p.viem.getContractAt("AgentAccount", accountAddress);

  const tokenIn = await p.viem.deployContract("MockERC20", ["In", "IN", 18]);
  const tokenOut = await p.viem.deployContract("MockERC20", ["Out", "OUT", 18]);
  const venue = await p.viem.deployContract("MockVenue");

  await tokenIn.write.mint([accountAddress, UNIT(1000)]);
  await tokenOut.write.mint([venue.address, UNIT(1000)]);
  await p.swapRouter.write.setVenue([venue.address, true]);
  await p.swapRouter.write.setLimit([id, tokenIn.address, UNIT(100), UNIT(250)], {
    account: p.alice.account,
  });

  // The account approves the router; the router is what the policy allowlists.
  await account.write.execute(
    [
      tokenIn.address,
      0n,
      encodeFunctionData({
        abi: tokenIn.abi,
        functionName: "approve",
        args: [p.swapRouter.address, UNIT(1000)],
      }),
      0,
    ],
    { account: p.alice.account }
  );

  const doSwap = async (amountIn: bigint, minOut: bigint, fn: "swap" | "partialSwap" = "swap") => {
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    const req = {
      agentId: id,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn,
      minOut,
      deadline,
      venue: venue.address,
      venueCalldata: encodeFunctionData({
        abi: venue.abi,
        functionName: fn,
        args: [tokenIn.address, tokenOut.address, amountIn],
      }),
    };
    return account.write.execute(
      [
        p.swapRouter.address,
        0n,
        encodeFunctionData({ abi: p.swapRouter.abi, functionName: "swap", args: [req] }),
        0,
      ],
      { account: p.alice.account }
    );
  };

  return { id, account, accountAddress, tokenIn, tokenOut, venue, doSwap };
}

describe("AgentSwapRouter — budgets denominated in the token", () => {
  it("swaps within the limit and delivers the output to the agent's account", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);

    await t.doSwap(UNIT(100), UNIT(100));
    assert.equal(await t.tokenOut.read.balanceOf([t.accountAddress]), UNIT(100));
    assert.equal(await t.tokenIn.read.balanceOf([t.accountAddress]), UNIT(900));
  });

  it("caps a single swap — the gap that a native-only spending limit leaves wide open", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    // Note the value of this call is zero: an ETH-denominated policy would wave it through.
    await expectRevert(t.doSwap(UNIT(101), 0n), "PerSwapCapExceeded");
  });

  it("caps daily volume across several swaps and resets the next day", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await t.doSwap(UNIT(100), 0n);
    await t.doSwap(UNIT(100), 0n);
    await expectRevert(t.doSwap(UNIT(100), 0n), "DailyCapExceeded");

    await p.networkHelpers.time.increase(86400);
    await t.doSwap(UNIT(100), 0n);
  });

  it("refuses a token the owner never allowed", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    const other = await p.viem.deployContract("MockERC20", ["X", "X", 18]);
    await other.write.mint([t.accountAddress, UNIT(10)]);
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    await expectRevert(
      t.account.write.execute(
        [
          p.swapRouter.address,
          0n,
          encodeFunctionData({
            abi: p.swapRouter.abi,
            functionName: "swap",
            args: [
              {
                agentId: t.id,
                tokenIn: other.address,
                tokenOut: t.tokenOut.address,
                amountIn: UNIT(1),
                minOut: 0n,
                deadline,
                venue: t.venue.address,
                venueCalldata: "0x",
              },
            ],
          }),
          0,
        ],
        { account: p.alice.account }
      ),
      "TokenNotTradeable"
    );
  });

  it("refuses an unlisted venue", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await p.swapRouter.write.setVenue([t.venue.address, false]);
    await expectRevert(t.doSwap(UNIT(10), 0n), "VenueNotAllowed");
  });

  it("catches a venue that under-delivers, by measuring the balance rather than trusting it", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await t.venue.write.setShortChange([true]);
    // The venue returns success and hands over half. Only a delta check notices.
    await expectRevert(t.doSwap(UNIT(100), UNIT(100)), "SlippageExceeded");
  });

  it("leaves no standing approval, and returns unspent input", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);

    await t.doSwap(UNIT(100), 0n, "partialSwap");

    assert.equal(
      await t.tokenIn.read.allowance([p.swapRouter.address, t.venue.address]),
      0n,
      "a dangling approval is the most exploited pattern in DeFi"
    );
    assert.equal(await t.tokenIn.read.balanceOf([p.swapRouter.address]), 0n);
    // Half was consumed by the venue; the rest came straight back to the agent.
    assert.equal(await t.tokenIn.read.balanceOf([t.accountAddress]), UNIT(950));
  });

  it("does not gift a pre-existing router balance to the next swapping agent", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await t.tokenIn.write.mint([p.swapRouter.address, UNIT(25)]);

    await t.doSwap(UNIT(100), 0n);

    assert.equal(await t.tokenIn.read.balanceOf([p.swapRouter.address]), UNIT(25));
    assert.equal(await t.tokenIn.read.balanceOf([t.accountAddress]), UNIT(900));
  });

  it("stops trading entirely while the agent is paused", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await p.anima.write.setStatus([t.id, AgentStatus.Paused], { account: p.alice.account });
    await expectRevert(t.doSwap(UNIT(10), 0n), "AgentNotActive");
  });

  it("refuses a caller that is not the agent's own account", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    const deadline = BigInt(await p.networkHelpers.time.latest()) + 3600n;
    await expectRevert(
      p.swapRouter.write.swap(
        [
          {
            agentId: t.id,
            tokenIn: t.tokenIn.address,
            tokenOut: t.tokenOut.address,
            amountIn: UNIT(1),
            minOut: 0n,
            deadline,
            venue: t.venue.address,
            venueCalldata: "0x",
          },
        ],
        { account: p.alice.account }
      ),
      "NotAgentAccount"
    );
  });

  it("lets a guardian cut off a token without waking the owner", async () => {
    const p = await deployProtocol();
    const t = await tradingAgent(p);
    await p.anima.write.setGuardian([t.id, p.guardian.account.address], { account: p.alice.account });
    await p.swapRouter.write.revokeToken([t.id, t.tokenIn.address], { account: p.guardian.account });
    await expectRevert(t.doSwap(UNIT(10), 0n), "TokenNotTradeable");
  });
});
