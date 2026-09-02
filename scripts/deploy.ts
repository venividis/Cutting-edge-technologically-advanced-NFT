/**
 * ANIMA deployment.
 *
 * Order matters: the token needs the account implementation and key registry to exist before it
 * can derive addresses, and the modules need the token before they can be allowlisted on it.
 * The final wiring step is the security-critical one — a module allowlist entry grants the power
 * to lock an agent and move its collateral, so nothing goes in it that was not deployed here.
 *
 *   npx hardhat run scripts/deploy.ts --network <name>
 */
import { network } from "hardhat";
import { zeroAddress, type Address } from "viem";

/** Canonical on every EVM chain, deployed through Nick's factory. */
const CANONICAL_ERC6551_REGISTRY = "0x000000006551c19487814612e58FE06813775758" as const;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

interface Config {
  name: string;
  symbol: string;
  /** ERC-20 used for bonds, escrow and metering. Native currency is deliberately unsupported. */
  settlementAsset: Address;
  /** ERC-4337 EntryPoint, or zero to disable the 4337 path. */
  entryPoint: Address;
  /** LayerZero V2 endpoint, or zero to skip the omnichain layer. */
  lzEndpoint: Address;
  royaltyReceiver: Address;
  royaltyBps: bigint;
  protocolTreasury: Address;
  /** Seconds collateral remains slashable after a withdrawal is requested. MUST exceed the
   *  longest dispute window of any module that reserves against the vault. */
  unbondingPeriod: number;
}

export async function deploy(config: Config) {
  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const owner = deployer.account.address;
  const log = (label: string, address: string) => console.log(`  ${label.padEnd(24)} ${address}`);

  console.log(`\ndeployer ${owner}\n`);

  // ---- Layer 1: core -------------------------------------------------------
  const registryCode = await (await viem.getPublicClient()).getCode({
    address: CANONICAL_ERC6551_REGISTRY,
  });
  const registry =
    registryCode && registryCode !== "0x"
      ? { address: CANONICAL_ERC6551_REGISTRY as Address }
      : await viem.deployContract("ERC6551Registry");
  log("ERC6551Registry", registry.address);

  const accountImpl = await viem.deployContract("AgentAccount", [config.entryPoint]);
  log("AgentAccount (impl)", accountImpl.address);

  const keyRegistry = await viem.deployContract("EncryptionKeyRegistry");
  log("EncryptionKeyRegistry", keyRegistry.address);

  // Start with the honest verifier. Swap in AttesterQuorumVerifier once an attester set and an
  // approved enclave measurement actually exist — claiming SealedTEE before then would be a lie.
  const verifier = await viem.deployContract("NullTransferVerifier");
  log("NullTransferVerifier", verifier.address);

  const anima = await viem.deployContract("AnimaAgent", [
    config.name,
    config.symbol,
    owner,
    registry.address,
    accountImpl.address,
    ZERO32,
    verifier.address,
    keyRegistry.address,
    config.royaltyReceiver,
    config.royaltyBps,
  ]);
  log("AnimaAgent", anima.address);

  // ---- Layer 2: accountability --------------------------------------------
  const bonds = await viem.deployContract("BondVault", [
    config.settlementAsset,
    anima.address,
    config.unbondingPeriod,
    owner,
  ]);
  log("BondVault", bonds.address);

  const reputation = await viem.deployContract("ReputationRegistry", [anima.address, owner]);
  log("ReputationRegistry", reputation.address);

  const validation = await viem.deployContract("ValidationRegistry", [anima.address, owner]);
  log("ValidationRegistry", validation.address);

  const escrow = await viem.deployContract("WorkEscrow", [
    config.settlementAsset,
    anima.address,
    bonds.address,
    reputation.address,
    validation.address,
    owner,
    100n, // 1%
    config.protocolTreasury,
  ]);
  log("WorkEscrow", escrow.address);

  // ---- Layer 3: markets ----------------------------------------------------
  const market = await viem.deployContract("AgentMarket", [
    anima.address,
    bonds.address,
    owner,
    250n, // 2.5%
    config.protocolTreasury,
  ]);
  log("AgentMarket", market.address);

  const launchpad = await viem.deployContract("AgentLaunchpad", [
    config.settlementAsset,
    anima.address,
    anima.address,
    owner,
    config.protocolTreasury,
    { protocolBps: 100, treasuryBps: 100, agentBps: 100 },
  ]);
  log("AgentLaunchpad", launchpad.address);

  const revenueRouter = await viem.deployContract("RevenueRouter", [
    config.settlementAsset,
    anima.address,
    anima.address,
    bonds.address,
  ]);
  log("RevenueRouter", revenueRouter.address);

  const swapRouter = await viem.deployContract("AgentSwapRouter", [anima.address, anima.address, owner]);
  log("AgentSwapRouter", swapRouter.address);

  // ---- Layer 4: reach ------------------------------------------------------
  const comms = await viem.deployContract("AgentComms", [anima.address, anima.address]);
  log("AgentComms", comms.address);

  const meter = await viem.deployContract("InferenceMeter", [anima.address, 3 * 86400]);
  log("InferenceMeter", meter.address);

  const bindings = await viem.deployContract("AnimaBindings");
  log("AnimaBindings", bindings.address);

  let omniHome: { address: Address } | undefined;
  if (config.lzEndpoint !== zeroAddress) {
    omniHome = await viem.deployContract("OmniAgentHome", [
      anima.address,
      config.lzEndpoint,
      owner,
      owner,
    ]);
    log("OmniAgentHome", omniHome.address);
  }

  // ---- Wiring --------------------------------------------------------------
  // Everything below grants real power. A module can lock an agent; an arbiter can take its
  // collateral. Nothing belongs here that was not deployed above.
  console.log("\nwiring:");
  await anima.write.setModule([escrow.address, true]);
  await anima.write.setModule([market.address, true]);
  await bonds.write.setModule([escrow.address, true]);
  await bonds.write.setArbiter([escrow.address, true]);
  await reputation.write.setSettlementModule([escrow.address, true]);
  console.log("  module allowlists set");

  console.log(`
Next steps, none of which are optional:

  1. Set an explicit LayerZero DVN + executor configuration on the endpoint. Leaving it on
     defaults delegates your bridge security to whoever the defaults name.
  2. Deploy OmniAgentMirror on each destination chain and setPeer in BOTH directions.
  3. Set a liquidity deployer on AgentLaunchpad before any launch can graduate.
  4. Transfer ownership of every contract to a multisig or timelock. Ownable2Step means the new
     owner must accept, so a typo cannot brick governance.
  5. Deploy AttesterQuorumVerifier and point AnimaAgent at it only once a real attester set and
     an approved enclave measurement exist.
`);

  return { anima, accountImpl, keyRegistry, verifier, bonds, reputation, validation, escrow, market, launchpad, revenueRouter, swapRouter, comms, meter, bindings, omniHome };
}

// Example: Base mainnet-shaped configuration. Replace before using.
if (process.env.ANIMA_DEPLOY === "1") {
  await deploy({
    name: "ANIMA Agents",
    symbol: "ANIMA",
    settlementAsset: (process.env.SETTLEMENT_ASSET ?? zeroAddress) as Address,
    entryPoint: (process.env.ENTRY_POINT ?? zeroAddress) as Address,
    lzEndpoint: (process.env.LZ_ENDPOINT ?? zeroAddress) as Address,
    royaltyReceiver: (process.env.ROYALTY_RECEIVER ?? zeroAddress) as Address,
    royaltyBps: 500n,
    protocolTreasury: (process.env.PROTOCOL_TREASURY ?? zeroAddress) as Address,
    unbondingPeriod: 7 * 86400,
  });
}
