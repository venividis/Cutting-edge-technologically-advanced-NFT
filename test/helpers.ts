import { network } from "hardhat";
import { keccak256, toHex, zeroAddress, encodeAbiParameters, parseAbiParameters } from "viem";

export const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ACCOUNT_SALT = ZERO32;
export const DAY = 86400n;

export const SealPolicy = {
  None: 0,
  Committed: 1,
  ReKeyed: 2,
  SealedTEE: 3,
  SealedZK: 4,
  Threshold: 5,
} as const;

export const AgentStatus = {
  Inactive: 0,
  Active: 1,
  Paused: 2,
  Disputed: 3,
  Retired: 4,
} as const;

export const JobState = {
  None: 0,
  Offered: 1,
  Active: 2,
  Delivered: 3,
  Disputed: 4,
  Settled: 5,
  Cancelled: 6,
} as const;

export function blankModel() {
  return { weightsRoot: ZERO32, runtimeMeasurement: ZERO32, attestationKind: 0, modelId: "" };
}

export function model(id: string, weights = "weights-v1") {
  return {
    weightsRoot: keccak256(toHex(weights)),
    runtimeMeasurement: ZERO32,
    attestationKind: 1,
    modelId: id,
  };
}

export function shard(description: string, content: string, kind = 1) {
  return {
    dataHash: keccak256(toHex(content)),
    keyCommitment: keccak256(toHex(`key:${content}`)),
    size: 1024n,
    kind,
    uri: `ipfs://${description}`,
    description,
  };
}

/**
 * Recomputes BrainLib's commitment off-chain. Tests assert the contract agrees, which is the
 * only way to catch a divergence between the on-chain root and what an indexer would derive.
 */
export function brainRoot(shards: ReturnType<typeof shard>[]) {
  const LEAF_TAG = keccak256(toHex("anima.BrainShard.v1"));
  const ROOT_TAG = keccak256(toHex("anima.BrainRoot.v1"));
  let root = keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [ROOT_TAG, BigInt(shards.length)])
  );
  for (const s of shards) {
    const leaf = keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, bytes32, bytes32, uint64, uint8, bytes32, bytes32"),
        [
          LEAF_TAG,
          s.dataHash,
          s.keyCommitment,
          s.size,
          s.kind,
          keccak256(toHex(s.uri)),
          keccak256(toHex(s.description)),
        ]
      )
    );
    root = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [root, leaf]));
  }
  return root;
}

export type Protocol = Awaited<ReturnType<typeof deployProtocol>>;

export async function deployProtocol(opts: { entryPoint?: `0x${string}` } = {}) {
  const connection = await network.create();
  const { viem, networkHelpers } = connection;
  const wallets = await viem.getWalletClients();
  const [deployer, alice, bob, carol, guardian, validator, treasury] = wallets;
  const publicClient = await viem.getPublicClient();

  const registry = await viem.deployContract("ERC6551Registry");
  const accountImpl = await viem.deployContract("AgentAccount", [opts.entryPoint ?? zeroAddress]);
  const keyRegistry = await viem.deployContract("EncryptionKeyRegistry");
  const nullVerifier = await viem.deployContract("NullTransferVerifier");

  const anima = await viem.deployContract("AnimaAgent", [
    "ANIMA Agents",
    "ANIMA",
    deployer.account.address,
    registry.address,
    accountImpl.address,
    ACCOUNT_SALT,
    nullVerifier.address,
    keyRegistry.address,
    treasury.account.address,
    500n, // 5% declared royalty
  ]);

  const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);

  const bonds = await viem.deployContract("BondVault", [
    usdc.address,
    anima.address,
    Number(7n * DAY),
    deployer.account.address,
  ]);
  const reputation = await viem.deployContract("ReputationRegistry", [anima.address, deployer.account.address]);
  const validation = await viem.deployContract("ValidationRegistry", [anima.address, deployer.account.address]);

  const escrow = await viem.deployContract("WorkEscrow", [
    usdc.address,
    anima.address,
    bonds.address,
    reputation.address,
    validation.address,
    deployer.account.address,
    100n, // 1% protocol fee
    treasury.account.address,
  ]);

  const market = await viem.deployContract("AgentMarket", [
    anima.address,
    bonds.address,
    deployer.account.address,
    250n, // 2.5%
    treasury.account.address,
  ]);

  const comms = await viem.deployContract("AgentComms", [anima.address, anima.address]);
  const meter = await viem.deployContract("InferenceMeter", [anima.address, Number(3n * DAY)]);
  const swapRouter = await viem.deployContract("AgentSwapRouter", [
    anima.address,
    anima.address,
    deployer.account.address,
  ]);

  // Wire the module allowlists. Everything that can lock an agent or move its collateral is
  // registered explicitly; nothing is open-ended.
  await anima.write.setModule([escrow.address, true]);
  await anima.write.setModule([market.address, true]);
  await bonds.write.setModule([escrow.address, true]);
  await bonds.write.setArbiter([escrow.address, true]);
  await reputation.write.setSettlementModule([escrow.address, true]);
  // A job that can slash requires a validator the registry already recognises: a freshly
  // generated key is indistinguishable on-chain from an independent referee.
  await validation.write.setValidator([validator.account.address, true]);

  return {
    connection,
    viem,
    networkHelpers,
    publicClient,
    wallets,
    deployer,
    alice,
    bob,
    carol,
    guardian,
    validator,
    treasury,
    registry,
    accountImpl,
    keyRegistry,
    nullVerifier,
    anima,
    usdc,
    bonds,
    reputation,
    validation,
    escrow,
    market,
    comms,
    meter,
    swapRouter,
  };
}

/** Mint an agent owned by `owner`, returning its id. */
export async function mintAgent(
  p: Protocol,
  owner: `0x${string}`,
  opts: {
    uri?: string;
    manifest?: string;
    shards?: ReturnType<typeof shard>[];
    seal?: number;
    modelId?: string;
  } = {}
) {
  const uri = opts.uri ?? "https://agents.example/1.json";
  const manifestHash = opts.manifest ? keccak256(toHex(opts.manifest)) : ZERO32;
  const shards = opts.shards ?? [];
  const hash = await p.anima.write.mintAgent([
    owner,
    uri,
    manifestHash,
    opts.modelId ? model(opts.modelId) : blankModel(),
    shards,
    opts.seal ?? SealPolicy.None,
    [],
  ]);
  await p.publicClient.waitForTransactionReceipt({ hash });
  return await p.anima.read.totalMinted();
}

export async function expectRevert(promise: Promise<unknown>, fragment?: string) {
  try {
    await promise;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (fragment && !msg.includes(fragment)) {
      throw new Error(`expected revert containing "${fragment}", got:\n${msg}`);
    }
    return msg;
  }
  throw new Error(`expected revert${fragment ? ` containing "${fragment}"` : ""}, but call succeeded`);
}
