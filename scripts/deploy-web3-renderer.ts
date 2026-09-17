/** Deploy the ERC-4804 renderer for an existing ANIMA deployment and print token links. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress } from "viem";

const collectionAbi = [
  {
    type: "function",
    name: "totalMinted",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

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
  const anima = getAddress(record.contracts.anima);
  const animaCode = await publicClient.getCode({ address: anima });
  if (!animaCode || animaCode === "0x") throw new Error(`ANIMA has no code: ${anima}`);

  let renderer = record.contracts.web3Renderer;
  if (renderer) {
    const code = await publicClient.getCode({ address: renderer });
    if (!code || code === "0x") throw new Error(`recorded renderer has no code: ${renderer}`);
    console.log(`renderer ${renderer} (reused)`);
  } else {
    // The renderer is immutable, stateless and has no privileged owner. Any funded account may
    // deploy it, which makes recovery possible without the original collection deployer key.
    const deployed = await viem.deployContract("AnimaWeb3Renderer", [anima]);
    renderer = getAddress(deployed.address);
    record.contracts.web3Renderer = renderer;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`renderer ${renderer} (deployed)`);
  }

  const suffix: Record<number, string> = { 11155111: "sep", 84532: "basesep" };
  const chain = suffix[chainId] ?? String(chainId);
  const totalMinted = await publicClient.readContract({ address: anima, abi: collectionAbi, functionName: "totalMinted" });
  const root = `https://${renderer.toLowerCase()}.${chain}.w3link.io/`;
  const tokenUrls = Array.from({ length: Number(totalMinted) }, (_, index) =>
    `${root}token/${index + 1}/live`
  );
  console.log(`root ${root}`);
  tokenUrls.forEach((url, index) => console.log(`token ${index + 1} ${url}`));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `renderer=${renderer}\nroot=${root}\ntotal_minted=${totalMinted}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const links = tokenUrls.length
      ? tokenUrls.map((url, index) => `- [ANIMA #${index + 1}](${url})`).join("\n")
      : "- No tokens have been minted yet.";
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## ANIMA ERC-4804 browser\n\n- Renderer: \`${renderer}\`\n- [Collection browser](${root})\n${links}\n`,
    );
  }
}

await main();
