/**
 * Exercise the modules the first live run never touched.
 *
 *   source .scratch-env.sh
 *   ANIMA_KEY_DIR=... npx hardhat run scripts/testnet-modules.ts --network baseSepolia
 *
 * Three of ANIMA's registries were deployed to Base Sepolia and then never called: the handle
 * registry, the ERC-7432 role registry, and the per-call inference meter. A deployed contract
 * that nobody has transacted with is a contract nobody has checked, so this drives all three with
 * real transactions — real EIP-712 signatures, real money, real locks.
 *
 * Deliberately not covered here: the launchpad, swap router and derivatives desk. Each needs a
 * venue — a liquidity deployer, a DEX, a perpetuals adapter — and on a testnet those are mocks
 * whichever chain they sit on, so running them here would prove less than it appears to.
 */
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import {
  createWalletClient, http, keccak256, toHex, getAddress, parseEventLogs, zeroAddress,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { handleKey } from "../sdk/src/index.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const aUSD = (n: number) => BigInt(n) * 1_000_000n;
const HOUR = 3600n;
const DAY = 86_400n;

const shard = (d: string, c: string, kind: number) => ({
  dataHash: keccak256(toHex(c)), keyCommitment: keccak256(toHex(`key:${c}`)),
  size: BigInt(c.length), kind, uri: `ipfs://anima/${d}`, description: d,
});

const receipts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    requestHash: keccak256(toHex(`req-${i}`)),
    responseHash: keccak256(toHex(`res-${i}`)),
    modelHash: keccak256(toHex("claude-opus-5")),
    units: BigInt(1000 + i),
    attestationKind: 2,
    attestation: keccak256(toHex(`quote-${i}`)),
  }));

export async function main() {
  const rec = JSON.parse(readFileSync("deployments/84532.json", "utf8"));
  const c = rec.contracts;
  const keyDir = process.env.ANIMA_KEY_DIR;
  if (!keyDir) throw new Error("ANIMA_KEY_DIR must point at the directory holding the cast keys");

  const { viem } = (await network.connect({ network: "baseSepolia" })) as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = getAddress(wallet.account.address);
  const chainId = await publicClient.getChainId();

  const clientWallet = createWalletClient({
    account: privateKeyToAccount(readFileSync(`${keyDir}/${rec.cast.client.keyFile}`, "utf8").trim() as Hex),
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org"),
  });

  let step = 0;
  const tx = async (label: string, run: () => Promise<Hex>) => {
    const hash = await run();
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60; i++) {
      if ((await publicClient.getBlockNumber({ cacheTime: 0 })) >= r.blockNumber) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    console.log(`${String(++step).padStart(2)}. ${label.padEnd(48)} https://sepolia.basescan.org/tx/${hash}`);
    return r;
  };
  const at = async (n: string, a: Address, w?: any) =>
    await viem.getContractAt(n, a, w ? { client: { wallet: w } } : undefined);

  const anima = await at("AnimaAgent", c.anima);
  const usdc = await at("MockERC20", c.usdc);
  const handles = await at("AgentHandles", c.handles);
  const roles = await at("AnimaRoles", c.roles);
  const meter = await at("InferenceMeter", c.meter);

  const mintOne = async (name: string, memory: string) => {
    const r = await tx(`mint ${name}`, () =>
      anima.write.mintAgent([
        owner, `https://${name.toLowerCase()}.example/card.json`, keccak256(toHex(`${name}-manifest`)),
        { weightsRoot: keccak256(toHex(`lora-${name}`)), runtimeMeasurement: ZERO32, attestationKind: 1,
          modelId: "anthropic/claude-opus-5" },
        [shard("memory", memory, 1)], 1, [],
      ])
    );
    const log: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: r.logs })
      .find((l: any) => l.args.from === zeroAddress);
    return log.args.tokenId as bigint;
  };

  console.log(`\nowner ${owner}\n`);
  const atlas = await mintOne("Sable", "handles + roles + metering");
  const rival = await mintOne("Rival", "wants the same inbox");
  console.log(`    → agents #${atlas} and #${rival}\n`);

  /* ─── AgentHandles: one inbox, one agent ───────────────────────────────────────────── */
  console.log("── AgentHandles ──");

  await tx("register an Email verifier", () => handles.write.setVerifier([0, owner, true]));
  const inbox = "sable.agent" + "@" + "anima-demo.example";
  const expires = BigInt((await publicClient.getBlock()).timestamp) + 30n * DAY;
  await tx(`attest ${inbox}`, () =>
    handles.write.attest([atlas, 0, inbox, expires, "https://anima-demo.example/proof/1", keccak256(toHex("dkim-proof"))])
  );
  console.log(`    → handleKey (SDK)  ${handleKey("email", inbox)}`);
  console.log(`    → isFresh(#${atlas}, 0) = ${await handles.read.isFresh([atlas, 0n])}`);

  // The guarantee that makes a handle worth anything: nobody else can claim it.
  let taken = "unexpectedly succeeded";
  try {
    await handles.write.attest([rival, 0, inbox, expires, "https://evil.example/proof", ZERO32]);
  } catch (e) {
    taken = String((e as Error).message).includes("HandleTaken") ? "refused (HandleTaken)" : "refused";
  }
  console.log(`    → agent #${rival} tries to claim the same inbox: ${taken}\n`);

  /* ─── AnimaRoles: four roles at once, ERC-7432 ─────────────────────────────────────── */
  console.log("── AnimaRoles (ERC-7432) ──");

  const now = BigInt((await publicClient.getBlock()).timestamp);
  const grants = [
    ["OPERATOR", await roles.read.OPERATOR(), rec.cast.client.address, now + 30n * DAY],
    ["PAYER", await roles.read.PAYER(), rec.cast.buyer.address, now + 7n * DAY],
    ["AUDITOR", await roles.read.AUDITOR(), rec.cast.validator.address, now + 90n * DAY],
  ] as const;

  for (const [name, roleId, to, until] of grants) {
    await tx(`grant ${name} to ${(to as string).slice(0, 10)}…`, () =>
      roles.write.grantRole([{
        roleId, tokenAddress: c.anima, tokenId: atlas, recipient: to,
        expirationDate: until, revocable: true, data: "0x",
      }])
    );
  }
  console.log(`    → three roles live at once — ERC-4907 has one 'user' slot and cannot express this`);
  console.log(`    → agent locked while a role is live: ${await anima.read.locked([atlas])}`);

  await tx("revoke OPERATOR", () => roles.write.revokeRole([c.anima, atlas, grants[0][1]]));
  await tx("revoke PAYER", () => roles.write.revokeRole([c.anima, atlas, grants[1][1]]));
  await tx("revoke AUDITOR", () => roles.write.revokeRole([c.anima, atlas, grants[2][1]]));

  // Revocation deliberately does NOT unlock. The registry locks once, on the first grant, and
  // releases only when someone asks — permissionless, and refused while an irrevocable role is
  // still outstanding. Separating the two means a grantee cannot strand the token, and an owner
  // cannot yank it back mid-grant by revoking in the same breath.
  console.log(`    → after revoking all three, still locked: ${await anima.read.locked([atlas])} (by design)`);
  console.log(`    → nothing irrevocable outstanding: lockedUntil = ${await roles.read.lockedUntil([atlas])}`);
  await tx("release the token (permissionless)", () => roles.write.unlockToken([c.anima, atlas]));
  console.log(`    → locked now: ${await anima.read.locked([atlas])}\n`);

  /* ─── InferenceMeter: pay per call, settle with a signed voucher ───────────────────── */
  console.log("── InferenceMeter ──");

  await tx("deploy the agent's wallet", () => anima.write.deployAccount([atlas]));
  const account = await anima.read.accountOf([atlas]);

  const usdcAsClient = await at("MockERC20", c.usdc, clientWallet);
  const meterAsClient = await at("InferenceMeter", c.meter, clientWallet);
  await tx("client approves the meter", () => usdcAsClient.write.approve([c.meter, aUSD(1000)]));
  const opened = await tx("client opens a 1,000 aUSD channel", () =>
    meterAsClient.write.openChannel([atlas, c.usdc, aUSD(1000)])
  );
  const chLog: any = parseEventLogs({ abi: meter.abi, logs: opened.logs })
    .find((l: any) => l.args?.channelId !== undefined);
  const channelId: bigint = chLog.args.channelId;
  console.log(`    → channel #${channelId}`);

  /** The payer signs a running total off-chain; the agent redeems the latest one it holds. */
  const voucher = async (cumulative: bigint, batch: ReturnType<typeof receipts>) => {
    const workRoot = await meter.read.workRootOf([batch]);
    const deadline = BigInt((await publicClient.getBlock()).timestamp) + HOUR;
    const signature = await clientWallet.signTypedData({
      domain: { name: "AnimaInferenceMeter", version: "1", chainId, verifyingContract: c.meter as Address },
      types: { Voucher: [
        { name: "channelId", type: "uint256" }, { name: "cumulativeAmount", type: "uint256" },
        { name: "workRoot", type: "bytes32" }, { name: "deadline", type: "uint256" },
      ] },
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount: cumulative, workRoot, deadline },
    });
    return { signature, deadline, workRoot };
  };

  const before = await usdc.read.balanceOf([account]);
  const batch1 = receipts(3);
  const v1 = await voucher(aUSD(120), batch1);
  await tx("agent settles 120 aUSD of served calls", () =>
    meter.write.settle([channelId, aUSD(120), v1.deadline, v1.signature, batch1])
  );

  const batch2 = receipts(5);
  const v2 = await voucher(aUSD(300), batch2);
  await tx("…and again, at a new running total of 300", () =>
    meter.write.settle([channelId, aUSD(300), v2.deadline, v2.signature, batch2])
  );
  console.log(`    → the agent's own wallet took ${(await usdc.read.balanceOf([account]) - before) / 1_000_000n} aUSD`);

  // Vouchers are cumulative, so an old one is worth nothing once a newer one is redeemed.
  let replay = "unexpectedly succeeded";
  try {
    await meter.write.settle([channelId, aUSD(120), v1.deadline, v1.signature, batch1]);
  } catch {
    replay = "refused";
  }
  console.log(`    → replaying the earlier voucher: ${replay}`);

  console.log(`\n${step} transactions. agent #${atlas}: https://sepolia.basescan.org/token/${c.anima}?a=${atlas}`);
}

await main();
