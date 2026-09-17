/** Deploy the ERC-4804 renderer for an existing ANIMA deployment and print token links. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress } from "viem";

async function main() {
  const connection = await network.connect() as any;
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  const path = process.env.ANIMA_DEPLOYMENT ?? `deployments/${chainId}.json`;
  if (!existsSync(path)) throw new Error(`deployment record missing: ${path}`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (Number(record.chainId) !== chainId) throw new Error("deployment record chain mismatch");
  if (getAddress(record.deployer) !== getAddress(wallet.account.address)) {
    throw new Error("deployment record signer mismatch");
  }

  let renderer = record.contracts.web3Renderer;
  if (renderer) {
    const code = await publicClient.getCode({ address: renderer });
    if (!code || code === "0x") throw new Error(`recorded renderer has no code: ${renderer}`);
    console.log(`renderer ${renderer} (reused)`);
  } else {
    const deployed = await viem.deployContract("AnimaWeb3Renderer", [record.contracts.anima]);
    renderer = getAddress(deployed.address);
    record.contracts.web3Renderer = renderer;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`renderer ${renderer} (deployed)`);
  }

  const suffix: Record<number, string> = { 11155111: "sep", 84532: "basesep" };
  const chain = suffix[chainId] ?? String(chainId);
  const ids: string[] = record.batchMint?.tokenIds ?? [];
  console.log(`root https://${renderer.toLowerCase()}.${chain}.w3link.io/`);
  for (const id of ids) console.log(`token ${id} https://${renderer.toLowerCase()}.${chain}.w3link.io/token/${id}/live`);
}

await main();
