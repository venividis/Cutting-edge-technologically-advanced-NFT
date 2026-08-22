import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployProtocol, mintAgent, DAY } from "./helpers.js";

describe("ZZ fuzz — bond vault", () => {
  it("holds total >= reserved + unbonding and solvency under random ops", async () => {
    const p = await deployProtocol();
    const vault = await p.viem.deployContract("BondVault", [
      p.usdc.address, p.anima.address, Number(7n * DAY), p.deployer.account.address,
    ]);
    await vault.write.setModule([p.deployer.account.address, true]);
    await vault.write.setArbiter([p.deployer.account.address, true]);

    const idA = await mintAgent(p, p.alice.account.address);
    const idB = await mintAgent(p, p.bob.account.address);
    const ids = [idA, idB];
    const owners = [p.alice, p.bob];

    let seed = 999n;
    const rnd = (m: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 64n); return seed % m; };

    let fails = 0;
    for (let i = 0; i < 300; i++) {
      const k = Number(rnd(2n));
      const id = ids[k];
      const owner = owners[k];
      const op = Number(rnd(7n));
      try {
        if (op === 0) {
          const amt = rnd(1_000_000n) + 1n;
          await p.usdc.write.mint([p.deployer.account.address, amt]);
          await p.usdc.write.approve([vault.address, amt]);
          await vault.write.deposit([id, amt]);
        } else if (op === 1) {
          const b = await vault.read.bondOf([id]);
          const free = await vault.read.availableCoverage([id]);
          if (free > 0n) await vault.write.reserve([id, rnd(free) + 1n]);
        } else if (op === 2) {
          const b = await vault.read.bondOf([id]);
          if (b.reserved > 0n) await vault.write.release([id, rnd(BigInt(b.reserved)) + 1n]);
        } else if (op === 3) {
          const free = await vault.read.availableCoverage([id]);
          if (free > 0n) await vault.write.requestUnbond([id, rnd(free) + 1n], { account: owner.account });
        } else if (op === 4) {
          await vault.write.cancelUnbond([id], { account: owner.account });
        } else if (op === 5) {
          const b = await vault.read.bondOf([id]);
          if (b.total > 0n) await vault.write.slash([id, rnd(BigInt(b.total)) + 1n, p.carol.account.address, "0x" + "00".repeat(32) as any]);
        } else {
          await p.networkHelpers.time.increase(Number(rnd(1_000_000n)));
          try { await vault.write.withdraw([id]); } catch {}
        }
      } catch (e) { fails++; }

      let sum = 0n;
      for (const j of ids) {
        const b = await vault.read.bondOf([j]);
        assert.ok(BigInt(b.total) >= BigInt(b.reserved) + BigInt(b.unbonding),
          `iter ${i} agent ${j}: total ${b.total} < reserved ${b.reserved} + unbonding ${b.unbonding}`);
        sum += BigInt(b.total);
      }
      const tb: bigint = await vault.read.totalBonded();
      const held: bigint = await p.usdc.read.balanceOf([vault.address]);
      assert.equal(sum, tb, `iter ${i}: sum(total)=${sum} != totalBonded=${tb}`);
      assert.ok(held >= tb, `iter ${i}: held ${held} < totalBonded ${tb}`);
    }
    console.log("bondvault fuzz done, reverts:", fails);
  });
});
