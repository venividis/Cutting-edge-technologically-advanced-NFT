#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, labelhash, namehash,
  parseAbi, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalize } from "viem/ens";

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const BASE_REGISTRAR = "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85";
const NAME_WRAPPER = "0xD4416b13d2b3a9aBae7AcD5A6bF1c4945aE05Dd6";
const registryAbi = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
  "function owner(bytes32 node) view returns (address)",
]);
const resolverAbi = parseAbi([
  "function multicall(bytes[] data) returns (bytes[] results)",
  "function setAddr(bytes32 node, address addr)",
  "function setText(bytes32 node, string key, string value)",
  "function setContenthash(bytes32 node, bytes hash)",
]);
const animaAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function accountOf(uint256 agentId) view returns (address)",
  "function isController(uint256 agentId, address account) view returns (bool)",
]);
const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
]);
const wrapperAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
]);

let rl;
const ask = async (question, fallback) => {
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer || fallback || "";
};
const yes = async (question, fallback = false) => {
  const answer = (await ask(`${question} (y/n)`, fallback ? "y" : "n")).toLowerCase();
  return answer === "y" || answer === "yes";
};

function base32Decode(value) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const raw of value.toLowerCase().replace(/=+$/, "")) {
    const digit = alphabet.indexOf(raw);
    if (digit < 0) throw new Error(`invalid base32 character: ${raw}`);
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
      accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

// ENS contenthash is varint(ipfs-ns = 0xe3) followed by the CID bytes.
export function encodeContenthash(uri) {
  if (uri.startsWith("0x")) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(uri)) throw new Error("pre-encoded contenthash must be non-empty, even-length hex");
    return uri;
  }
  if (!uri.startsWith("ipfs://")) throw new Error("use an ipfs:// CID or pre-encoded 0x contenthash");
  const cid = uri.slice(7).split("/")[0];
  if (!cid.startsWith("b")) throw new Error("use a CIDv1 base32 IPFS address (starts with b)");
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length < 4 || bytes[0] !== 1) throw new Error("invalid CIDv1 base32 IPFS address");
  return `0xe301${Buffer.from(bytes).toString("hex")}`;
}

export function assertMainnetEnsCustody(chainId) {
  if (chainId !== 1) {
    throw new Error("ENS custody requires an agent whose home chain is Ethereum mainnet (chain 1)");
  }
}

async function send(publicClient, wallet, request, label) {
  const { request: simulated } = await publicClient.simulateContract({ ...request, account: wallet.account });
  const hash = await wallet.writeContract(simulated);
  output.write(`  submitted ${label}: ${hash}\n`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  output.write(`  confirmed ${label} in block ${receipt.blockNumber}\n`);
}

async function bind() {
  output.write("\nBind an ENS name to an ANIMA agent\n");
  output.write("No private key is printed or stored. Transactions are simulated before submission.\n\n");
  const agentRpc = await ask("Agent-chain RPC URL", process.env.ANIMA_RPC_URL || process.env.RPC_BASE);
  const ensRpc = await ask("Ethereum ENS RPC URL", process.env.ENS_RPC_URL || process.env.RPC_ETHEREUM);
  const contract = getAddress(await ask("ANIMA contract", process.env.ANIMA_CONTRACT));
  const id = BigInt(await ask("Agent token ID"));
  const ensName = normalize((await ask("ENS name (for example atlas.eth)")).toLowerCase());
  if (!ensName.endsWith(".eth") || ensName.split(".").some((part) => !part)) throw new Error("enter a valid .eth name");
  const contentUri = await ask("GUI content URI (ipfs:// CID, blank to leave unchanged)");
  const canonical = await ask("HTTPS fallback URL (blank to omit)");
  if (canonical && !canonical.startsWith("https://")) throw new Error("fallback URL must use https://");
  const privateKey = process.env.ANIMA_PRIVATE_KEY;
  if (!privateKey) throw new Error("set ANIMA_PRIVATE_KEY in your environment; the terminal will not echo or save keys");

  const account = privateKeyToAccount(privateKey);
  const agentClient = createPublicClient({ transport: http(agentRpc) });
  const ensClient = createPublicClient({ transport: http(ensRpc) });
  const ensWallet = createWalletClient({ account, transport: http(ensRpc) });
  const ensChainId = await ensClient.getChainId();
  if (ensChainId !== 1) throw new Error(`ENS_RPC_URL must connect to Ethereum mainnet (chain 1), got ${ensChainId}`);
  const [chainId, owner, agentAccount, controller] = await Promise.all([
    agentClient.getChainId(),
    agentClient.readContract({ address: contract, abi: animaAbi, functionName: "ownerOf", args: [id] }),
    agentClient.readContract({ address: contract, abi: animaAbi, functionName: "accountOf", args: [id] }),
    agentClient.readContract({ address: contract, abi: animaAbi, functionName: "isController", args: [id, account.address] }),
  ]);
  if (!controller) throw new Error(`${account.address} is not a controller of agent ${id}`);
  const node = namehash(ensName);
  const [resolver, registryOwner] = await Promise.all([
    ensClient.readContract({ address: ENS_REGISTRY, abi: registryAbi, functionName: "resolver", args: [node] }),
    ensClient.readContract({ address: ENS_REGISTRY, abi: registryAbi, functionName: "owner", args: [node] }),
  ]);
  if (resolver === zeroAddress) throw new Error(`${ensName} has no resolver; configure one in the ENS manager first`);
  const identity = `eip155:${chainId}:${contract.toLowerCase()}:${id}`;
  output.write(`\n  signer:        ${account.address}\n  NFT owner:     ${owner}\n  agent account: ${agentAccount}\n  ENS owner:     ${registryOwner}\n  identity:      ${identity}\n  resolver:      ${resolver}\n`);
  if (!await yes("Write the agent address and ANIMA identity records", true)) return;

  const records = [
    encodeFunctionData({ abi: resolverAbi, functionName: "setAddr", args: [node, agentAccount] }),
    encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, "com.anima.agent", identity] }),
    encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, "com.anima.account", agentAccount] }),
  ];
  if (canonical) records.push(encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [node, "url", canonical] }));
  if (contentUri) records.push(encodeFunctionData({ abi: resolverAbi, functionName: "setContenthash", args: [node, encodeContenthash(contentUri)] }));
  await send(ensClient, ensWallet, { address: resolver, abi: resolverAbi, functionName: "multicall", args: [records] }, "ENS records (atomic)");

  if (ensName.split(".").length === 2 && await yes("Transfer custody of this .eth name to the agent account (it will follow NFT ownership)", false)) {
    assertMainnetEnsCustody(chainId);
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error("only the current NFT owner may transfer an ENS name into permanent agent custody");
    }
    const confirmation = await ask(`Type ${ensName} to confirm permanent agent custody`);
    if (confirmation !== ensName) throw new Error("custody confirmation did not match");
    const wrapped = registryOwner.toLowerCase() === NAME_WRAPPER.toLowerCase();
    if (wrapped) {
      const balance = await ensClient.readContract({ address: NAME_WRAPPER, abi: wrapperAbi, functionName: "balanceOf", args: [account.address, BigInt(node)] });
      if (balance !== 1n) throw new Error("signer does not own the wrapped ENS name");
      await send(ensClient, ensWallet, { address: NAME_WRAPPER, abi: wrapperAbi, functionName: "safeTransferFrom", args: [account.address, agentAccount, BigInt(node), 1n, "0x"] }, "wrapped ENS custody transfer");
    } else {
      const tokenId = BigInt(labelhash(ensName.slice(0, -4)));
      const registrant = await ensClient.readContract({ address: BASE_REGISTRAR, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] });
      if (registrant.toLowerCase() !== account.address.toLowerCase()) throw new Error("signer is not the .eth registrant");
      await send(ensClient, ensWallet, { address: BASE_REGISTRAR, abi: erc721Abi, functionName: "safeTransferFrom", args: [account.address, agentAccount, tokenId] }, "ENS custody transfer");
    }
  }
  output.write(`\nBound ${ensName} to agent ${id}. Open it in an ENS-aware browser or through https://${ensName}.limo\n\n`);
}

function help() {
  output.write("\nCommands:\n  /bind   Bind a .eth name, contenthash and agent identity\n  /help   Show this help\n  /exit   Close the terminal\n\nStart with: npm run anima\nSecrets are read only from ANIMA_PRIVATE_KEY.\n\n");
}

async function main() {
  rl = createInterface({ input, output });
  output.write("ANIMA terminal — type /bind to give an agent a sovereign web name.\n");
  help();
  while (true) {
    const command = (await rl.question("anima> ")).trim();
    if (command === "/exit" || command === "/quit") break;
    try {
      if (command === "/bind") await bind();
      else if (command === "/help" || command === "") help();
      else output.write(`Unknown command ${command}. Type /help.\n`);
    } catch (error) {
      output.write(`\nBind stopped: ${error instanceof Error ? error.message : String(error)}\nNo later steps were submitted. Correct the issue and run /bind again.\n\n`);
    }
  }
  rl.close();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
