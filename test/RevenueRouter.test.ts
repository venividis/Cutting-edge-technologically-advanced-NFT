import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployProtocol, mintAgent, expectRevert } from "./helpers.js";

const U = (n: number | bigint) => BigInt(n) * 1_000_000n;

async function fixture() {
  const p = await deployProtocol();
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  const token = await p.viem.deployContract("AgentToken", [
    "Agent Share", "ASH", p.usdc.address, p.anima.address, id, U(1000), p.alice.account.address,
  ]);
  const router = await p.viem.deployContract("RevenueRouter", [p.usdc.address, p.anima.address, p.anima.address, p.bonds.address]);
  return { p, id, token, router };
}

describe("RevenueRouter — commitment-safe revenue waterfalls", () => {
  it("timelocks a policy and conserves every unit across the waterfall", async () => {
    const { p, id, token, router } = await fixture();
    await router.write.proposePolicy([id, token.address, p.treasury.account.address, 2000, 1000, 500, 500], { account: p.alice.account });
    await expectRevert(router.write.activatePolicy([id]), "PolicyNotReady");
    await p.networkHelpers.time.increase(2 * 24 * 60 * 60);
    await router.write.activatePolicy([id]);
    const hash = await router.read.revenueCommitment([id, p.carol.account.address]);
    const account = await p.anima.read.accountOf([id]);

    await p.usdc.write.mint([p.bob.account.address, U(100)]);
    await p.usdc.write.approve([router.address, U(100)], { account: p.bob.account });
    await router.write.routeExpected([id, U(100), p.carol.account.address, hash], { account: p.bob.account });

    assert.equal(await p.usdc.read.balanceOf([account]), U(60));
    assert.equal(await token.read.treasury(), U(20));
    assert.equal((await p.bonds.read.bondOf([id])).total, U(10));
    assert.equal(await p.usdc.read.balanceOf([p.carol.account.address]), U(5));
    assert.equal(await p.usdc.read.balanceOf([p.treasury.account.address]), U(5));
  });

  it("invalidates the seller's policy on transfer and rejects a stale quote", async () => {
    const { p, id, token, router } = await fixture();
    await router.write.proposePolicy([id, token.address, p.treasury.account.address, 1000, 0, 0, 0], { account: p.alice.account });
    await p.networkHelpers.time.increase(2 * 24 * 60 * 60);
    await router.write.activatePolicy([id]);
    const sellerHash = await router.read.revenueCommitment([id, p.alice.account.address]);
    await p.usdc.write.mint([p.carol.account.address, U(2)]);
    await p.usdc.write.approve([router.address, U(2)], { account: p.carol.account });
    await expectRevert(
      router.write.routeExpected([id, U(1), p.bob.account.address, sellerHash], { account: p.carol.account }),
      "StalePolicy"
    );
    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], { account: p.alice.account });
    assert.notEqual(await router.read.revenueCommitment([id, p.alice.account.address]), sellerHash);
    await expectRevert(router.write.routeExpected([id, U(1), p.alice.account.address, sellerHash], { account: p.carol.account }), "StalePolicy");
  });

  it("routes an accepted commitment after a replacement policy activates", async () => {
    const { p, id, token, router } = await fixture();
    await router.write.proposePolicy([id, token.address, p.treasury.account.address, 2000, 0, 0, 0], { account: p.alice.account });
    await p.networkHelpers.time.increase(2 * 24 * 60 * 60);
    await router.write.activatePolicy([id]);
    const acceptedCommitment = await router.read.revenueCommitment([id, p.carol.account.address]);

    await router.write.proposePolicy([id, token.address, p.treasury.account.address, 0, 0, 0, 2000], { account: p.alice.account });
    await p.networkHelpers.time.increase(2 * 24 * 60 * 60);
    await router.write.activatePolicy([id]);
    assert.notEqual(await router.read.revenueCommitment([id, p.carol.account.address]), acceptedCommitment);

    await p.usdc.write.mint([p.bob.account.address, U(100)]);
    await p.usdc.write.approve([router.address, U(100)], { account: p.bob.account });
    await router.write.routeExpected([id, U(100), p.carol.account.address, acceptedCommitment], { account: p.bob.account });

    assert.equal(await token.read.treasury(), U(20));
    assert.equal(await p.usdc.read.balanceOf([p.treasury.account.address]), 0n);
    assert.equal(await p.usdc.read.balanceOf([await p.anima.read.accountOf([id])]), U(80));
  });

  it("enforces an operating majority and caps referral extraction", async () => {
    const { p, id, token, router } = await fixture();
    await expectRevert(router.write.proposePolicy([id, token.address, p.treasury.account.address, 5000, 1, 0, 0], { account: p.alice.account }), "InvalidPolicy");
    await expectRevert(router.write.proposePolicy([id, token.address, p.treasury.account.address, 0, 0, 501, 0], { account: p.alice.account }), "InvalidPolicy");
  });
});
