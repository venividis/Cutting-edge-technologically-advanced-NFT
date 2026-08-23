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
  toFunctionSelector,
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
 * Canonicalise a manifest as RFC 8785 (JSON Canonicalization Scheme) and serialise it.
 *
 * The on-chain commitment is over the *bytes actually served*, so canonicalisation has to be
 * agreed rather than assumed. JCS is the right choice and not an arbitrary one: A2A's
 * `AgentCardSignature` scheme specifies exactly this — drop default-valued properties, exclude
 * `signatures`, canonicalise with RFC 8785, then JWS-sign. Since an ANIMA manifest is a superset
 * of an AgentCard, using the same scheme makes `keccak256(serialiseManifest(m))` byte-identical
 * to the payload an A2A signature already covers. One document, one canonical form, two
 * independent proofs of it.
 *
 * MCP's `server/discover`, ERC-8004 registration files and DID documents define no
 * canonicalisation at all, so for those the commitment is ambiguous unless you pick one. Pick
 * this one.
 *
 * Publish the output of this function verbatim. A re-formatted copy — a pretty-printer, a proxy
 * that re-serialises, a CMS that reorders keys — will fail `verifyManifest` against its own
 * document.
 */
export function serialiseManifest(manifest: AgentManifest): string {
  return canonicalise(manifest);
}

export function manifestHash(manifest: AgentManifest): Hex {
  return keccak256(toHex(serialiseManifest(manifest)));
}

/**
 * RFC 8785 canonical JSON.
 *
 * ECMAScript's `JSON.stringify` already produces JCS-conformant output for object and string
 * serialisation, and `Array.prototype.sort()` already orders by UTF-16 code unit, which is the
 * ordering JCS mandates. The two places it can silently diverge are guarded explicitly rather
 * than hoped about: non-finite numbers (which `JSON.stringify` turns into `null`, quietly
 * changing the document) and lone surrogates (which have no canonical encoding). Both throw.
 */
export function canonicalise(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalise);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`RFC 8785 has no encoding for ${value}; JSON.stringify would silently emit null`);
    }
    return value;
  }

  if (typeof value === "string") {
    assertWellFormed(value);
    return value;
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Default sort is by UTF-16 code unit, which is exactly what JCS specifies.
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue; // A2A: default-valued properties are dropped
      assertWellFormed(key);
      out[key] = normalise(source[key]);
    }
    return out;
  }

  return value;
}

function assertWellFormed(s: string): void {
  // A lone surrogate has no well-defined UTF-8 encoding, so the bytes a server serves and the
  // bytes a verifier hashes can differ. Refuse rather than produce an unverifiable commitment.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("unpaired high surrogate in manifest string");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("unpaired low surrogate in manifest string");
    }
  }
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

/* -------------------------------------------------------------------------- */
/*                            EIP-2535 diamond cuts                           */
/* -------------------------------------------------------------------------- */

/**
 * `keccak256("diamondCut((address,uint8,bytes4[])[],address,bytes)")[0..4]`. If a diamond routes
 * this selector, it is mutable — whatever else its documentation says.
 */
export const DIAMOND_CUT_SELECTOR: Hex = "0x1f931c1c";

/** ERC-165 id for `IDiamondLoupe`. */
export const DIAMOND_LOUPE_INTERFACE_ID: Hex = "0x48e2b093";

/** One entry of an EIP-2535 cut. Only `Add` (0) is meaningful for an immutable diamond. */
export interface FacetCut {
  facetAddress: Address;
  action: 0;
  functionSelectors: Hex[];
}

/** A compiled, deployed facet: its address and the ABI it was compiled from. */
export interface FacetSource {
  name: string;
  address: Address;
  abi: readonly { type: string }[];
}

function selectorsOf(abi: readonly { type: string }[]): Hex[] {
  return abi
    .filter((entry) => entry.type === "function")
    .map((entry) => toFunctionSelector(entry as never) as Hex);
}

/**
 * Derives the EIP-2535 cut for an immutable diamond from the ABI it must present.
 *
 * Hand-written selector lists are the standing hazard of this pattern: a diamond is deployed,
 * the cut is welded shut, and only later does someone notice a function nobody routed. So the
 * cut is computed instead — `tokenAbi` is the specification, and the facets partition it.
 *
 * Facets that inherit a shared base all carry the shared surface in their ABI, so every selector
 * appears more than once and the split has to be decided rather than read off. The rule is:
 * `specialised` facets claim the selectors they add over `base`, and `base` serves the whole
 * remainder of `tokenAbi`. `additional` facets — the loupe, typically — contribute functions the
 * token itself does not declare and are added wholesale.
 *
 * Throws rather than returning a partial cut, on any of: a `tokenAbi` function no facet can
 * serve, a facet claiming a function `tokenAbi` does not declare, or two facets claiming one
 * selector. Each of those, silently accepted, is a permanently wrong diamond.
 */
export function deriveFacetCut(options: {
  tokenAbi: readonly { type: string }[];
  base: FacetSource;
  specialised: FacetSource[];
  additional?: FacetSource[];
}): FacetCut[] {
  const { tokenAbi, base, specialised, additional = [] } = options;

  const baseSelectors = new Set(selectorsOf(base.abi));
  const token = selectorsOf(tokenAbi);
  const tokenSet = new Set(token);

  const claimedBy = new Map<Hex, string>();
  const cuts: FacetCut[] = [];

  for (const facet of specialised) {
    const claims = selectorsOf(facet.abi).filter((s) => !baseSelectors.has(s));
    for (const selector of claims) {
      const other = claimedBy.get(selector);
      if (other) throw new Error(`${selector} is claimed by both ${other} and ${facet.name}`);
      if (!tokenSet.has(selector)) {
        throw new Error(`${facet.name} routes ${selector}, which the token ABI does not declare`);
      }
      claimedBy.set(selector, facet.name);
    }
    if (claims.length === 0) throw new Error(`${facet.name} adds nothing over ${base.name}`);
    cuts.push({ facetAddress: facet.address, action: 0, functionSelectors: claims });
  }

  const remainder = token.filter((s) => !claimedBy.has(s));
  const unservable = remainder.filter((s) => !baseSelectors.has(s));
  if (unservable.length) {
    throw new Error(`${base.name} cannot serve ${unservable.join(", ")} — the diamond would be incomplete`);
  }
  cuts.unshift({ facetAddress: base.address, action: 0, functionSelectors: remainder });

  for (const facet of additional) {
    const claims = selectorsOf(facet.abi);
    for (const selector of claims) {
      if (tokenSet.has(selector) || claimedBy.has(selector)) {
        throw new Error(`${facet.name} collides with the token ABI at ${selector}`);
      }
      claimedBy.set(selector, facet.name);
    }
    cuts.push({ facetAddress: facet.address, action: 0, functionSelectors: claims });
  }

  return cuts;
}

/**
 * True when `cut` routes no `diamondCut`. Necessary for immutability, and not sufficient — also
 * confirm each facet's deployed bytecode, since a facet could hold one under another selector.
 */
export function cutIsImmutable(cut: FacetCut[]): boolean {
  return !cut.some((entry) => entry.functionSelectors.includes(DIAMOND_CUT_SELECTOR));
}

/* -------------------------------------------------------------------------- */
/*                          LayerZero V2 executor options                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds the Type-3 executor options a LayerZero V2 `send` needs.
 *
 * These are not optional in practice. `MockLZEndpoint` ignores options entirely, so a test suite
 * built on it will happily pass `0x` — and then the real endpoint rejects the send, or accepts it
 * and the executor never delivers because it was told nothing about how much gas `lzReceive`
 * needs on the far side. This is the single most common way a bridge that "works in tests" fails
 * on a live chain.
 *
 * Layout, from `OptionsBuilder` and `ExecutorOptions` in LayerZero's own libraries:
 *
 *     0x0003                  TYPE_3
 *     01                      WORKER_ID (executor)
 *     <uint16>                length of what follows, including the option-type byte
 *     01                      OPTION_TYPE_LZRECEIVE
 *     <uint128 gas>           gas for lzReceive on the destination
 *     <uint128 value>         native drop, appended only when non-zero
 *
 * `sdk/../test/Omni.test.ts` asserts these bytes equal what the Solidity builder produces, so the
 * two cannot drift.
 *
 * @param gas Gas the destination's `lzReceive` may consume. An ANIMA agent arrival writes a
 *        snapshot and mints a replica; 300,000 is a sane starting point, and quoting will tell
 *        you if it is short.
 * @param value Native currency to drop on the destination, usually zero.
 */
export function lzReceiveOptions(gas: bigint, value = 0n): Hex {
  const u128 = (n: bigint) => n.toString(16).padStart(32, "0");
  const option = value === 0n ? u128(gas) : u128(gas) + u128(value);
  const lengthWithType = (option.length / 2 + 1).toString(16).padStart(4, "0");
  return `0x0003${"01"}${lengthWithType}${"01"}${option}` as Hex;
}
