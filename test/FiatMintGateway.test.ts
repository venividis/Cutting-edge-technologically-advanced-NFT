import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { blankModel, deployProtocol, expectRevert, ZERO32 } from "./helpers.js";

describe("FiatMintGateway", () => {
  async function fixture() {
    const p = await deployProtocol({ impl: "monolith" });
    const gateway = await p.viem.deployContract("FiatMintGateway", [
      p.anima.address,
      p.usdc.address,
      p.treasury.account.address,
      p.deployer.account.address,
      p.deployer.account.address,
    ]);
    await gateway.write.setProcessor([p.carol.account.address, true]);
    await p.usdc.write.mint([p.treasury.account.address, 10_000_000_000n]);
    await p.usdc.write.approve([gateway.address, 10_000_000_000n], {
      account: p.treasury.account,
    });
    const purchase = {
      settlementId: keccak256(toHex("stripe:pi_123")),
      recipient: p.alice.account.address,
      cashAmountUsdCents: 100_000n,
      stableAmount: 1_000_000_000n,
      minimumNetAmount: 970_000_000n,
      feeBps: 250,
      agentURI: "ipfs://cash-funded-agent",
      manifestHash: ZERO32,
      model: blankModel(),
      shards: [],
      seal: 0,
      metadata: [],
    };
    return { p, gateway, purchase };
  }

  it("atomically mints to the buyer and puts net aUSD in its account", async () => {
    const { p, gateway, purchase } = await fixture();
    await gateway.write.settleAndMint([purchase], { account: p.carol.account });

    assert.equal(await p.anima.read.ownerOf([1n]), p.alice.account.address);
    const account = await p.anima.read.accountOf([1n]);
    assert.equal(await p.usdc.read.balanceOf([account]), 975_000_000n);
    assert.equal(
      await p.usdc.read.balanceOf([p.deployer.account.address]),
      25_000_000n,
    );
    assert.notEqual(await p.publicClient.getCode({ address: account }), "0x");
    assert.equal(await gateway.read.settled([purchase.settlementId]), true);
  });

  it("rejects replayed settlements and unauthorized callers", async () => {
    const { p, gateway, purchase } = await fixture();
    await expectRevert(
      gateway.write.settleAndMint([purchase], { account: p.alice.account }),
      "NotProcessor",
    );
    await gateway.write.settleAndMint([purchase], { account: p.carol.account });
    await expectRevert(
      gateway.write.settleAndMint([purchase], { account: p.carol.account }),
      "SettlementAlreadyUsed",
    );
  });

  it("enforces the customer minimum and permanent fee ceiling", async () => {
    const { p, gateway, purchase } = await fixture();
    await expectRevert(
      gateway.write.settleAndMint(
        [{ ...purchase, minimumNetAmount: 976_000_000n }],
        { account: p.carol.account },
      ),
      "NetAmountBelowMinimum",
    );
    await expectRevert(
      gateway.write.settleAndMint([{ ...purchase, feeBps: 1001 }], {
        account: p.carol.account,
      }),
      "FeeTooHigh",
    );
    assert.equal(await p.anima.read.totalMinted(), 0n);
    assert.equal(await gateway.read.settled([purchase.settlementId]), false);
  });
});
