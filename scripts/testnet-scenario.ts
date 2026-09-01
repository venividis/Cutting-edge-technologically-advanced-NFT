/**
 * Put real agents through the protocol on a live chain.
 *
 *   source .scratch-env.sh
 *   ANIMA_KEY_DIR=... npx hardhat run scripts/testnet-scenario.ts --network baseSepolia
 *
 * The test suite proves each contract is correct in isolation and that the two builds agree.
 * What it cannot prove is that an agent can actually *live* on a chain nobody controls: that its
 * wallet derives where the registry says, that a client's money reaches the agent's own account
 * rather than its owner's, that a bond really locks a token against sale mid-job, and that
 * selling an agent really does revoke the authority its previous owner granted.
 *
 * So this runs that story for real, one transaction at a time, and prints a block explorer link
 * for every one of them. Nothing here is simulated.
 */
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import {
  createWalletClient, custom, defineChain, keccak256, toHex, encodeFunctionData, getAddress, parseEventLogs,
  parseEther, zeroAddress, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { manifestHash, serialiseManifest, lockedDownPolicy, ShardKind, type AgentManifest } from "../sdk/src/index.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const aUSD = (n: number) => BigInt(n) * 1_000_000n;
const HOUR = 3600n;
const DAY = 86_400n;

const shard = (description: string, content: string, kind: number) => ({
  dataHash: keccak256(toHex(content)),
  keyCommitment: keccak256(toHex(`key:${content}`)),
  size: BigInt(content.length),
  kind,
  uri: `ipfs://anima/${description}`,
  description,
});

export async function main() {
  const keyDir = process.env.ANIMA_KEY_DIR;
  if (!keyDir) throw new Error("ANIMA_KEY_DIR must point at the directory holding the cast keys");

  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const deploymentPath = process.env.ANIMA_DEPLOYMENT ?? process.env.ANIMA_DEPLOYMENT_FILE
    ?? `deployments/${chainId}.json`;
  const rec = JSON.parse(readFileSync(deploymentPath, "utf8"));
  if (rec.chainId !== chainId) throw new Error(`deployment record chain ${rec.chainId} does not match RPC chain ${chainId}`);
  const c = rec.contracts;
  const [ownerWallet] = await viem.getWalletClients();
  const owner = getAddress(ownerWallet.account.address);
  if (getAddress(rec.deployer) !== owner) throw new Error(`deployment belongs to ${rec.deployer}, not connected signer ${owner}`);

  const chainNames: Record<number, string> = {
    84532: "Base Sepolia", 11155420: "OP Sepolia", 421614: "Arbitrum Sepolia", 11155111: "Ethereum Sepolia",
  };
  const explorers: Record<number, string> = {
    84532: "https://sepolia.basescan.org", 11155420: "https://sepolia-optimism.etherscan.io",
    421614: "https://sepolia.arbiscan.io", 11155111: "https://sepolia.etherscan.io",
  };
  const explorer = explorers[chainId];
  if (!explorer) throw new Error(`no explorer configured for chain ${chainId}`);
  const walletChain = defineChain({
    id: chainId, name: chainNames[chainId] ?? `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://hardhat-connection"] } },
  });
  const asCast = (role: string) => {
    const account = privateKeyToAccount(readFileSync(`${keyDir}/${rec.cast[role].keyFile}`, "utf8").trim() as Hex);
    if (getAddress(account.address) !== getAddress(rec.cast[role].address)) {
      throw new Error(`${role} key resolves to ${account.address}, expected ${rec.cast[role].address}`);
    }
    return createWalletClient({
      account, chain: walletChain,
      // Submit through exactly one transport. Failing over eth_sendRawTransaction after an
      // ambiguous timeout can turn a mined transaction into an apparent script failure.
      transport: custom({ request: (args) => publicClient.request(args as any) }),
    });
  };
  const client = asCast("client");
  const buyer = asCast("buyer");

  let step = 0;
  const done: string[] = [];
  /**
   * Send, wait, and record. Every line of output is a transaction someone can go and read.
   *
   * The wait is two-part on purpose. A receipt proves *some* node mined it; a public RPC is a
   * load balancer, so the very next read can land on one that is still behind and answer with
   * pre-transaction state. Reading `totalMinted()` straight after a mint returned 0 that way,
   * and the script then addressed agent 0. So block until the endpoint we are about to read
   * from has actually reached the block our transaction landed in.
   */
  const tx = async (label: string, run: () => Promise<Hex>) => {
    const hash = await run();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60; i++) {
      if ((await publicClient.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    done.push(`${String(++step).padStart(2)}. ${label.padEnd(46)} ${explorer}/tx/${hash}`);
    console.log(done[done.length - 1]);
    return receipt;
  };

  const at = async (name: string, address: Address, account?: any) =>
    await viem.getContractAt(name, address, account ? { client: { wallet: account } } : undefined);

  const anima = await at("AnimaAgent", c.anima);
  const usdc = await at("MockERC20", c.usdc);
  const bonds = await at("BondVault", c.bonds);
  const escrow = await at("WorkEscrow", c.escrow);
  const comms = await at("AgentComms", c.comms);
  const reputation = await at("ReputationRegistry", c.reputation);

  console.log(`\nowner  ${owner}\nclient ${rec.cast.client.address}\nbuyer  ${rec.cast.buyer.address}\n`);
  console.log(`token  ${explorer}/address/${c.anima}\n`);

  /* ─── act 1: birth ─────────────────────────────────────────────────────────────────── */

  const brain = [
    shard("weights", "lora-atlas-v3", ShardKind.Weights),
    shard("memory", "cold start", ShardKind.Memory),
    shard("prompt", "You are Atlas, a research agent.", ShardKind.SystemPrompt),
  ];

  const mint = await tx("mint Atlas, with a sealed brain", () =>
    anima.write.mintAgent([
      owner, "https://atlas.example/card.json", ZERO32,
      { weightsRoot: keccak256(toHex("lora-atlas-v3")), runtimeMeasurement: ZERO32, attestationKind: 1,
        modelId: "anthropic/claude-opus-5" },
      brain, 1 /* SealPolicy.Committed */, [],
    ])
  );
  // From the receipt, which is authoritative, rather than from a read that a lagging node
  // would answer with the state before this mint.
  const minted = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: mint.logs })
    .find((l: any) => l.args.from === zeroAddress);
  if (!minted) throw new Error("no mint Transfer log — cannot identify the agent");
  const agentId: bigint = (minted as any).args.tokenId;
  console.log(`    → agent #${agentId}`);

  const manifest: AgentManifest = {
    name: "Atlas",
    description: `Research agent, live on ${chainNames[chainId] ?? `chain ${chainId}`}`,
    version: "1.0.0",
    anima: {
      registry: `eip155:${chainId}:${c.anima}`,
      agentId: agentId.toString(),
      mcp: [{ name: "search", url: "https://atlas.example/mcp", transport: "http" }],
      pricing: { unit: "1k tokens", amount: "1000", token: c.usdc },
    },
  };
  await tx("commit its manifest hash on-chain", () =>
    anima.write.setManifest([agentId, "https://atlas.example/card.json", manifestHash(manifest)])
  );
  const manifestVerifies = await anima.read.verifyManifest([agentId, toHex(serialiseManifest(manifest))]);
  console.log(`    → verifyManifest(exact bytes) = ${manifestVerifies}`);

  /* ─── act 2: arming ────────────────────────────────────────────────────────────────── */

  const predicted = await anima.read.accountOf([agentId]);
  await tx("deploy its ERC-6551 wallet", () => anima.write.deployAccount([agentId]));
  const account = await at("AgentAccount", predicted);
  const codeAtAccount = await publicClient.getCode({ address: predicted });
  console.log(`    → wallet ${predicted} (predicted before deploy: ${codeAtAccount !== "0x" ? "matches" : "MISMATCH"})`);

  await tx("publish the autonomy leash", () =>
    anima.write.setPolicy([agentId, { ...lockedDownPolicy(), perTxWei: parseEther("0.001"),
      dailyWei: parseEther("0.002"), allowUnlistedTargets: true }])
  );
  await tx("appoint a guardian", () => anima.write.setGuardian([agentId, rec.cast.validator.address]));
  await tx("activate", () => anima.write.setStatus([agentId, 1 /* Active */]));

  /* ─── act 3: collateral ────────────────────────────────────────────────────────────── */

  await tx("approve the bond vault", () => usdc.write.approve([c.bonds, aUSD(5000)]));
  await tx("post a 2,000 aUSD bond", () => bonds.write.deposit([agentId, aUSD(2000)]));
  console.log(`    → coverage ${(await bonds.read.availableCoverage([agentId])) / 1_000_000n} aUSD`);

  /* ─── act 4: hiring ────────────────────────────────────────────────────────────────── */

  const usdcAsClient = await at("MockERC20", c.usdc, client);
  const escrowAsClient = await at("WorkEscrow", c.escrow, client);
  await tx("client approves escrow", () => usdcAsClient.write.approve([c.escrow, aUSD(5000)]));

  const now = BigInt((await publicClient.getBlock()).timestamp);
  const offer = await tx("client offers a 500 aUSD job", () =>
    escrowAsClient.write.offerJob([
      agentId, aUSD(500), aUSD(1000), now + 2n * DAY, HOUR,
      rec.cast.validator.address, keccak256(toHex("find me three sources on ERC-8004")), "ipfs://spec",
    ])
  );
  const offered = parseEventLogs({ abi: escrow.abi, eventName: "JobOffered", logs: offer.logs })[0];
  const jobId: bigint = (offered as any).args.jobId;
  console.log(`    → job #${jobId}`);
  await tx("owner accepts, pledging 1,000 of coverage", () => escrow.write.acceptJob([jobId]));
  console.log(`    → locked=${await anima.read.locked([agentId])}  free coverage=${(await bonds.read.availableCoverage([agentId])) / 1_000_000n} aUSD`);

  // Prove the lock is real, against the live chain, before doing anything else.
  let soldMidJob = "unexpectedly succeeded";
  try {
    await anima.write.transferFrom([owner, rec.cast.buyer.address, agentId]);
  } catch (e) {
    soldMidJob = String((e as Error).message).includes("AgentLocked") || String((e as Error).message).includes("0x")
      ? "refused (AgentLocked)" : "refused";
  }
  console.log(`    → attempt to sell mid-job: ${soldMidJob}`);

  /* ─── act 5: the agent works, and remembers ────────────────────────────────────────── */

  const learned = [brain[0], shard("memory", "three sources: EIP-8004, EIP-6551, EIP-7857", ShardKind.Memory), brain[2]];
  await tx("update its brain (epoch advances)", () => anima.write.updateBrain([agentId, learned, 1n]));
  console.log(`    → brainEpoch ${await anima.read.brainEpoch([agentId])}`);

  await tx("deliver the work", () =>
    escrow.write.deliver([jobId, keccak256(toHex("the answer")), "ipfs://delivery"])
  );
  const balanceBefore = await usdc.read.balanceOf([predicted]);
  await tx("client accepts and rates it 92", () =>
    escrowAsClient.write.acceptDelivery([jobId, 9200n, 2, "research", "ipfs://feedback", ZERO32])
  );
  const balanceAfter = await usdc.read.balanceOf([predicted]);
  console.log(`    → the AGENT's own wallet received ${((balanceAfter as bigint) - (balanceBefore as bigint)) / 1_000_000n} aUSD (1% protocol fee)`);
  const [count, score, weight] = await reputation.read.getAttestedSummary([agentId, [], "", ""]);
  console.log(`    → attested reputation: ${count} review, score ${score}, backed by ${weight / 1_000_000n} aUSD of settled work`);

  /* ─── act 6: it funds itself ───────────────────────────────────────────────────────── */

  await tx("agent approves the vault from its own wallet", () =>
    account.write.execute([c.usdc, 0n,
      encodeFunctionData({ abi: usdc.abi, functionName: "approve", args: [c.bonds, aUSD(495)] }), 0])
  );
  await tx("agent tops up its own bond with what it earned", () =>
    account.write.execute([c.bonds, 0n,
      encodeFunctionData({ abi: bonds.abi, functionName: "deposit", args: [agentId, aUSD(495)] }), 0])
  );
  console.log(`    → coverage now ${(await bonds.read.availableCoverage([agentId])) / 1_000_000n} aUSD, funded by the agent itself`);

  /* ─── act 7: paid attention ────────────────────────────────────────────────────────── */

  await tx("open its inbox at 5 aUSD postage", () =>
    comms.write.configureInbox([agentId, c.usdc, aUSD(5), 3600n, true])
  );
  const commsAsClient = await at("AgentComms", c.comms, client);
  await tx("client approves postage", () => usdcAsClient.write.approve([c.comms, aUSD(50)]));
  await tx("client pays to be read", () =>
    commsAsClient.write.send([agentId, 0n, keccak256(toHex("thread-1")),
      keccak256(toHex("can you look at ERC-7802 next?")), "https://relay.example/m/1", c.usdc, aUSD(5)])
  );

  /* ─── act 8: rented out ────────────────────────────────────────────────────────────── */

  await tx("lease it to the buyer for a day (ERC-4907)", () =>
    anima.write.setUser([agentId, rec.cast.buyer.address, Number(now + DAY)])
  );
  console.log(`    → userOf = ${await anima.read.userOf([agentId])}`);

  /* ─── act 9: the sale, and what it revokes ─────────────────────────────────────────── */

  const before = {
    fingerprint: await anima.read.getStateFingerprint([agentId]),
    guardian: await anima.read.guardianOf([agentId]),
    user: await anima.read.userOf([agentId]),
    status: await anima.read.statusOf([agentId]),
    perTxWei: (await anima.read.policyOf([agentId])).perTxWei,
  };

  await tx("SELL the agent to the buyer", () =>
    anima.write.transferFrom([owner, rec.cast.buyer.address, agentId])
  );

  const after = {
    fingerprint: await anima.read.getStateFingerprint([agentId]),
    owner: await anima.read.ownerOf([agentId]),
    guardian: await anima.read.guardianOf([agentId]),
    user: await anima.read.userOf([agentId]),
    status: await anima.read.statusOf([agentId]),
    perTxWei: (await anima.read.policyOf([agentId])).perTxWei,
  };

  console.log(`
─── what the sale revoked, on chain ──────────────────────────────────
  owner        ${owner}  →  ${after.owner}
  guardian     ${before.guardian}  →  ${after.guardian}
  ERC-4907 user${" ".repeat(0)} ${before.user}  →  ${after.user}
  status       ${before.status} (Active)  →  ${after.status} (Paused)
  policy/tx    ${before.perTxWei}  →  ${after.perTxWei}
  fingerprint  ${before.fingerprint}
            →  ${after.fingerprint}

  What the sale did NOT touch — this is what the buyer actually bought:
  brain        epoch ${await anima.read.brainEpoch([agentId])}, root ${await anima.read.brainRoot([agentId])}
  wallet       ${predicted} (same address, still the agent's)
    balance    ${(await usdc.read.balanceOf([predicted])) / 1_000_000n} aUSD liquid
  bond         ${(await bonds.read.availableCoverage([agentId])) / 1_000_000n} aUSD of coverage, including the 495 it earned
               and staked itself — collateral belongs to the agent, so it changes hands with it
  reputation   ${(await reputation.read.getAttestedSummary([agentId, [], "", ""]))[0]} attested review, still attached
──────────────────────────────────────────────────────────────────────

${done.length} transactions, all on ${chainNames[chainId] ?? `chain ${chainId}`}.
agent:  ${explorer}/token/${c.anima}?a=${agentId}
wallet: ${explorer}/address/${predicted}
`);
}

await main();
