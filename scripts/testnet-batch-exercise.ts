/**
 * Exercise the ten agents created by testnet-batch-mint.ts on Ethereum Sepolia.
 *
 * This is deliberately a stateful integration run, not a replacement for the exhaustive
 * Hardhat suite. Each agent is assigned a different lifecycle concern and the final reads
 * verify the important cross-function invariants (especially transfer-time revocation).
 * Progress and transaction hashes are checkpointed in the deployment record.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import {
  createWalletClient, defineChain, getAddress, http, keccak256, parseEther, toHex,
  zeroAddress, type Address, type Hex,
} from "viem";
import { generatePrivateKey, nonceManager, privateKeyToAccount } from "viem/accounts";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const shard = (agentId: bigint, revision: number) => ({
  dataHash: keccak256(toHex(`batch-${agentId}-brain-${revision}`)),
  keyCommitment: keccak256(toHex(`batch-${agentId}-key-${revision}`)),
  size: 32n,
  kind: 1,
  uri: `ipfs://anima/testnet-batch/${agentId}/brain-${revision}`,
  description: `integration revision ${revision}`,
});

async function main() {
  const path = process.env.ANIMA_DEPLOYMENT ?? "deployments/11155111.json";
  const record = JSON.parse(readFileSync(path, "utf8"));
  const ids = (record.batchMint?.tokenIds ?? []).map(BigInt);
  if (ids.length !== 10) throw new Error(`expected exactly ten batch agents, found ${ids.length}`);

  const { viem } = await network.connect({ network: "sepolia" }) as any;
  const publicClient = await viem.getPublicClient();
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const ownerAccount = privateKeyToAccount(
    (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
    { nonceManager },
  );
  const owner = getAddress(ownerAccount.address);
  if (getAddress(record.batchMint.recipient) !== owner) throw new Error("batch owner does not match signer");

  const actorKeyPath = process.env.ANIMA_EXERCISE_ACTOR_KEY ?? "/tmp/anima-batch-exercise-actor.key";
  const actorKey = existsSync(actorKeyPath)
    ? readFileSync(actorKeyPath, "utf8").trim() as Hex
    : generatePrivateKey();
  if (!existsSync(actorKeyPath)) writeFileSync(actorKeyPath, `${actorKey}\n`, { mode: 0o600 });
  const actor = privateKeyToAccount(actorKey, { nonceManager });
  const chain = defineChain({
    id: 11155111, name: "Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const transport = http(RPC, { retryCount: 8, retryDelay: 1_000 });
  const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport });
  const actorWallet = createWalletClient({ account: actor, chain, transport });
  const anima = await viem.getContractAt("AnimaAgent", record.contracts.anima, { client: { wallet: ownerWallet } });
  const animaAsActor = await viem.getContractAt("AnimaAgent", record.contracts.anima, { client: { wallet: actorWallet } });

  const evidence: Array<{ label: string; hash: Hex; block: string }> = record.batchExercise?.evidence ?? [];
  const tx = async (label: string, run: () => Promise<Hex>) => {
    if (evidence.some((item) => item.label === label)) {
      console.log(`--. ${label.padEnd(42)} already checkpointed`);
      return;
    }
    const hash = await run();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    evidence.push({ label, hash, block: receipt.blockNumber.toString() });
    record.batchExercise = { chainId: 11155111, actor: actor.address, evidence, completed: false };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${String(evidence.length).padStart(2)}. ${label.padEnd(42)} https://sepolia.etherscan.io/tx/${hash}`);
    return receipt;
  };

  const has = (label: string) => evidence.some((item) => item.label === label);
  for (const id of ids) {
    const temporarilyWithActor =
      (id === ids[3] && has("actor transfers agent 17") && !has("actor returns agent 17")) ||
      (id === ids[4] && has("safe-transfer agent 18") && !has("safe-return agent 18 with data")) ||
      (id === ids[9] && has("transfer agent 23"));
    const expected = temporarilyWithActor ? actor.address : owner;
    if (getAddress(await anima.read.ownerOf([id])) !== getAddress(expected)) {
      throw new Error(`agent #${id} has an unexpected owner`);
    }
  }

  // #14: metadata, model declaration, manifest commitment, and brain revision. The batch was
  // minted at SealPolicy.None, already the weakest policy, so a downgrade is inapplicable.
  await tx("set agent 14 URI", () => anima.write.setAgentURI([ids[0], "ipfs://anima/exercise/14.json"]));
  await tx("set agent 14 metadata", () => anima.write.setMetadata([ids[0], "exercise", toHex("metadata-ok")]));
  await tx("declare agent 14 model", () => anima.write.declareModel([ids[0], {
    weightsRoot: keccak256(toHex("batch-model-v2")), runtimeMeasurement: ZERO32,
    attestationKind: 1, modelId: "testnet/batch-model-v2",
  }]));
  await tx("commit agent 14 manifest", () => anima.write.setManifest([
    ids[0], "ipfs://anima/exercise/14-v2.json", keccak256(toHex("batch-14-manifest-v2")),
  ]));
  await tx("update agent 14 brain", async () =>
    anima.write.updateBrain([ids[0], [shard(ids[0], 1)], await anima.read.brainEpoch([ids[0]])])
  );
  // #15: ERC-6551 deployment, autonomy policy, operator, guardian, lifecycle, and guardian pause.
  await tx("deploy agent 15 account", () => anima.write.deployAccount([ids[1]]));
  await tx("set agent 15 policy", () => anima.write.setPolicy([ids[1], {
    perTxWei: 1_000_000_000_000_000n, dailyWei: 2_000_000_000_000_000n, expiry: 0n,
    allowDelegateCall: false, allowUnlistedTargets: true, targetsRoot: ZERO32,
  }]));
  await tx("set agent 15 operator", () => anima.write.setOperator([ids[1], actor.address, true]));
  await tx("set agent 15 guardian", () => anima.write.setGuardian([ids[1], actor.address]));
  await tx("activate agent 15", () => anima.write.setStatus([ids[1], 1]));
  await tx("fund exercise actor", () => ownerWallet.sendTransaction({ to: actor.address, value: parseEther("0.003") }));
  await tx("guardian pauses agent 15", () => animaAsActor.write.guardianPause([ids[1]]));

  // #16: ERC-4907 lease set and clear.
  const now = BigInt((await publicClient.getBlock()).timestamp);
  await tx("lease agent 16", () => anima.write.setUser([ids[2], actor.address, now + 3600n]));
  await tx("clear agent 16 lease", () => anima.write.setUser([ids[2], zeroAddress, 0n]));

  // #17: token approval followed by transfer; verify that approval is consumed, then return it.
  await tx("approve agent 17", () => anima.write.approve([actor.address, ids[3]]));
  await tx("actor transfers agent 17", () => animaAsActor.write.transferFrom([owner, actor.address, ids[3]]));
  await tx("actor returns agent 17", () => animaAsActor.write.transferFrom([actor.address, owner, ids[3]]));

  // #18: both ERC-721 safe-transfer overloads.
  await tx("safe-transfer agent 18", () => anima.write.safeTransferFrom([owner, actor.address, ids[4]]));
  await tx("safe-return agent 18 with data", () =>
    animaAsActor.write.safeTransferFrom([actor.address, owner, ids[4], toHex("round-trip")])
  );

  // #19: global approval, expiry-bounded replacement, and O(1) epoch revocation.
  await tx("grant global approval", () => anima.write.setApprovalForAll([actor.address, true]));
  await tx("bound global approval expiry", () => anima.write.setApprovalForAllUntil([actor.address, now + 3600n]));
  await tx("revoke all approvals", () => anima.write.revokeAllApprovals());

  // #20: signed arbitrary-wallet binding and explicit fallback to its ERC-6551 account.
  const nonce = await anima.read.walletNonce([ids[6]]);
  const deadline = now + 3600n;
  const signature = await actorWallet.signTypedData({
    account: actor, domain: { name: "AnimaAgent", version: "1", chainId: 11155111,
      verifyingContract: record.contracts.anima as Address },
    types: { AgentWalletBinding: [
      { name: "agentId", type: "uint256" }, { name: "wallet", type: "address" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] }, primaryType: "AgentWalletBinding",
    message: { agentId: ids[6], wallet: actor.address, nonce, deadline },
  });
  await tx("bind agent 20 wallet", () => anima.write.setAgentWallet([ids[6], actor.address, deadline, signature]));
  await tx("unset agent 20 wallet", () => anima.write.unsetAgentWallet([ids[6]]));

  // #21: token royalty override. #22: activate/pause/retire lifecycle. #23: transfer reset composition.
  await tx("set agent 21 royalty", () => anima.write.setTokenRoyalty([ids[7], owner, 500n]));
  await tx("activate agent 22", () => anima.write.setStatus([ids[8], 1]));
  await tx("pause agent 22", () => anima.write.setStatus([ids[8], 2]));
  await tx("retire agent 22", () => anima.write.setStatus([ids[8], 4]));
  await tx("configure agent 23 before sale", () => anima.write.setGuardian([ids[9], actor.address]));
  await tx("lease agent 23 before sale", () => anima.write.setUser([ids[9], actor.address, now + 3600n]));
  await tx("transfer agent 23", () => anima.write.transferFrom([owner, actor.address, ids[9]]));

  // Read-surface and composed invariant audit. A failure here makes the live run fail even if
  // every transaction individually mined.
  const [metadata, brain, accountCode, status15, user16, approval17, approval19, wallet20,
    royalty21, status22, guardian23, user23, status23] = await Promise.all([
    anima.read.getMetadata([ids[0], "exercise"]), anima.read.brainOf([ids[0]]),
    publicClient.getCode({ address: await anima.read.accountOf([ids[1]]) }), anima.read.statusOf([ids[1]]),
    anima.read.userOf([ids[2]]), anima.read.getApproved([ids[3]]),
    anima.read.isApprovedForAll([owner, actor.address]), anima.read.getAgentWallet([ids[6]]),
    anima.read.royaltyInfo([ids[7], 10_000n]), anima.read.statusOf([ids[8]]),
    anima.read.guardianOf([ids[9]]), anima.read.userOf([ids[9]]), anima.read.statusOf([ids[9]]),
  ]);
  if (metadata !== toHex("metadata-ok")) throw new Error("metadata read-back mismatch");
  if (brain.length !== 1 || !accountCode || accountCode === "0x") throw new Error("brain/account audit failed");
  if (status15 !== 2 || user16 !== zeroAddress || approval17 !== zeroAddress || approval19) throw new Error("authority audit failed");
  if (getAddress(wallet20) !== getAddress(await anima.read.accountOf([ids[6]]))) throw new Error("wallet fallback failed");
  if (royalty21[1] !== 500n || status22 !== 4) throw new Error("royalty/lifecycle audit failed");
  if (guardian23 !== zeroAddress || user23 !== zeroAddress || status23 !== 2) throw new Error("transfer reset failed");
  if (getAddress(await anima.read.ownerOf([ids[9]])) !== getAddress(actor.address)) throw new Error("final owner mismatch");

  record.batchExercise = {
    chainId: 11155111, actor: actor.address, tokenIds: ids.map(String), evidence,
    completed: true, completedAt: new Date().toISOString(),
    assertions: ["metadata/model/manifest/brain", "ERC-6551/policy/operator/guardian",
      "ERC-4907 lease", "approval and both transfer overloads", "approval epoch revocation",
      "signed wallet binding", "royalties and lifecycle", "sale authority reset"],
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`PASS: ${evidence.length} transactions and composed read-back assertions across agents ${ids[0]}-${ids[9]}`);
}

await main();
