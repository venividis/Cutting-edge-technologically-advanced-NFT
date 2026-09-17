/** Mint a resumable batch of test agents into an existing live deployment. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getContract,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { network } from "hardhat";

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const EXPLORERS: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
  11155420: "https://sepolia-optimism.etherscan.io",
  421614: "https://sepolia.arbiscan.io",
  84532: "https://sepolia.basescan.org",
  1301: "https://sepolia.uniscan.xyz",
  97: "https://testnet.bscscan.com",
};
const NETWORKS: Record<string, { id: number; rpc: string }> = {
  sepolia: { id: 11155111, rpc: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com" },
  baseSepolia: { id: 84532, rpc: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
  opSepolia: { id: 11155420, rpc: process.env.OP_SEPOLIA_RPC ?? "https://sepolia.optimism.io" },
  arbitrumSepolia: { id: 421614, rpc: process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc" },
  unichainSepolia: { id: 1301, rpc: process.env.UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org" },
  bscTestnet: { id: 97, rpc: process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com" },
};

interface BatchMint {
  count: number;
  recipient: string;
  tokenIds: string[];
  transactions: Hex[];
}

async function main() {
  const count = Number(process.env.ANIMA_MINT_COUNT ?? "10");
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error("ANIMA_MINT_COUNT must be an integer between 1 and 100");
  }

  const connection = await network.connect();
  const networkName = connection.networkName;
  const selected = NETWORKS[networkName];
  if (!selected) throw new Error(`unsupported testnet: ${networkName}`);
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required");
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  const chain = defineChain({
    id: selected.id,
    name: networkName,
    nativeCurrency: { name: "Testnet Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [selected.rpc] } },
  });
  const transport = http(selected.rpc, {
    retryCount: 8,
    retryDelay: 1_000,
    fetchOptions: proxy ? ({ dispatcher: new ProxyAgent(proxy) } as any) : undefined,
  });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const chainId = await publicClient.getChainId();
  const signer = getAddress(account.address);
  const recipient = getAddress(process.env.ANIMA_MINT_RECIPIENT ?? signer);
  const path = process.env.ANIMA_DEPLOYMENT ?? `deployments/${chainId}.json`;
  if (!existsSync(path)) throw new Error(`deployment record missing: ${path}`);

  const record = JSON.parse(readFileSync(path, "utf8"));
  if (Number(record.chainId) !== chainId) throw new Error("deployment record chain mismatch");
  if (getAddress(record.deployer) !== signer) throw new Error("deployment record signer mismatch");
  const code = await publicClient.getCode({ address: record.contracts.anima });
  if (!code || code === "0x") throw new Error("recorded ANIMA token has no code");

  record.batchMint ??= {
    count,
    recipient,
    tokenIds: [],
    transactions: [],
  } satisfies BatchMint;
  const batch = record.batchMint as BatchMint;
  if (batch.count !== count || getAddress(batch.recipient) !== recipient) {
    throw new Error("existing batch checkpoint does not match the requested count or recipient");
  }
  const save = () => writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  const artifact = JSON.parse(readFileSync("artifacts/contracts/core/AnimaAgent.sol/AnimaAgent.json", "utf8"));
  const token = getContract({ address: record.contracts.anima, abi: artifact.abi, client: { public: publicClient, wallet } });
  const explorer = EXPLORERS[chainId];
  let nonce = await publicClient.getTransactionCount({ address: signer, blockTag: "latest" });
  let lastReceiptBlock = 0n;

  for (let index = batch.tokenIds.length; index < count; index++) {
    const serial = index + 1;
    const hash = await token.write.mintAgent([
      recipient,
      `ipfs://anima/testnet-batch/${chainId}/${serial}.json`,
      keccak256(toHex(`anima-testnet-manifest:${chainId}:${serial}`)),
      {
        weightsRoot: keccak256(toHex(`anima-testnet-weights:${chainId}:${serial}`)),
        runtimeMeasurement: ZERO32,
        attestationKind: 0,
        modelId: `testnet/batch-agent-${serial}`,
      },
      [],
      0,
      [],
    ], { gas: 2_500_000n, nonce: nonce++ });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`mint ${serial} reverted: ${hash}`);
    lastReceiptBlock = receipt.blockNumber;
    const transfer: any = parseEventLogs({ abi: token.abi, eventName: "Transfer", logs: receipt.logs })
      .find((log: any) => log.args.from === zeroAddress && getAddress(log.args.to) === recipient);
    if (!transfer) throw new Error(`mint ${serial} emitted no matching Transfer event: ${hash}`);
    const tokenId = transfer.args.tokenId.toString();
    batch.tokenIds.push(tokenId);
    batch.transactions.push(hash);
    save();
    console.log(`mint ${serial}/${count}: token ${tokenId} ${explorer ? `${explorer}/tx/${hash}` : hash}`);
  }

  // Public RPC URLs commonly sit in front of nodes at different heights. Do not let a receipt
  // returned by one backend race the ownership reads served by another backend.
  if (lastReceiptBlock) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await publicClient.getBlockNumber({ cacheTime: 0 }) >= lastReceiptBlock) break;
      if (attempt === 39) throw new Error(`RPC did not reach mint block ${lastReceiptBlock}`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  for (const tokenId of batch.tokenIds) {
    let owner: string | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        owner = getAddress(await token.read.ownerOf([BigInt(tokenId)]));
        break;
      } catch (error) {
        if (attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
    if (owner !== recipient) throw new Error(`token ${tokenId} owner is ${owner}, expected ${recipient}`);
  }
  console.log(`PASS minted=${batch.tokenIds.length} tokens=${batch.tokenIds.join(",")} contract=${record.contracts.anima}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
