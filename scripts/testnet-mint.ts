/** Mint and arm one real agent on the selected live testnet, resumably. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, keccak256, parseEventLogs, toHex, zeroAddress, type Hex } from "viem";
import { lockedDownPolicy, ShardKind } from "../sdk/src/index.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const explorer: Record<number, string> = {
  1301: "https://sepolia.uniscan.xyz", 46630: "https://explorer.testnet.chain.robinhood.com",
  97: "https://testnet.bscscan.com", 11155111: "https://sepolia.etherscan.io",
  84532: "https://sepolia.basescan.org",
};

async function main() {
  const connection = await network.connect();
  const { viem } = connection as any;
  const pc = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const chainId = await pc.getChainId();
  const owner = getAddress(wallet.account.address);
  const canonical = `deployments/${chainId}.json`;
  const owned = `deployments/${chainId}-${owner.toLowerCase()}.json`;
  const path = existsSync(owned) ? owned : canonical;
  if (!existsSync(path)) throw new Error(`deployment record missing: ${path}`);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  if (getAddress(rec.deployer) !== owner) throw new Error("deployment record belongs to another deployer");
  rec.smoke ??= {};
  const save = () => writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
  const anima = await viem.getContractAt("AnimaAgent", rec.contracts.anima);
  const base = explorer[chainId] ?? "";
  const tx = async (label: string, run: () => Promise<Hex>) => {
    const hash = await run(); const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60; i++) {
      if ((await pc.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(`${label.padEnd(30)} ${base}/tx/${hash}`); return receipt;
  };

  let agentId: bigint;
  if (rec.smoke.agentId) {
    agentId = BigInt(rec.smoke.agentId);
    if (getAddress(await anima.read.ownerOf([agentId])) !== owner) throw new Error("saved smoke agent owner mismatch");
  } else {
    const shard = { dataHash: keccak256(toHex(`live-memory-${chainId}`)), keyCommitment: keccak256(toHex(`key-${chainId}`)),
      size: 16n, kind: ShardKind.Memory, uri: `ipfs://anima/live/${chainId}`, description: "live testnet memory" };
    const receipt = await tx("mint live agent", () => anima.write.mintAgent([
      owner, `https://testnet.anima.example/${chainId}.json`, keccak256(toHex(`manifest-${chainId}`)),
      { weightsRoot: keccak256(toHex(`weights-${chainId}`)), runtimeMeasurement: ZERO32, attestationKind: 1,
        modelId: "testnet/audit-agent" }, [shard], 1, [],
    ]));
    const log: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: receipt.logs })
      .find((x: any) => x.args.from === zeroAddress);
    if (!log) throw new Error("mint event missing");
    agentId = log.args.tokenId; rec.smoke.agentId = agentId.toString(); save();
  }
  if (!rec.smoke.account) {
    await tx("deploy ERC-6551 account", () => anima.write.deployAccount([agentId]));
    rec.smoke.account = await anima.read.accountOf([agentId]); save();
  }
  if (!rec.smoke.policy) {
    await tx("publish autonomy policy", () => anima.write.setPolicy([agentId, {
      ...lockedDownPolicy(), allowUnlistedTargets: true, perTxWei: 10n ** 14n, dailyWei: 10n ** 15n,
    }])); rec.smoke.policy = true; save();
  }
  if (!rec.smoke.active) {
    await tx("activate agent", () => anima.write.setStatus([agentId, 1])); rec.smoke.active = true; save();
  }
  if (!rec.smoke.executed) {
    const account = await viem.getContractAt("AgentAccount", rec.smoke.account);
    await tx("execute from agent wallet", () => account.write.execute([owner, 0n, "0x", 0]));
    rec.smoke.executed = true; save();
  }
  const code = await pc.getCode({ address: rec.smoke.account });
  if (!code || code === "0x") throw new Error("agent account has no code");
  console.log(`PASS chain=${chainId} agent=${agentId} token=${rec.contracts.anima} account=${rec.smoke.account}`);
}
await main();
