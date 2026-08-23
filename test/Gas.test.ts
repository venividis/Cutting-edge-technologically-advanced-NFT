import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, zeroAddress } from "viem";
import { deployProtocol, mintAgent, shard, model, SealPolicy, AgentStatus, ZERO32, DAY } from "./helpers.js";

/**
 * What the diamond actually costs.
 *
 * The README claims the price of removing EIP-170's ceiling is "one DELEGATECALL". That is a
 * claim about gas, and a claim about gas that nobody measured is a guess. This file measures it,
 * prints the table, and fails if the overhead ever moves outside a band — so the number in the
 * docs stays true as the code changes.
 *
 * The overhead has three parts and only one of them is the DELEGATECALL itself:
 *   1. the `SLOAD` of the selector table (cold, 2,100 gas the first time in a transaction),
 *   2. the DELEGATECALL and the calldata copy,
 *   3. the fact that a facet reads agent state through a mapping in an ERC-7201 namespace where
 *      the monolith reads it from a compiler-assigned slot — the same cost, but reached via one
 *      extra keccak in some paths.
 *
 * Numbers are from `hardhat`'s in-process chain at solc 0.8.28 / viaIR / runs 200 / cancun.
 */

/** Widest overhead any single call may show, as a fraction of the monolith's cost. */
const MAX_RELATIVE_OVERHEAD = 0.25;
/** Widest absolute overhead, for cheap views where a small constant is a large fraction. */
const MAX_ABSOLUTE_OVERHEAD = 6_000n;

type Probe = { name: string; kind: "write" | "view"; run: (p: any, id: bigint) => Promise<bigint> };

async function writeGas(p: any, fn: string, args: unknown[], account?: any) {
  const hash = await p.anima.write[fn](args, account ? { account } : undefined);
  const receipt = await p.publicClient.waitForTransactionReceipt({ hash });
  return receipt.gasUsed;
}

async function viewGas(p: any, fn: string, args: unknown[]) {
  return await p.publicClient.estimateGas({
    to: p.anima.address,
    data: encodeFunctionData({ abi: p.anima.abi, functionName: fn, args }),
  });
}

const PROBES: Probe[] = [
  // The hot path every marketplace touches.
  { name: "ownerOf", kind: "view", run: (p, id) => viewGas(p, "ownerOf", [id]) },
  { name: "balanceOf", kind: "view", run: (p) => viewGas(p, "balanceOf", [p.alice.account.address]) },
  { name: "tokenURI", kind: "view", run: (p, id) => viewGas(p, "tokenURI", [id]) },
  { name: "supportsInterface", kind: "view", run: (p) => viewGas(p, "supportsInterface", ["0x80ac58cd"]) },
  { name: "locked", kind: "view", run: (p, id) => viewGas(p, "locked", [id]) },
  { name: "isApprovedForAll", kind: "view", run: (p) => viewGas(p, "isApprovedForAll", [p.alice.account.address, p.bob.account.address]) },

  // The reads an integrator makes before hiring or buying.
  { name: "statusOf", kind: "view", run: (p, id) => viewGas(p, "statusOf", [id]) },
  { name: "policyOf", kind: "view", run: (p, id) => viewGas(p, "policyOf", [id]) },
  { name: "accountOf", kind: "view", run: (p, id) => viewGas(p, "accountOf", [id]) },
  { name: "getStateFingerprint", kind: "view", run: (p, id) => viewGas(p, "getStateFingerprint", [id]) },
  { name: "brainOf", kind: "view", run: (p, id) => viewGas(p, "brainOf", [id]) },

  // Writes, including the two that touch the most storage.
  {
    name: "mintAgent",
    kind: "write",
    run: (p) =>
      writeGas(p, "mintAgent", [
        p.alice.account.address,
        "https://agents.example/gas.json",
        ZERO32,
        blank(),
        [shard("memory", "gas-probe")],
        SealPolicy.None,
        [],
      ]),
  },
  { name: "setApprovalForAll", kind: "write", run: (p) => writeGas(p, "setApprovalForAll", [p.bob.account.address, true], p.alice.account) },
  { name: "transferFrom", kind: "write", run: (p, id) => writeGas(p, "transferFrom", [p.alice.account.address, p.bob.account.address, id], p.alice.account) },
  { name: "setGuardian", kind: "write", run: (p, id) => writeGas(p, "setGuardian", [id, p.guardian.account.address], p.alice.account) },
  { name: "declareModel", kind: "write", run: (p, id) => writeGas(p, "declareModel", [id, model("m/1")], p.alice.account) },
  { name: "setStatus", kind: "write", run: (p, id) => writeGas(p, "setStatus", [id, AgentStatus.Active], p.alice.account) },
  { name: "updateBrain", kind: "write", run: (p, id) => writeGas(p, "updateBrain", [id, [shard("memory", "gas-probe-2")], 1n], p.alice.account) },
];

function blank() {
  return { weightsRoot: ZERO32, runtimeMeasurement: ZERO32, attestationKind: 0, modelId: "" };
}

/** One fresh chain per probe, so no probe pays another's cold-slot warming. */
async function measure(impl: "monolith" | "diamond", probe: Probe) {
  const p = await deployProtocol({ impl });
  const id = await mintAgent(p, p.alice.account.address, {
    uri: "https://agents.example/base.json",
    shards: [shard("memory", "base")],
  });
  return await probe.run(p, id);
}

describe("Gas — what the diamond costs", () => {
  it("stays within a bounded overhead of the monolith on every probed call", async () => {
    const rows: string[] = [];
    const breaches: string[] = [];
    let worstRel = 0;
    let worstRelName = "";

    for (const probe of PROBES) {
      const mono = await measure("monolith", probe);
      const dia = await measure("diamond", probe);
      const delta = dia - mono;
      const rel = Number(delta) / Number(mono);
      if (rel > worstRel) {
        worstRel = rel;
        worstRelName = probe.name;
      }

      rows.push(
        `  ${probe.name.padEnd(20)} ${String(mono).padStart(8)} ${String(dia).padStart(8)} ` +
          `${(delta >= 0n ? "+" : "") + String(delta)}`.padStart(9) +
          `  ${(rel * 100).toFixed(1).padStart(6)}%`
      );

      // A cheap view can legitimately be a large *fraction* more expensive while being a
      // trivial *amount* more expensive, so either bound passing is enough.
      if (rel > MAX_RELATIVE_OVERHEAD && delta > MAX_ABSOLUTE_OVERHEAD) {
        breaches.push(
          `${probe.name}: +${delta} gas (${(rel * 100).toFixed(1)}%), outside both the ` +
            `${MAX_RELATIVE_OVERHEAD * 100}% and ${MAX_ABSOLUTE_OVERHEAD}-gas bounds`
        );
      }
    }

    console.log(
      `\n  ${"call".padEnd(20)} ${"monolith".padStart(8)} ${"diamond".padStart(8)} ${"delta".padStart(9)}  ${"rel".padStart(7)}\n` +
        `  ${"-".repeat(56)}\n` +
        rows.join("\n") +
        `\n\n  worst relative overhead: ${worstRelName} at ${(worstRel * 100).toFixed(1)}%\n`
    );

    assert.deepEqual(breaches, [], `\n${breaches.join("\n")}`);
  });
});
