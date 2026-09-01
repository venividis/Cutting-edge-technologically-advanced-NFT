/**
 * Deploy ANIMA to a live chain, resumably.
 *
 *   source .scratch-env.sh
 *   npx hardhat run scripts/testnet-deploy.ts --network baseSepolia
 *
 * Every deployment is recorded in `deployments/<chainId>.json` as it happens, and re-running
 * reuses whatever is already there. A public testnet will drop a transaction sooner or later, and
 * losing twenty contracts because the twenty-first timed out is not a failure mode worth having.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, parseEther, parseUnits, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployDiamond } from "./deploy-diamond.js";

const CANONICAL_ERC6551_REGISTRY = "0x000000006551c19487814612e58FE06813775758" as const;
/** ERC-4337 v0.7, at the same address on every chain that has it. */
const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
const DAY = 86_400;

interface Record_ {
  chainId: number;
  deployer: Address;
  contracts: Record<string, Address>;
  /** `keyFile` is a bare name inside ANIMA_KEY_DIR — never a path, and never the key. */
  cast: Record<string, { address: Address; keyFile: string }>;
  wiring: string[];
}

export async function main() {
  // With Hardhat 3 the CLI-selected network lives on the default connection; it is not exposed
  // through HARDHAT_NETWORK. Supplying our own fallback here silently ignored `--network` and
  // could make an operator transact on Base while believing they selected another chain.
  const connection = await network.connect();
  const { viem } = connection as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = getAddress(wallet.account.address);
  const chainId = await publicClient.getChainId();
  const startingBalance = await publicClient.getBalance({ address: deployer });

  // Multiple independent operators can deploy on the same testnet. An explicit record keeps
  // their resumable state separate without weakening the signer check below.
  const path = process.env.ANIMA_DEPLOYMENT_FILE ?? `deployments/${chainId}.json`;
  const rec: Record_ = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { chainId, deployer, contracts: {}, cast: {}, wiring: [] };
  if (rec.chainId !== chainId) throw new Error(`deployment record chain ${rec.chainId} does not match RPC chain ${chainId}`);
  if (getAddress(rec.deployer) !== deployer) {
    throw new Error(
      `deployment record ${path} belongs to ${rec.deployer}, not connected signer ${deployer}; ` +
        `refusing to fund its cast or reuse its privileged wiring state`
    );
  }
  const save = () => writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);

  const keyDir = process.env.ANIMA_KEY_DIR;
  if (!keyDir) throw new Error("ANIMA_KEY_DIR must point at a directory outside this repository");

  console.log(`\nchain ${chainId}   deployer ${deployer}`);
  console.log(`balance ${Number(startingBalance) / 1e18} ETH`);
  console.log(`record  ${path}\n`);

  /** Deploy once, then reuse. The unit of resumability. */
  const once = async (name: string, contract: string, args: unknown[] = []) => {
    if (rec.contracts[name]) {
      console.log(`  ${name.padEnd(24)} ${rec.contracts[name]}  (reused)`);
      return rec.contracts[name];
    }
    const c = await viem.deployContract(contract, args);
    // Public RPCs are load balancers; the next call can hit a node that has not caught up.
    for (let i = 0; i < 40; i++) {
      const code = await publicClient.getCode({ address: c.address });
      if (code && code !== "0x") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    rec.contracts[name] = getAddress(c.address);
    save();
    console.log(`  ${name.padEnd(24)} ${rec.contracts[name]}`);
    return rec.contracts[name] as Address;
  };

  // ---- prerequisites -------------------------------------------------------
  const registryCode = await publicClient.getCode({ address: CANONICAL_ERC6551_REGISTRY });
  if (!registryCode || registryCode === "0x") {
    throw new Error(
      `no ERC-6551 registry at ${CANONICAL_ERC6551_REGISTRY} on chain ${chainId} — refusing to ` +
        `fall back to a mock, which would derive agent wallets no wallet or indexer recognises`
    );
  }
  rec.contracts.registry = CANONICAL_ERC6551_REGISTRY;

  const epCode = await publicClient.getCode({ address: ENTRYPOINT_V07 });
  const entryPoint = epCode && epCode !== "0x" ? ENTRYPOINT_V07 : zeroAddress;
  console.log(`  ERC-6551 registry        ${CANONICAL_ERC6551_REGISTRY}  (canonical, live)`);
  console.log(`  EntryPoint v0.7          ${entryPoint === zeroAddress ? "absent — 4337 disabled" : entryPoint}\n`);

  // ---- layer 1 -------------------------------------------------------------
  const accountImpl = await once("accountImpl", "AgentAccount", [entryPoint]);
  const keyRegistry = await once("keyRegistry", "EncryptionKeyRegistry");
  const verifier = await once("verifier", "NullTransferVerifier");

  // ---- the token, as the immutable diamond --------------------------------
  if (!rec.contracts.anima) {
    const built = await deployDiamond(
      {
        name: "ANIMA Agents",
        symbol: "ANIMA",
        owner: deployer,
        registry: CANONICAL_ERC6551_REGISTRY,
        accountImplementation: accountImpl,
        keyRegistry,
        verifier,
        royaltyReceiver: deployer,
        royaltyBps: 500n,
        facets: {
          core: rec.contracts.facetCore,
          agent: rec.contracts.facetAgent,
          brain: rec.contracts.facetBrain,
          loupe: rec.contracts.facetLoupe,
          init: rec.contracts.animaInit,
        },
      },
      connection
    );
    rec.contracts.anima = built.token;
    rec.contracts.facetCore = built.facets.core;
    rec.contracts.facetAgent = built.facets.agent;
    rec.contracts.facetBrain = built.facets.brain;
    rec.contracts.facetLoupe = built.facets.loupe;
    rec.contracts.animaInit = built.init;
    save();
  } else {
    console.log(`  anima (diamond)          ${rec.contracts.anima}  (reused)`);
  }
  const anima = rec.contracts.anima as Address;

  // ---- settlement asset ----------------------------------------------------
  // A faucet token stands in for USDC. Its `mint` is permissionless on purpose: this is a
  // testnet, and every participant needs to be able to pay without asking anyone.
  console.log("\nprotocol");
  const usdc = await once("usdc", "MockERC20", ["ANIMA Test USD", "aUSD", 6]);

  // ---- layer 2: accountability --------------------------------------------
  const bonds = await once("bonds", "BondVault", [usdc, anima, 7 * DAY, deployer]);
  const reputation = await once("reputation", "ReputationRegistry", [anima, deployer]);
  const validation = await once("validation", "ValidationRegistry", [anima, deployer]);
  const escrow = await once("escrow", "WorkEscrow", [
    usdc, anima, bonds, reputation, validation, deployer, 100n, deployer,
  ]);

  // ---- layer 3/4: markets and reach ---------------------------------------
  const market = await once("market", "AgentMarket", [anima, bonds, deployer, 250n, deployer]);
  const comms = await once("comms", "AgentComms", [anima, anima]);
  const meter = await once("meter", "InferenceMeter", [anima, 3 * DAY]);
  const handles = await once("handles", "AgentHandles", [anima, deployer]);
  const roles = await once("roles", "AnimaRoles", [anima]);

  // ---- the cast ------------------------------------------------------------
  // The protocol refuses a self-hire, so a believable scenario needs distinct parties. Keys are
  // written outside the repository and funded with just enough gas to act.
  console.log("\ncast");
  for (const role of ["client", "validator", "buyer"]) {
    if (rec.cast[role]) {
      console.log(`  ${role.padEnd(24)} ${rec.cast[role].address}  (reused)`);
      continue;
    }
    const pk = generatePrivateKey();
    const file = `${keyDir}/${role}.key`;
    writeFileSync(file, pk, { mode: 0o600 });
    rec.cast[role] = { address: getAddress(privateKeyToAccount(pk).address), keyFile: `${role}.key` };
    save();
    console.log(`  ${role.padEnd(24)} ${rec.cast[role].address}`);
  }

  for (const [role, who] of Object.entries(rec.cast)) {
    const bal = await publicClient.getBalance({ address: who.address });
    if (bal >= parseEther("0.0015")) continue;
    const hash = await wallet.sendTransaction({ to: who.address, value: parseEther("0.002") });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  funded ${role} with 0.002 ETH`);
  }

  // ---- wiring: the security-critical step ---------------------------------
  // A module allowlist entry grants the power to lock an agent and move its collateral. Nothing
  // goes in it that was not deployed above.
  console.log("\nwiring");
  const wire = async (label: string, fn: () => Promise<`0x${string}`>) => {
    if (rec.wiring.includes(label)) {
      console.log(`  ${label}  (already)`);
      return;
    }
    const hash = await fn();
    await publicClient.waitForTransactionReceipt({ hash });
    rec.wiring.push(label);
    save();
    console.log(`  ${label}`);
  };

  const token = await viem.getContractAt("AnimaAgent", anima);
  const vault = await viem.getContractAt("BondVault", bonds);
  const rep = await viem.getContractAt("ReputationRegistry", reputation);
  const val = await viem.getContractAt("ValidationRegistry", validation);

  await wire("anima.setModule(escrow)", () => token.write.setModule([escrow, true]));
  await wire("anima.setModule(market)", () => token.write.setModule([market, true]));
  await wire("anima.setModule(roles)", () => token.write.setModule([roles, true]));
  await wire("bonds.setModule(escrow)", () => vault.write.setModule([escrow, true]));
  await wire("bonds.setArbiter(escrow)", () => vault.write.setArbiter([escrow, true]));
  await wire("reputation.setSettlementModule(escrow)", () => rep.write.setSettlementModule([escrow, true]));
  await wire("validation.setValidator(validator)", () =>
    val.write.setValidator([rec.cast.validator.address, true])
  );

  // Seed the faucet token so the scenario can pay for things.
  const usdcContract = await viem.getContractAt("MockERC20", usdc);
  if (!rec.wiring.includes("mint aUSD")) {
    for (const who of [deployer, rec.cast.client.address, rec.cast.buyer.address]) {
      const hash = await usdcContract.write.mint([who, parseUnits("100000", 6)]);
      await publicClient.waitForTransactionReceipt({ hash });
    }
    rec.wiring.push("mint aUSD");
    save();
    console.log("  minted 100,000 aUSD to deployer, client, buyer");
  }

  const spent = Number(startingBalance - (await publicClient.getBalance({ address: deployer }))) / 1e18;
  console.log(`\ndeployed. ~${spent.toFixed(5)} ETH spent.`);
  const explorer: Record<number, string> = {
    84532: "https://sepolia.basescan.org",
    11155420: "https://sepolia-optimism.etherscan.io",
    421614: "https://sepolia.arbiscan.io",
    11155111: "https://sepolia.etherscan.io",
  };
  console.log(`token: ${explorer[chainId] ? `${explorer[chainId]}/address/${anima}` : anima}`);
  return rec;
}

await main();
