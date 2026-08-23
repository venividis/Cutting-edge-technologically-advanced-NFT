/**
 * Send an agent across chains, for real, over LayerZero V2.
 *
 *   source .scratch-env.sh
 *   ANIMA_KEY_DIR=... npx hardhat run scripts/testnet-omni.ts --network baseSepolia
 *
 * This is the layer the test suite could least be trusted on, because `MockLZEndpoint` is a
 * stand-in that answers however the tests need it to. Quoting the real endpoint already exposed
 * one gap the mock hid: it accepts empty executor options, and the deployed message library
 * rejects them. What it cannot expose is whether a DVN actually attests the packet and an
 * executor actually calls `lzReceive` on the far side. Only sending one finds that out.
 *
 * Base Sepolia (eid 40245) is home; OP Sepolia (eid 40232) holds the mirror.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, pad, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { lzReceiveOptions, ShardKind } from "../sdk/src/index.js";

const LZ_ENDPOINT = "0x6EDCE65403992e310A62460808c4b910D972f10f" as const;
const EID_HOME = 40245; // Base Sepolia
const EID_AWAY = 40232; // OP Sepolia
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const shard = (description: string, content: string, kind: number) => ({
  dataHash: keccak256(toHex(content)),
  keyCommitment: keccak256(toHex(`key:${content}`)),
  size: BigInt(content.length),
  kind,
  uri: `ipfs://anima/${description}`,
  description,
});

const explorer = { [EID_HOME]: "https://sepolia.basescan.org", [EID_AWAY]: "https://sepolia-optimism.etherscan.io" };

export async function main() {
  const path = "deployments/84532.json";
  const rec = JSON.parse(readFileSync(path, "utf8"));
  const save = () => writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
  rec.omni ??= {};

  const home = (await network.connect({ network: "baseSepolia" })) as any;
  const away = (await network.connect({ network: "opSepolia" })) as any;
  const [homePc, awayPc] = [await home.viem.getPublicClient(), await away.viem.getPublicClient()];
  const [homeWallet] = await home.viem.getWalletClients();
  const [awayWallet] = await away.viem.getWalletClients();
  const owner = getAddress(homeWallet.account.address);

  const homeBal = await homePc.getBalance({ address: owner });
  const awayBal = await awayPc.getBalance({ address: owner });
  console.log(`\ndeployer ${owner}`);
  console.log(`  Base Sepolia  ${Number(homeBal) / 1e18} ETH`);
  console.log(`  OP Sepolia    ${Number(awayBal) / 1e18} ETH`);
  if (awayBal < 10n ** 15n) {
    throw new Error(
      `the deployer has ${Number(awayBal) / 1e18} ETH on OP Sepolia. The mirror has to be deployed ` +
        `there, which needs gas on that chain — Base Sepolia ETH cannot pay for it. Send ~0.01 ` +
        `OP Sepolia ETH to ${owner} and re-run; everything already deployed is reused.`
    );
  }

  let step = 0;
  const tx = async (side: "home" | "away", label: string, run: () => Promise<Hex>) => {
    const pc = side === "home" ? homePc : awayPc;
    const base = side === "home" ? explorer[EID_HOME] : explorer[EID_AWAY];
    const hash = await run();
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60; i++) {
      if ((await pc.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`${String(++step).padStart(2)}. [${side}] ${label.padEnd(42)} ${base}/tx/${hash}`);
    return receipt;
  };

  /* ─── 1. the two ends ──────────────────────────────────────────────────────────────── */

  if (!rec.omni.home) {
    const c = await home.viem.deployContract("OmniAgentHome", [rec.contracts.anima, LZ_ENDPOINT, owner, owner]);
    rec.omni.home = getAddress(c.address);
    save();
    console.log(`    OmniAgentHome   (Base) ${rec.omni.home}`);
  }
  if (!rec.omni.mirror) {
    const c = await away.viem.deployContract("OmniAgentMirror", [
      "ANIMA Mirror", "mANIMA", LZ_ENDPOINT, owner, owner,
    ]);
    rec.omni.mirror = getAddress(c.address);
    save();
    console.log(`    OmniAgentMirror (OP)   ${rec.omni.mirror}`);
  }

  const homeOApp = await home.viem.getContractAt("OmniAgentHome", rec.omni.home);
  const mirror = await away.viem.getContractAt("OmniAgentMirror", rec.omni.mirror);
  const anima = await home.viem.getContractAt("AnimaAgent", rec.contracts.anima);

  if (!rec.omni.peered) {
    await tx("home", "trust the mirror as peer on eid 40232", () =>
      homeOApp.write.setPeer([EID_AWAY, pad(rec.omni.mirror)])
    );
    await tx("away", "trust home as peer on eid 40245", () =>
      mirror.write.setPeer([EID_HOME, pad(rec.omni.home)])
    );
    rec.omni.peered = true;
    save();
  }

  /* ─── 2. an agent to send ──────────────────────────────────────────────────────────── */

  const brain = [
    shard("weights", "lora-nomad-v1", ShardKind.Weights),
    shard("memory", "has never left home", ShardKind.Memory),
  ];
  const mint = await tx("home", "mint Nomad", () =>
    anima.write.mintAgent([
      owner, "https://nomad.example/card.json", keccak256(toHex("nomad-manifest-v1")),
      { weightsRoot: keccak256(toHex("lora-nomad-v1")), runtimeMeasurement: ZERO32, attestationKind: 1,
        modelId: "anthropic/claude-opus-5" },
      brain, 1, [],
    ])
  );
  const { parseEventLogs } = await import("viem");
  const minted: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: mint.logs })
    .find((l: any) => l.args.from === zeroAddress);
  const agentId: bigint = minted.args.tokenId;
  console.log(`    → agent #${agentId}`);

  const departure = {
    brainRoot: await anima.read.brainRoot([agentId]),
    brainEpoch: await anima.read.brainEpoch([agentId]),
    manifestHash: (await anima.read.manifestOf([agentId]))[1],
  };

  /* ─── 3. quote, then send ──────────────────────────────────────────────────────────── */

  const options = lzReceiveOptions(400_000n);
  const fee: any = await homeOApp.read.quoteSend([EID_AWAY, pad(owner), agentId, options]);
  console.log(`    → quoted ${Number(fee.nativeFee) / 1e18} ETH to carry it across`);

  await tx("home", "approve the bridge to escrow it", () => anima.write.approve([rec.omni.home, agentId]));
  const sent = await tx("home", "SEND the agent to OP Sepolia", () =>
    homeOApp.write.send([EID_AWAY, pad(owner), agentId, options, fee, owner, false], { value: fee.nativeFee })
  );
  const guid = parseEventLogs({ abi: homeOApp.abi, logs: sent.logs })
    .map((l: any) => l.args?.guid).find(Boolean);
  console.log(`    → escrowed at home; owner is now ${await anima.read.ownerOf([agentId])}`);
  console.log(`    → LayerZero guid ${guid ?? "(not in logs)"}`);
  console.log(`    → track: https://testnet.layerzeroscan.com/tx/${sent.transactionHash}`);

  /* ─── 4. wait for a DVN to attest and an executor to deliver ───────────────────────── */

  console.log(`\n    waiting for delivery on OP Sepolia (a real DVN has to attest this)...`);
  let arrived = false;
  for (let i = 0; i < 60; i++) {
    try {
      const holder = await mirror.read.ownerOf([agentId]);
      if (holder && holder !== zeroAddress) { arrived = true; break; }
    } catch { /* not minted yet */ }
    await new Promise((r) => setTimeout(r, 10_000));
    if (i % 6 === 5) console.log(`    ...${(i + 1) * 10}s`);
  }
  if (!arrived) {
    throw new Error(
      `no delivery after 10 minutes. The send succeeded and is on chain — check ` +
        `https://testnet.layerzeroscan.com/tx/${sent.transactionHash} for whether the packet was ` +
        `attested and executed. Re-running reuses everything.`
    );
  }

  /* ─── 5. is the replica what left? ─────────────────────────────────────────────────── */

  const replica: any = await mirror.read.replicaOf([agentId]);
  console.log(`
─── it arrived ───────────────────────────────────────────────────────
  mirror owner    ${await mirror.read.ownerOf([agentId])}
  isReplica()     ${await mirror.read.isReplica()}   (it says so about itself)
  brainRoot       ${replica.brainRoot}
                  ${replica.brainRoot === departure.brainRoot ? "matches what left home" : "!! DIVERGED !!"}
  brainEpoch      ${replica.brainEpoch}  (home: ${departure.brainEpoch})
  manifestHash    ${replica.manifestHash === departure.manifestHash ? "matches what left home" : "!! DIVERGED !!"}
  home custody    ${await anima.read.ownerOf([agentId])} (the bridge, holding it in escrow)
──────────────────────────────────────────────────────────────────────`);

  /* ─── 6. and back again ────────────────────────────────────────────────────────────── */

  const backFee: any = await mirror.read.quoteSend([EID_HOME, pad(owner), agentId, options]);
  await tx("away", "SEND it home again", () =>
    mirror.write.send([EID_HOME, pad(owner), agentId, options, backFee, owner], { value: backFee.nativeFee })
  );

  console.log(`\n    waiting for the return leg on Base Sepolia...`);
  for (let i = 0; i < 60; i++) {
    if (getAddress(await anima.read.ownerOf([agentId])) === owner) {
      console.log(`\n  home again: agent #${agentId} is owned by ${owner}`);
      console.log(`  brain intact: epoch ${await anima.read.brainEpoch([agentId])}, root ${await anima.read.brainRoot([agentId])}`);
      rec.omni.roundTripped = true;
      save();
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
    if (i % 6 === 5) console.log(`    ...${(i + 1) * 10}s`);
  }
  console.log("  outbound leg confirmed; return leg still in flight. Re-run to re-check.");
}

await main();
