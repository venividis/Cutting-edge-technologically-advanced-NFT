/** Generate the complete machine-readable public function index from compiled project ABIs. */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { toFunctionSelector } from "viem";
import { formatAbiItem } from "abitype";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const artifacts = join(root, "artifacts/contracts");
const output = join(root, "public/anima-functions.json");
const deployment = JSON.parse(readFileSync(join(root, "deployments/84532-0xc591c669162cd4da8ab9bfa2c2e68d538a312c00.json"), "utf8"));
const addressKeys = {
  AnimaDiamond: "anima", AnimaAgent: "anima", EncryptionKeyRegistry: "keyRegistry",
  BondVault: "bonds", ReputationRegistry: "reputation", ValidationRegistry: "validation", WorkEscrow: "escrow",
  AgentMarket: "market", AgentComms: "comms", InferenceMeter: "meter", AgentHandles: "handles", AnimaRoles: "roles",
  AgentLaunchpad: "launchpad", AgentSwapRouter: "swapRouter", AgentDerivativesDesk: "derivatives", AnimaBindings: "bindings",
  AnimaWeb3Renderer: "web3Renderer",
};
const excluded = /\/(interfaces|mocks|libraries)\//;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const contracts = files(artifacts)
  .filter((path) => path.endsWith(".json") && !path.endsWith(".dbg.json"))
  .map((path) => JSON.parse(readFileSync(path, "utf8")))
  .filter((artifact) => artifact.sourceName?.startsWith("contracts/") && artifact.bytecode !== "0x" &&
    !excluded.test(`/${artifact.sourceName}`))
  .map((artifact) => {
    const functions = artifact.abi.filter((item) => item.type === "function").map((item) => {
      const signature = formatAbiItem(item).replace(/^function /, "");
      return {
        name: item.name,
        signature,
        selector: toFunctionSelector(item),
        stateMutability: item.stateMutability,
        inputs: item.inputs,
        outputs: item.outputs ?? [],
      };
    }).sort((a, b) => a.signature.localeCompare(b.signature));
    const key = addressKeys[artifact.contractName];
    return {
      contract: artifact.contractName,
      source: artifact.sourceName,
      ...(key && deployment.contracts[key] ? { baseSepoliaAddress: deployment.contracts[key] } : {}),
      functions,
    };
  })
  .filter((entry) => entry.functions.length > 0)
  .sort((a, b) => a.contract.localeCompare(b.contract) || a.source.localeCompare(b.source));

const result = {
  type: "anima-function-index/1",
  description: "Complete ABI-derived callable function index. Presence does not imply authorization, deployment, safety, or availability.",
  chainId: 84532,
  generatedFrom: "artifacts/contracts",
  contractCount: contracts.length,
  functionCount: contracts.reduce((sum, entry) => sum + entry.functions.length, 0),
  contracts,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${relative(root, output)}: ${result.contractCount} contracts, ${result.functionCount} functions`);
