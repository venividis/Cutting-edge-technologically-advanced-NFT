/**
 * Live, multi-owner adversarial scenario for Base Sepolia.
 *
 * Three independently signed wallets each own an agent, fund its bond and conduct a
 * circular paid conversation.  Each wallet then deliberately attacks the next resident's
 * NFT, wallet, metadata and bond.  Reverts are broadcast (not merely simulated), so every
 * negative assertion has an immutable receipt.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { createWalletClient, getAddress, http, keccak256, parseEventLogs, toHex, zeroAddress,
  type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ProxyAgent } from "undici";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const USD = (n: number) => BigInt(n) * 1_000_000n;

async function main() {
  const deploymentPath = process.env.ANIMA_DEPLOYMENT;
  if (!deploymentPath) throw new Error("ANIMA_DEPLOYMENT is required");
  const rec = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const c = rec.contracts;
  const { viem } = await network.connect({ network: "baseSepolia" }) as any;
  const pc = await viem.getPublicClient();
  const [mayor] = await viem.getWalletClients();
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const transport = () => http(rpc, {
    retryCount: 8,
    retryDelay: 1_000,
    fetchOptions: proxy ? ({ dispatcher: new ProxyAgent(proxy) } as any) : undefined,
  });
  const keyPath = process.env.ANIMA_TOWN_KEYS ?? "/tmp/anima-town-keys.json";
  const savedKeys = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, "utf8")) : {};
  const residents: any[] = ["Ada", "Babbage", "Curie"].map((name) => {
    const privateKey = (savedKeys[name] ?? generatePrivateKey()) as Hex;
    const account = privateKeyToAccount(privateKey);
    return { name, privateKey, account, wallet: createWalletClient({ account, chain: baseSepolia, transport: transport() }) };
  });
  // Recovery material is deliberately outside the repository and is never printed.
  writeFileSync(keyPath, JSON.stringify(Object.fromEntries(residents.map(r => [r.name, r.privateKey])), null, 2), { mode: 0o600 });

  const evidence: Array<{ label: string; hash: Hex; status: string }> = [];
  const wait = async (label: string, hash: Hex, expected: "success" | "reverted" = "success") => {
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== expected) throw new Error(`${label}: expected ${expected}, got ${receipt.status}: ${hash}`);
    evidence.push({ label, hash, status: receipt.status });
    console.log(`${expected === "success" ? "✓" : "✓ REVERT"} ${label}: https://sepolia.basescan.org/tx/${hash}`);
    return receipt;
  };
  const at = async (name: string, address: Address, wallet?: any) =>
    viem.getContractAt(name, address, wallet ? { client: { wallet } } : undefined);
  const anima = await at("AnimaAgent", c.anima);
  const token = await at("MockERC20", c.usdc);
  const bonds = await at("BondVault", c.bonds);

  // Give each independent signer only enough ETH to participate, plus public test aUSD.
  for (const r of residents) {
    if (await pc.getBalance({ address: r.account.address }) < 1_000_000_000_000_000n) {
      await wait(`fund ${r.name} gas`, await mayor.sendTransaction({ to: r.account.address, value: 2_000_000_000_000_000n }));
    }
    if (await token.read.balanceOf([r.account.address]) < USD(1000)) {
      await wait(`mint ${r.name} 1000 aUSD`, await token.write.mint([r.account.address, USD(1000)]));
    }
  }

  for (const r of residents) {
    const a = await at("AnimaAgent", c.anima, r.wallet);
    const receipt = await wait(`mint ${r.name}'s agent`, await a.write.mintAgent([
      r.account.address, `ipfs://town/${r.name.toLowerCase()}.json`, ZERO32,
      { weightsRoot: keccak256(toHex(`${r.name}:weights`)), runtimeMeasurement: ZERO32, attestationKind: 0, modelId: `town/${r.name}` },
      [], 0, [],
    ], { gas: 2_500_000n }));
    const log: any = parseEventLogs({ abi: a.abi, eventName: "Transfer", logs: receipt.logs })
      .find((x: any) => x.args.from === zeroAddress);
    r.agentId = log.args.tokenId;
    await wait(`deploy ${r.name}'s agent wallet`, await a.write.deployAccount([r.agentId], { gas: 1_000_000n }));
    const t = await at("MockERC20", c.usdc, r.wallet);
    const b = await at("BondVault", c.bonds, r.wallet);
    await wait(`${r.name} approves vault`, await t.write.approve([c.bonds, USD(500)], { gas: 150_000n }));
    await wait(`${r.name} bonds its agent`, await b.write.deposit([r.agentId, USD(500)], { gas: 300_000n }));
  }

  // Closed inboxes plus an agent-id allowlist demonstrate authenticated agent-to-agent mail.
  for (let i = 0; i < residents.length; i++) {
    const receiver = residents[i], sender = residents[(i + residents.length - 1) % residents.length];
    const comms = await at("AgentComms", c.comms, receiver.wallet);
    await wait(`${receiver.name} opens a closed inbox`, await comms.write.configureInbox([receiver.agentId, c.usdc, USD(2), 3600n, false], { gas: 200_000n }));
    await wait(`${receiver.name} allowlists ${sender.name}'s agent`, await comms.write.setAgentSenderAllowed([receiver.agentId, sender.agentId, true], { gas: 150_000n }));
  }
  for (let i = 0; i < residents.length; i++) {
    const sender = residents[i], receiver = residents[(i + 1) % residents.length];
    const tokenAsSender = await at("MockERC20", c.usdc, sender.wallet);
    const comms = await at("AgentComms", c.comms, sender.wallet);
    await wait(`${sender.name} approves postage`, await tokenAsSender.write.approve([c.comms, USD(2)], { gas: 150_000n }));
    const sent = await wait(`${sender.name}'s agent messages ${receiver.name}'s`, await comms.write.send([
      receiver.agentId, sender.agentId, keccak256(toHex(`town-thread-${i}`)), keccak256(toHex(`hello from ${sender.name}`)),
      `ipfs://town/message-${i}`, c.usdc, USD(2),
    ], { gas: 400_000n }));
    const event: any = parseEventLogs({ abi: comms.abi, eventName: "MessageSent", logs: sent.logs })[0];
    const reply = await at("AgentComms", c.comms, receiver.wallet);
    await wait(`${receiver.name}'s agent replies`, await reply.write.reply([event.args.messageId, keccak256(toHex(`reply from ${receiver.name}`)), `ipfs://town/reply-${i}`], { gas: 300_000n }));
  }

  // Broadcast four distinct ownership violations with explicit gas to bypass preflight
  // simulation. A successful receipt here aborts the run.
  for (let i = 0; i < residents.length; i++) {
    const attacker = residents[i], victim = residents[(i + 1) % residents.length];
    const victimOwner = getAddress(victim.account.address);
    const a = await at("AnimaAgent", c.anima, attacker.wallet);
    const b = await at("BondVault", c.bonds, attacker.wallet);
    const accountAddress = await anima.read.accountOf([victim.agentId]);
    const account = await at("AgentAccount", accountAddress, attacker.wallet);
    await wait(`${attacker.name} cannot steal ${victim.name}'s NFT`, await a.write.transferFrom([victimOwner, attacker.account.address, victim.agentId], { gas: 300_000n }), "reverted");
    await wait(`${attacker.name} cannot rewrite ${victim.name}'s manifest`, await a.write.setManifest([victim.agentId, "ipfs://evil", keccak256(toHex("evil"))], { gas: 300_000n }), "reverted");
    await wait(`${attacker.name} cannot operate ${victim.name}'s wallet`, await account.write.execute([attacker.account.address, 0n, "0x", 0], { gas: 300_000n }), "reverted");
    await wait(`${attacker.name} cannot unbond ${victim.name}'s vault`, await b.write.requestUnbond([victim.agentId, USD(1)], { gas: 300_000n }), "reverted");
  }

  rec.townRun = {
    chainId: await pc.getChainId(), at: new Date().toISOString(),
    residents: residents.map(r => ({ name: r.name, address: r.account.address, agentId: r.agentId.toString() })),
    successfulTransactions: evidence.filter(x => x.status === "success").length,
    expectedReverts: evidence.filter(x => x.status === "reverted").length,
    evidence,
  };
  writeFileSync(deploymentPath, JSON.stringify(rec, null, 2) + "\n");
  console.log(`\nTown complete: ${rec.townRun.successfulTransactions} successes, ${rec.townRun.expectedReverts} mined attack reverts.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
