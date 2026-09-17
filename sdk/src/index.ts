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
  getAddress,
  keccak256,
  parseAbiParameters,
  sha256,
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

export interface PrivateEnvelopeContext {
  chainId: bigint;
  comms: Address;
  sender: Address;
  recipientAgentId: bigint;
  recipientKeyId: Hex;
  /** A fresh, cryptographically random 32-byte value for every encryption. */
  nonce: Hex;
}

/* -------------------------------------------------------------------------- */
/*                              agent manifest                                */
/* -------------------------------------------------------------------------- */

/**
 * The ERC-8004 registration-v1 document an agent serves at its `agentURI`. `anima` carries the
 * additional on-chain declarations. This is not itself an A2A Agent Card; an A2A provider
 * advertises the versioned card as one entry in `services`.
 */
export interface AgentManifest {
  /** ERC-8004 registration document discriminator. */
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  /** Optional URL of the stricter ANIMA JSON Schema used to validate this document. */
  $schema?: string;
  /** ERC-721 compatible presentation fields. */
  name: string;
  description: string;
  image: string;
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistration[];
  supportedTrust?: Array<"reputation" | "crypto-economic" | "tee-attestation" | string>;

  /** ANIMA additions. */
  anima: {
    /** `eip155:<chainId>:<contract>` — the agent's home registry. */
    registry: string;
    agentId: string;
    /** MCP servers this agent exposes, so a client can discover its tools. */
    mcp?: Array<{
      name: string;
      url: string;
      /** MCP standard transports. `sse` is retained only for legacy servers. */
      transport: "streamable-http" | "stdio" | "sse";
    }>;
    /** What it charges, and in what. Mirrors the on-chain metering configuration. */
    pricing?: { unit: string; amount: string; token: Address; meter?: Address };
    /** Declared model, matching the on-chain ModelIdentity. */
    model?: { modelId: string; weightsRoot: Hex; attestationKind: number };
    /** Human-facing, independently recoverable interface for this agent. */
    gui?: AgentGui;

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

    /** Immutable, permission-declaring packages selected for this agent. */
    extensions?: Array<{
      releaseId: Hex;
      registry?: Address;
      required?: boolean;
    }>;
  };
}

export interface AgentRegistration {
  agentId: number;
  /** `{namespace}:{chainId}:{identityRegistry}`, for example `eip155:84532:0x…`. */
  agentRegistry: string;
}

export interface AgentService {
  /** Standard names include `web`, `A2A`, `MCP`, `OASF`, `ENS`, `DID`, and `email`. */
  name: string;
  endpoint: string;
  version?: string;
  /** OASF services may include taxonomy identifiers directly in their service descriptor. */
  skills?: number[];
  domains?: number[];
}

export interface VerifyManifestOptions {
  expectedRegistry?: string;
  expectedAgentId?: string | number | bigint;
}

export interface FetchManifestOptions extends VerifyManifestOptions {
  /** Defaults to 1 MiB. Applied while streaming, not after an unbounded allocation. */
  maxBytes?: number;
  /** Defaults to ten seconds. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface VerifiedManifest {
  manifest: AgentManifest;
  bytes: Uint8Array;
  hash: Hex;
}

export const EXTENSION_SCHEMA = "anima.extension-release/1" as const;
export const EXTENSION_HOST_API = "anima.host/1" as const;
export const EXTENSION_CAPABILITIES = [
  "identity.read",
  "journal.propose",
  "state.read",
  "state.write",
  "transaction.propose",
] as const;

export type ExtensionCapability = typeof EXTENSION_CAPABILITIES[number];

export interface ExtensionManifest {
  schema: typeof EXTENSION_SCHEMA;
  name: string;
  version: number;
  publisher: Address;
  format: "files" | "html";
  archive: {
    compression: "raw" | "gzip";
    storedHash: Hex;
    storedBytes: number;
    expandedHash: Hex;
    expandedBytes: number;
  };
  entrypoint: string;
  hostAPI: typeof EXTENSION_HOST_API;
  dependencies: Hex[];
  capabilities: ExtensionCapability[];
  stateSchema: Hex;
  predecessor: Hex;
  resources?: { maxRuntimeMs: number; maxStateBytes: number };
  provenance?: { sourceHash: Hex; buildHash: Hex };
}

export interface AgentGui {
  /** Ordinary HTTPS route that works in mainstream browsers. */
  canonical: string;
  /** Immutable GUI bundle, normally an `ipfs://` or `ar://` URI. */
  contentUri: string;
  /** File to load within the bundle. */
  entrypoint: string;
  /** GUI protocol/release version understood by the client. */
  version: string;
  /** Optional declarative console modules; never executable manifest code. */
  modules?: string[];
}

/** Globally unambiguous browser route for an agent. */
export function agentWebUrl(origin: string, chainId: number | bigint, contract: Address, agentId: string | bigint) {
  const base = new URL(origin);
  if (base.protocol !== "https:") throw new Error("agent GUI origin must use https");
  if (base.username || base.password || base.search || base.hash) throw new Error("agent GUI origin must not contain credentials, a query or a fragment");
  const chain = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (chain <= 0n) throw new Error("chainId must be a positive integer");
  const id = agentId.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(id)) throw new Error("agentId must be a non-negative integer");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${chain}/${getAddress(contract).toLowerCase()}/${id}`;
  return base.toString();
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
 * agreed rather than assumed. ANIMA uses JCS so independently implemented clients can reproduce
 * a single byte representation. This choice does not make the document an A2A Agent Card or an
 * MCP protocol message; those protocols retain their own versioned schemas and handshakes.
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
 * Hash first, parse second, then bind the registration back to the identity requested by the
 * caller. This order prevents an attacker-controlled manifest from consuming parser work before
 * its on-chain commitment has been checked.
 */
export function verifyManifestBytes(
  bytes: Uint8Array,
  expectedHash: Hex,
  options: VerifyManifestOptions = {},
): VerifiedManifest {
  const hash = keccak256(bytes);
  if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("manifest hash mismatch");

  let manifest: AgentManifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as AgentManifest;
  } catch {
    throw new Error("manifest is not valid UTF-8 JSON");
  }
  if (manifest === null || typeof manifest !== "object" ||
      manifest.type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") {
    throw new Error("manifest is not an ERC-8004 registration-v1 document");
  }
  if (!Array.isArray(manifest.registrations) || manifest.registrations.length === 0) {
    throw new Error("manifest has no registrations");
  }
  if (options.expectedRegistry !== undefined || options.expectedAgentId !== undefined) {
    const registry = options.expectedRegistry?.toLowerCase();
    const id = options.expectedAgentId?.toString();
    const matches = manifest.registrations.some((entry) => {
      if (entry === null || typeof entry !== "object" || typeof entry.agentRegistry !== "string" ||
          !Number.isSafeInteger(entry.agentId) || entry.agentId < 0) return false;
      return (registry === undefined || entry.agentRegistry.toLowerCase() === registry) &&
        (id === undefined || String(entry.agentId) === id);
    });
    if (!matches) throw new Error("manifest does not register the requested on-chain agent");
  }
  return { manifest, bytes, hash };
}

/** Fetches a committed HTTPS manifest with finite time and memory before verifying it. */
export async function fetchVerifiedManifest(
  uri: string,
  expectedHash: Hex,
  options: FetchManifestOptions = {},
): Promise<VerifiedManifest> {
  const url = new URL(uri);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("manifest fetch requires an HTTPS URL without credentials");
  }
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("manifest exceeds maxBytes");
    if (!response.body) throw new Error("manifest response has no body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("manifest exceeds maxBytes");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return verifyManifestBytes(bytes, expectedHash, options);
  } finally {
    clearTimeout(timer);
  }
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
      if (source[key] === undefined) continue; // JSON objects cannot represent undefined
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
/*                         immutable extension packages                       */
/* -------------------------------------------------------------------------- */

const LOWER_HASH = /^0x[0-9a-f]{64}$/;
const LOWER_ADDRESS = /^0x[0-9a-f]{40}$/;
const EXTENSION_LIMITS = {
  manifestBytes: 16_384,
  storedBytes: 11_776_000,
  expandedBytes: 16_777_216,
  dependencies: 16,
  graphReleases: 64,
  graphDepth: 16,
  stateBytes: 32_768,
} as const;

/**
 * Validate the portable immutable-package profile adopted from MASTER-NFT-PROJECT.
 * Validation grants no wallet permission and does not execute or fetch package bytes.
 */
export function validateExtensionManifest(manifest: ExtensionManifest): ExtensionManifest {
  if (manifest === null || typeof manifest !== "object" || manifest.schema !== EXTENSION_SCHEMA ||
      manifest.hostAPI !== EXTENSION_HOST_API) throw new Error("unsupported extension schema or host API");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.name) ||
      !LOWER_ADDRESS.test(manifest.publisher) || /^0x0+$/.test(manifest.publisher)) {
    throw new Error("invalid extension publisher or name");
  }
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1 || manifest.version > 0xffffffff) {
    throw new Error("invalid extension version");
  }
  if (manifest.format !== "files" && manifest.format !== "html") throw new Error("unsupported extension format");
  if (!isSafeExtensionPath(manifest.entrypoint)) throw new Error("unsafe extension entrypoint");

  const archive = manifest.archive;
  if (!archive || (archive.compression !== "raw" && archive.compression !== "gzip") ||
      !LOWER_HASH.test(archive.storedHash) || !LOWER_HASH.test(archive.expandedHash) ||
      !safeBound(archive.storedBytes, 1, EXTENSION_LIMITS.storedBytes) ||
      !safeBound(archive.expandedBytes, 1, EXTENSION_LIMITS.expandedBytes)) {
    throw new Error("invalid extension archive");
  }
  if (archive.compression === "raw" &&
      (archive.storedHash !== archive.expandedHash || archive.storedBytes !== archive.expandedBytes)) {
    throw new Error("raw extension archive descriptors differ");
  }
  assertSortedUnique(manifest.dependencies, EXTENSION_LIMITS.dependencies, (value) => LOWER_HASH.test(value), "dependencies");
  assertSortedUnique(
    manifest.capabilities,
    EXTENSION_CAPABILITIES.length,
    (value) => (EXTENSION_CAPABILITIES as readonly string[]).includes(value),
    "capabilities",
  );
  if (!LOWER_HASH.test(manifest.stateSchema) || !LOWER_HASH.test(manifest.predecessor)) {
    throw new Error("invalid extension state or predecessor hash");
  }
  if (manifest.capabilities.some((capability) => capability.startsWith("state.")) &&
      /^0x0+$/.test(manifest.stateSchema)) throw new Error("state capability requires a state schema");
  if (manifest.resources &&
      (!safeBound(manifest.resources.maxRuntimeMs, 1_000, 300_000) ||
       !safeBound(manifest.resources.maxStateBytes, 0, EXTENSION_LIMITS.stateBytes))) {
    throw new Error("invalid extension resource budget");
  }
  if (manifest.provenance &&
      (!LOWER_HASH.test(manifest.provenance.sourceHash) || !LOWER_HASH.test(manifest.provenance.buildHash))) {
    throw new Error("invalid extension provenance");
  }
  if (new TextEncoder().encode(canonicalise(manifest)).length > EXTENSION_LIMITS.manifestBytes) {
    throw new Error("extension manifest too large");
  }
  return manifest;
}

export function serialiseExtensionManifest(manifest: ExtensionManifest): string {
  validateExtensionManifest(manifest);
  return canonicalise(manifest);
}

/** SHA-256 is retained for byte compatibility with the MASTER portable package format. */
export function extensionManifestHash(manifest: ExtensionManifest): Hex {
  return sha256(toHex(serialiseExtensionManifest(manifest)));
}

/** Resolve an exact, bounded dependency DAG without fetching or executing arbitrary code. */
export async function resolveExtensionGraph(
  roots: Hex[],
  read: (id: Hex) => Promise<ExtensionManifest>,
  options: { maxReleases?: number; maxDepth?: number } = {},
): Promise<ExtensionManifest[]> {
  const maxReleases = options.maxReleases ?? EXTENSION_LIMITS.graphReleases;
  const maxDepth = options.maxDepth ?? EXTENSION_LIMITS.graphDepth;
  if (!safeBound(maxReleases, 1, EXTENSION_LIMITS.graphReleases) ||
      !safeBound(maxDepth, 1, EXTENSION_LIMITS.graphDepth) || roots.length === 0 || roots.length > maxReleases) {
    throw new Error("invalid extension graph bounds");
  }
  const visiting = new Set<Hex>();
  const complete = new Map<Hex, ExtensionManifest>();
  const ordered: ExtensionManifest[] = [];
  const visit = async (id: Hex, depth: number): Promise<void> => {
    if (!LOWER_HASH.test(id)) throw new Error("invalid extension release id");
    if (visiting.has(id)) throw new Error("cyclic extension dependencies");
    if (complete.has(id)) return;
    if (depth > maxDepth || visiting.size + complete.size >= maxReleases) throw new Error("extension graph budget exceeded");
    visiting.add(id);
    const manifest = validateExtensionManifest(await read(id));
    if (extensionManifestHash(manifest) !== id) throw new Error("extension release hash mismatch");
    for (const dependency of manifest.dependencies) await visit(dependency, depth + 1);
    visiting.delete(id);
    complete.set(id, manifest);
    ordered.push(manifest);
  };
  for (const root of roots) await visit(root, 1);
  return ordered;
}

function isSafeExtensionPath(value: string): boolean {
  return typeof value === "string" && value.length <= 240 && !value.includes("..") &&
    value.split("/").every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && part !== "." && part !== "..");
}

function safeBound(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function assertSortedUnique<T>(values: T[], max: number, valid: (value: T) => boolean, label: string): void {
  if (!Array.isArray(values) || values.length > max) throw new Error(`invalid extension ${label}`);
  for (let i = 0; i < values.length; i++) {
    if (!valid(values[i]) || (i > 0 && String(values[i - 1]) >= String(values[i]))) {
      throw new Error(`unsorted, duplicate, or invalid extension ${label}`);
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

/* -------------------------------------------------------------------------- */
/*                         private message envelopes                          */
/* -------------------------------------------------------------------------- */

const PRIVATE_ENVELOPE_TAG = keccak256(toHex("anima.PrivateEnvelope.v1"));
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Commitment used by `AgentComms.sendPrivate` and `replyPrivate`.
 *
 * Encrypt first (HPKE or an audited ECIES construction), keep the ciphertext off-chain, and
 * pass this commitment as `payloadHash`. Domain separation prevents the same ciphertext being
 * replayed as a message on another chain, contract, or recipient. The random nonce prevents
 * dictionary attacks against deterministic encryption and MUST never be reused with the same
 * content-encryption key.
 *
 * This helper commits to bytes; it does not encrypt them. Cryptography is intentionally left to
 * audited, scheme-specific libraries matching the key type in `EncryptionKeyRegistry`.
 */
export function privateEnvelopeHash(context: PrivateEnvelopeContext, ciphertext: Hex): Hex {
  if (context.chainId <= 0n) throw new Error("chainId must be positive");
  if (!BYTES32.test(context.recipientKeyId)) throw new Error("recipientKeyId must be 32 bytes");
  if (!BYTES32.test(context.nonce)) throw new Error("nonce must be 32 bytes");
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(ciphertext)) throw new Error("ciphertext must be non-empty bytes");

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint256, address, address, uint256, bytes32, bytes32, bytes32"),
      [
        PRIVATE_ENVELOPE_TAG,
        context.chainId,
        getAddress(context.comms),
        getAddress(context.sender),
        context.recipientAgentId,
        context.recipientKeyId,
        context.nonce,
        keccak256(ciphertext),
      ]
    )
  );
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
