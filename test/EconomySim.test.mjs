import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { policies, worlds, simulate } from "../scripts/economy-sim.mjs";

const runReport = () => JSON.parse(execFileSync(process.execPath, ["scripts/economy-sim.mjs"], {
  env: { ...process.env, SIM_RUNS: "30", SIM_DAYS: "90", SIM_SEED: "42" }, encoding: "utf8"
}));

test("report is deterministic without presupposing a winning policy", () => {
  const a = runReport(), b = runReport();
  assert.deepEqual(a, b);
  assert.equal(a.cells.length, Object.keys(policies).length * Object.keys(worlds).length);
  assert.equal(a.interpretation, "synthetic stress test, not forecast");
});

test("every policy-world cell conserves value and stays in its domain", () => {
  for (const policy of Object.values(policies)) for (const world of Object.values(worlds)) {
    for (let seed = 0; seed < 40; seed++) {
      const r = simulate(policy, world, seed, 60);
      assert.ok(Math.abs(r.accountedValue - (800 + r.totalInflow - r.totalOutflow)) < 1e-6);
      assert.ok(r.active >= 1 && r.agents >= 8 && r.treasury >= 0 && r.agentCapital >= 0);
      assert.ok(r.abuseShare >= 0 && r.abuseShare <= 1);
      assert.ok(r.meanRetention >= 0 && r.meanRetention <= 1);
    }
  }
});

test("anti-abuse friction has a cost as well as a benefit", () => {
  const sum = (policy, field) => Array.from({ length: 80 }, (_, seed) =>
    simulate(policy, worlds.adversarial, seed, 180)[field]).reduce((a, b) => a + b, 0);
  assert.ok(sum(policies.safetyFirst, "detectedAbuse") > sum(policies.minimal, "detectedAbuse"));
  assert.ok(sum(policies.safetyFirst, "blockedLegitimate") > sum(policies.minimal, "blockedLegitimate"),
    "guards must expose their false-positive/opportunity cost proxy");
});

test("invalid run controls fail closed", () => {
  assert.throws(() => execFileSync(process.execPath, ["scripts/economy-sim.mjs"], {
    env: { ...process.env, SIM_RUNS: "0" }, stdio: "pipe"
  }));
});
