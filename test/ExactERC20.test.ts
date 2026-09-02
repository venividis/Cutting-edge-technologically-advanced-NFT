import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";
import { expectRevert } from "./helpers.js";

describe("Exact ERC-20 settlement", () => {
  it("refuses to create treasury liabilities from nominal fee-on-transfer amounts", async () => {
    const { viem } = await network.connect();
    const [holder] = await viem.getWalletClients();
    const quote = await viem.deployContract("MockTaxERC20");
    const token = await viem.deployContract("AgentToken", [
      "Agent Share",
      "AGENT",
      quote.address,
      zeroAddress,
      1n,
      1_000n,
      holder.account.address,
    ]);

    await quote.write.mint([holder.account.address, 1_000n]);
    await quote.write.approve([token.address, 1_000n]);
    await expectRevert(token.write.contribute([1_000n]), "InexactERC20Transfer");

    assert.equal(await token.read.treasury(), 0n);
    assert.equal(await quote.read.balanceOf([getAddress(token.address)]), 0n);
  });

  it("reverts atomically when a redemption recipient would be short-paid", async () => {
    const { viem } = await network.connect();
    const [holder] = await viem.getWalletClients();
    const quote = await viem.deployContract("MockTaxERC20");
    const token = await viem.deployContract("AgentToken", [
      "Agent Share",
      "AGENT",
      quote.address,
      zeroAddress,
      1n,
      1_000n,
      holder.account.address,
    ]);

    await quote.write.mint([holder.account.address, 1_000n]);
    await quote.write.transfer([token.address, 1_000n]);
    await token.write.sync();
    assert.equal(await token.read.treasury(), 900n);

    await expectRevert(token.write.redeem([1_000n]), "InexactERC20Transfer");
    assert.equal(await token.read.totalSupply(), 1_000n);
    assert.equal(await token.read.treasury(), 900n);
  });
});
