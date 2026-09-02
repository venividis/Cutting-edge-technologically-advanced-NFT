#!/usr/bin/env node
/**
 * Deterministic, dependency-free stress model for ANIMA micro-economies.
 * It is deliberately comparative and falsifiable: no policy is named "recommended", and
 * results are reported across incompatible behavioral worlds rather than one favored story.
 */
import { writeFileSync } from "node:fs";

const DAYS = positiveInt("SIM_DAYS", 180);
const RUNS = positiveInt("SIM_RUNS", 250);
const SEED = integer("SIM_SEED", 7857);

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}
function positiveInt(name, fallback) {
  const value = integer(name, fallback);
  if (value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = Math.imul(x ^ (x >>> 15), 1 | x), x ^= x + Math.imul(x ^ (x >>> 7), 61 | x), ((x ^ (x >>> 14)) >>> 0) / 2 ** 32));
}

export const policies = {
  minimal: { protocolBps: 100, treasuryBps: 0, bondSignal: 0, evidence: 0, referralCredit: 0, sybilFriction: 0 },
  feeHeavy: { protocolBps: 300, treasuryBps: 0, bondSignal: 0.1, evidence: 0.1, referralCredit: 8, sybilFriction: 0 },
  splitRevenue: { protocolBps: 75, treasuryBps: 100, bondSignal: 0.55, evidence: 0.65, referralCredit: 3, sybilFriction: 0.65 },
  safetyFirst: { protocolBps: 125, treasuryBps: 50, bondSignal: 0.85, evidence: 0.8, referralCredit: 0, sybilFriction: 0.9 },
};

export const worlds = {
  organic: { demand: 1, priceElasticity: 0.8, sybilRate: 0.01, cartelRate: 0.01, shockChance: 0.002, quality: 0.82 },
  priceSensitive: { demand: 0.8, priceElasticity: 3.2, sybilRate: 0.015, cartelRate: 0.01, shockChance: 0.002, quality: 0.82 },
  adversarial: { demand: 1, priceElasticity: 1, sybilRate: 0.12, cartelRate: 0.08, shockChance: 0.005, quality: 0.72 },
  contraction: { demand: 0.65, priceElasticity: 1.8, sybilRate: 0.03, cartelRate: 0.03, shockChance: 0.035, quality: 0.76 },
};

export function simulate(policy, world, seed, days = DAYS) {
  const random = rng(seed);
  const state = { users: 40, active: 30, agents: 8, treasury: 0, agentCapital: 800, protocol: 0,
    externalVolume: 0, circularVolume: 0, failures: 0, losses: 0, referrals: 0, subsidy: 0,
    jobs: 0, retained: 0, detectedAbuse: 0, blockedLegitimate: 0, totalInflow: 0, totalOutflow: 0 };

  for (let day = 0; day < days; day++) {
    const totalBps = policy.protocolBps + policy.treasuryBps;
    const feeDrag = totalBps / 10_000 * world.priceElasticity;
    const trust = Math.min(1, 0.32 + policy.bondSignal * Math.log1p(state.agentCapital / state.agents) / 6 + policy.evidence * 0.12);
    const topology = Math.log1p(state.active) * Math.log1p(state.agents) / 10;
    const retention = Math.max(0.45, Math.min(0.985, 0.77 + trust * 0.1 - feeDrag + Math.log1p(state.treasury) * 0.002));
    state.active = Math.max(1, Math.round(state.active * retention));
    state.retained += retention;

    const organic = Math.floor(world.demand * (0.4 + topology * trust) * (0.5 + random()));
    const invited = Math.floor(state.active * policy.referralCredit / 100 * (0.5 + random()));
    state.users += organic + invited;
    state.active += organic + invited;
    state.referrals += invited;
    state.subsidy += invited * policy.referralCredit;
    if (random() < 0.025 + state.active / 12_000) { state.agents++; state.agentCapital += 75; state.totalInflow += 75; }

    if (random() < world.shockChance) {
      const shock = state.agentCapital * (0.05 + random() * 0.15);
      state.agentCapital -= shock;
      state.losses += shock;
      state.totalOutflow += shock;
    }

    const attemptedJobs = Math.floor(state.active * world.demand * (0.045 + topology * 0.025) * (0.75 + random() / 2));
    for (let j = 0; j < attemptedJobs; j++) {
      const adversarial = random() < world.sybilRate + policy.referralCredit / 2_000;
      const cartel = !adversarial && random() < world.cartelRate;
      const detected = (adversarial || cartel) && random() < policy.sybilFriction * (0.45 + policy.evidence * 0.4);
      if (detected) { state.detectedAbuse++; continue; }
      // No classifier is perfect. Stronger friction also rejects some legitimate edge cases;
      // recording that cost prevents the model from treating safety as a free improvement.
      if (!adversarial && !cartel && random() < policy.sybilFriction * 0.008) {
        state.blockedLegitimate++;
        continue;
      }

      const price = 8 + random() * 42;
      const circular = adversarial || cartel;
      const successChance = circular ? 0.98 : Math.min(0.98, world.quality * (0.78 + trust * 0.22));
      const fee = price * policy.protocolBps / 10_000;
      const backing = price * policy.treasuryBps / 10_000;
      const payout = price - fee - backing;
      state.jobs++;
      state.totalInflow += price;
      state.protocol += fee;
      state.treasury += backing;
      state.agentCapital += payout;
      if (circular) state.circularVolume += price;
      else state.externalVolume += price;
      if (random() > successChance) {
        const loss = Math.min(price, state.agentCapital, 20 * (0.25 + policy.bondSignal));
        state.failures++;
        state.losses += loss;
        state.agentCapital -= loss;
        state.totalOutflow += loss;
      }
    }
  }

  // Conservation identity for model-held value; client payments are inflows and losses outflows.
  const accounted = state.protocol + state.treasury + state.agentCapital;
  const expected = 800 + state.totalInflow - state.totalOutflow;
  if (Math.abs(accounted - expected) > 1e-7 * Math.max(1, expected)) throw new Error("accounting invariant violated");
  const genuineVolume = state.externalVolume;
  return { ...state, meanRetention: state.retained / days,
    abuseShare: (state.circularVolume / Math.max(1, state.externalVolume + state.circularVolume)),
    backingPerAgent: state.treasury / state.agents,
    subsidyAdjustedValue: genuineVolume - state.subsidy - state.losses,
    accountedValue: accounted };
}

function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; }
function summarize(rows) {
  const excluded = new Set(["retained", "totalInflow", "totalOutflow"]);
  return Object.fromEntries(Object.keys(rows[0]).filter(k => !excluded.has(k)).map(k => {
    const xs = rows.map(r => r[k]).sort((a, b) => a - b);
    return [k, { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p10: quantile(xs, .1), p50: quantile(xs, .5), p90: quantile(xs, .9) }];
  }));
}

function experiment() {
  const cells = [];
  for (const [worldName, world] of Object.entries(worlds)) {
    for (const [policyName, policy] of Object.entries(policies)) {
      const rows = Array.from({ length: RUNS }, (_, i) => simulate(policy, world, SEED + i * 7919));
      cells.push({ world: worldName, policy: policyName, parameters: { policy, world }, stats: summarize(rows) });
    }
  }
  const winners = {};
  for (const world of Object.keys(worlds)) {
    const candidates = cells.filter(c => c.world === world);
    winners[world] = {
      subsidyAdjustedValue: [...candidates].sort((a, b) => b.stats.subsidyAdjustedValue.mean - a.stats.subsidyAdjustedValue.mean)[0].policy,
      lowestAbuseShare: [...candidates].sort((a, b) => a.stats.abuseShare.mean - b.stats.abuseShare.mean)[0].policy,
      activeUsers: [...candidates].sort((a, b) => b.stats.active.mean - a.stats.active.mean)[0].policy,
    };
  }
  return { model: "anima-economy-stress-v2", interpretation: "synthetic stress test, not forecast",
    seed: SEED, days: DAYS, runsPerCell: RUNS,
    dimensions: ["time", "population", "trust", "capital", "information", "network topology", "strategy", "risk", "governance"],
    policies, worlds, winners, cells };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = JSON.stringify(experiment(), null, 2) + "\n";
  if (process.argv[2]) writeFileSync(process.argv[2], json);
  process.stdout.write(json);
}
