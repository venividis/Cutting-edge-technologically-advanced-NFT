/**
 * ANIMA SDK — typed helpers for building and verifying the off-chain half of an agent.
 *
 * The contracts commit to things that live off-chain: a manifest, a shard set, a batch of
 * inference receipts, an audit log. Every one of those commitments is only worth something if a
 * client actually recomputes it, and the recomputation has to match the Solidity byte for byte.
 * That is what this module is for — it is not a convenience wrapper around `viem`, it is the
 * reference implementation of the hashing rules.
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";

/* -------------------------------------------------------------------------- */
/*                                    types                                   */
/* -------------------------------------------------------------------------- */

export enum SealPolicy {
  None = 0,
  Committed = 1,
  ReKeyed = 2,
  SealedTEE = 3,
  SealedZK = 4,
  Threshold = 5,
}

export enum AgentStatus {
  Inactive = 0,
  Active = 1,
  Paused = 2,
  Disputed = 3,
  Retired = 4,
}

export enum ShardKind {
  Weights = 0,
  Memory = 1,
  SystemPrompt = 2,
  Tools = 3,
  Keys = 4,
  Dataset = 5,
  Checkpoint = 6,
}

export interface BrainShard {
  dataHash: Hex;
  keyCommitment: Hex;
  size: bigint;
  kind: number;
  uri: string;
  description: string;
}

export interface InferenceReceipt {
  requestHash: Hex;
  responseHash: Hex;
  modelHash: Hex;
  units: bigint;
  attestationKind: number;
  attestation: Hex;
}

/* -------------------------------------------------------------------------- */
/*                              agent manifest                                */
/* -------------------------------------------------------------------------- */

/**
 * The document an agent serves at its `agentURI`. A superset of an A2A AgentCard: it keeps the
 * fields an A2A client expects and adds what an on-chain agent additionally needs to declare.
 */
export interface AgentManifest {
  /** A2A-compatible core. */
  name: string;
  description: string;
  version: string;
  url?: string;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean };
  skills?: Array<{ id: string; name: string; description: string; tags?: string[] }>;

  /** ANIMA additions. */
  anima: {
    /** `eip155:<chainId>:<contract>` — the agent's home registry. */
    registry: string;
    agentId: string;
    /** MCP servers this agent exposes, so a client can discover its tools. */
    mcp?: Array<{ name: string; url: string; transport: "http" | "sse" | "stdio" }>;
    /** What it charges, and in what. Mirrors the on-chain metering configuration. */
    pricing?: { unit: string; amount: string; token: Address; meter?: Address };
    /** Declared model, matching the on-chain ModelIdentity. */
    model?: { modelId: string; weightsRoot: Hex; attestationKind: number };

    /**
     * Peer-to-peer mesh presence. A Sovereign Agent Mesh control plane binds a libp2p peer id
     * to an OIDC subject; publishing the same peer id here, and attesting it in
     * {@link AgentHandles} as `HandleKind.MeshPeer`, gives a second and permissionless way to
     * check it — the mesh can trust the chain instead of an identity provider.
     */
    mesh?: { network: "sam" | "libp2p" | string; peerId: string; bootstrap?: string[] };

    /**
     * Off-chain identities this agent claims, each of which SHOULD have a corresponding
     * attestation in the on-chain handle registry. An inbox is the load-bearing one: most of
     * the web gates signup on receiving a code at an address.
     */
    handles?: Array<{ kind: HandleKindName; value: string; registry?: Address }>;

    /** Derivatives the agent is permitted to trade, mirroring its on-chain desk limits. */
    markets?: Array<{ market: string; venue: Address; maxLeverageX100: number }>;
  };
}

export type HandleKindName =
  | "email"
  | "domain"
  | "did"
  | "ens"
  | "social"
  | "meshPeer"
  | "phone"
  | "apiKeyId";

/** Matches `AgentHandles.HandleKind`. */
export const HandleKind: Record<HandleKindName, number> = {
  email: 0,
  domain: 1,
  did: 2,
  ens: 3,
  social: 4,
  meshPeer: 5,
  phone: 6,
  apiKeyId: 7,
};

/**
 * Reproduces `AgentHandles.handleKey`.
 *
 * Normalise before calling: lowercase, punycode-decoded, no display name. The registry hashes
 * the string verbatim, so two spellings of the same address are two different handles and the
 * one-agent-per-handle guarantee would not bind.
 */
export function handleKey(kind: HandleKindName, value: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint8, string"), [HandleKind[kind], value]));
}

/**
 * Canonicalise a manifest and hash it exactly as `AnimaAgent.verifyManifest` will.
 *
 * The commitment is over the *bytes actually served*, so canonicalisation has to be agreed
 * rather than assumed. This uses JSON with sorted keys and no insignificant whitespace; publish
 * the output of {@link serialiseManifest}, not a re-formatted copy of it, or your own
 * `verifyManifest` will fail against your own document.
 */
export function serialiseManifest(manifest: AgentManifest): string {
  return JSON.stringify(sortKeys(manifest));
}

export function manifestHash(manifest: AgentManifest): Hex {
  return keccak256(toHex(serialiseManifest(manifest)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*                            brain commitments                               */
/* -------------------------------------------------------------------------- */

const LEAF_TAG = keccak256(toHex("anima.BrainShard.v1"));
const ROOT_TAG = keccak256(toHex("anima.BrainRoot.v1"));

/** Mirrors `BrainLib.leafOf`. */
export function shardLeaf(shard: BrainShard): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, bytes32, uint64, uint8, bytes32, bytes32"),
      [
        LEAF_TAG,
        shard.dataHash,
        shard.keyCommitment,
        shard.size,
        shard.kind,
        keccak256(toHex(shard.uri)),
        keccak256(toHex(shard.description)),
      ]
    )
  );
}

/**
 * Mirrors `BrainLib.rootOf` — an ordered hash chain, not a Merkle tree.
 *
 * Order is significant: reordering shards is a state change and produces a different root. Shard
 * index is part of an agent's addressing scheme, so this is deliberate.
 */
export function brainRoot(shards: BrainShard[]): Hex {
  let root = keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [ROOT_TAG, BigInt(shards.length)])
  );
  for (const shard of shards) {
    root = keccak256(
      encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [root, shardLeaf(shard)])
    );
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/*                             inference receipts                             */
/* -------------------------------------------------------------------------- */

const RECEIPT_TUPLE =
  "(bytes32 requestHash, bytes32 responseHash, bytes32 modelHash, uint64 units, uint8 attestationKind, bytes32 attestation)[]";

/** Mirrors `InferenceMeter.workRootOf`. This is what the payer's voucher commits to. */
export function workRoot(receipts: InferenceReceipt[]): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters(RECEIPT_TUPLE), [receipts]));
}

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "uint256" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "workRoot", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function voucherDomain(meter: Address, chainId: number) {
  return { name: "AnimaInferenceMeter", version: "1", chainId, verifyingContract: meter } as const;
}

/* -------------------------------------------------------------------------- */
/*                              marketplace orders                            */
/* -------------------------------------------------------------------------- */

export const ORDER_TYPES = {
  Order: [
    { name: "kind", type: "uint8" },
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "payToken", type: "address" },
    { name: "price", type: "uint256" },
    { name: "start", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "duration", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "makerEpoch", type: "uint256" },
    { name: "expectedAccountState", type: "uint256" },
    { name: "expectedBrainRoot", type: "bytes32" },
    { name: "expectedBrainEpoch", type: "uint64" },
    { name: "minBondCoverage", type: "uint256" },
  ],
} as const;

export function orderDomain(market: Address, chainId: number) {
  return { name: "AnimaMarket", version: "1", chainId, verifyingContract: market } as const;
}

/** Sentinel meaning "do not check the bound account's state". */
export const SKIP_STATE_CHECK = (1n << 256n) - 1n;

/* -------------------------------------------------------------------------- */
/*                                audit log                                   */
/* -------------------------------------------------------------------------- */

export interface AuditEntry {
  signer: Address;
  to: Address;
  value: bigint;
  selector: Hex;
  dataHash: Hex;
  operation: number;
  state: bigint;
  timestamp: bigint;
}

/**
 * Replay an agent account's `AuditEntry` log and derive the root it should end at.
 *
 * This is the check that makes a second-hand agent's history worth anything: a seller hands you
 * the log, you recompute, and if it does not end at the on-chain `auditRoot()` then entries were
 * pruned, spliced, or reordered. Pass entries in ascending block/log order.
 */
export function replayAuditLog(
  account: Address,
  chainId: bigint,
  entries: AuditEntry[],
  from: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000"
): Hex {
  let root = from;
  for (const e of entries) {
    root = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "bytes32, uint256, address, address, address, uint256, bytes4, bytes32, uint8, uint256, uint256"
        ),
        [root, chainId, account, e.signer, e.to, e.value, e.selector, e.dataHash, e.operation, e.state, e.timestamp]
      )
    );
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/*                                  policy                                    */
/* -------------------------------------------------------------------------- */

export interface AutonomyPolicy {
  perTxWei: bigint;
  dailyWei: bigint;
  expiry: bigint;
  allowDelegateCall: boolean;
  allowUnlistedTargets: boolean;
  targetsRoot: Hex;
}

/**
 * The safe default: the agent may call allowlisted targets only, may not delegatecall, and may
 * not move native value at all. Widen deliberately from here rather than narrowing from open.
 */
export function lockedDownPolicy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    perTxWei: 0n,
    dailyWei: 0n,
    expiry: 0n,
    allowDelegateCall: false,
    allowUnlistedTargets: false,
    targetsRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

/** Leaf for the policy's merkle target allowlist, double-hashed per OpenZeppelin convention. */
export function targetLeaf(target: Address, selector: Hex): Hex {
  return keccak256(
    keccak256(encodeAbiParameters(parseAbiParameters("address, bytes4"), [target, selector]))
  );
}
