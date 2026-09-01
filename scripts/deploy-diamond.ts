/**
 * Deploying the token as an immutable EIP-2535 diamond.
 *
 *   npx hardhat run scripts/deploy-diamond.ts --network <name>
 *
 * This exists because the alternative was worse. `docs/DEPLOYMENT.md` used to point operators at
 * a fixture in the test tree as the worked example, and an operator transcribing a fixture is
 * exactly where an unrecoverable mistake comes from: the diamond has no `diamondCut`, so the
 * routing table you deploy is the routing table forever. A selector left unrouted is a function
 * the token will never have. There is no step 5.
 *
 * So the script does two things, and the second is the point:
 *
 *   1. Derives the cut from `AnimaAgent`'s ABI rather than a hand-written selector list, via the
 *      SDK's `deriveFacetCut`, which throws rather than returning a partial cut.
 *   2. Verifies the deployed diamond against that ABI *on chain*, before returning. Every check
 *      below is one an operator would otherwise have to remember to run by hand.
 *
 * It returns the addresses; wiring the protocol around the token is `scripts/deploy.ts`'s job,
 * and everything there takes the token's address and does not care which build it is.
 */
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";
import { deriveFacetCut, cutIsImmutable, DIAMOND_CUT_SELECTOR } from "../sdk/src/index.js";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const artifact = (dir: string, name: string) =>
  JSON.parse(readFileSync(`artifacts/contracts/${dir}/${name}.sol/${name}.json`, "utf8"));

/**
 * Zeroes the byte ranges solc reserves for `immutable` values.
 *
 * A compiled artifact carries placeholders where the deployed code carries real values, so the
 * two never match byte for byte for a contract with immutables — and a comparison that always
 * fails is a comparison nobody reads. Masking the ranges the artifact itself names lets the rest
 * of the code be compared exactly, and the values in those ranges are checked separately, by
 * asking each facet what configuration it actually holds.
 */
/**
 * Blocks until a freshly deployed address actually reports code from *this* endpoint.
 *
 * A public RPC is a load balancer over several nodes. `deployContract` returns once a receipt is
 * seen, but the very next call can land on a node that has not caught up — so a constructor that
 * inspects the contracts it was just handed (as {AnimaDiamond} does, staticcalling every facet
 * for its config hash) can be told they hold no code, and revert `NoConfiguredFacet`. The failure
 * is in the estimate, not on chain, which makes it maddening to read: the transaction never gets
 * sent, and the addresses in the error are perfectly good.
 */
async function waitForCode(publicClient: any, address: Address, label: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x") return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label} at ${address} still reports no code after ${tries} tries`);
}

function maskImmutables(code: string, refs: Record<string, { start: number; length: number }[]>) {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const spans of Object.values(refs ?? {})) {
    for (const { start, length } of spans) bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString("hex")}`;
}

/** The ABI the diamond must present in full. It is the specification, not a suggestion. */
const ANIMA_ABI: Abi = artifact("core", "AnimaAgent").abi;

export interface DiamondConfig {
  name: string;
  symbol: string;
  /** Two-step owner of the re-key verifier, module allowlist, royalties and contract URI. */
  owner: Address;
  /** ERC-6551 registry. Canonical is 0x000000006551c19487814612e58FE06813775758 on every chain. */
  registry: Address;
  /** `AgentAccount` implementation the token derives agent wallets from. */
  accountImplementation: Address;
  accountSalt?: `0x${string}`;
  /** Chain-wide `EncryptionKeyRegistry`. Reuse the one on your chain if it exists. */
  keyRegistry: Address;
  /** Start with `NullTransferVerifier`; it honestly reports `Committed`. */
  verifier: Address;
  royaltyReceiver: Address;
  royaltyBps: bigint;
  /** Already-deployed facets to reuse, so a failed run does not pay for them twice. */
  facets?: { core?: Address; agent?: Address; brain?: Address; loupe?: Address; init?: Address };
}

/**
 * @param connection An existing network connection to deploy through. Defaults to the one the
 *        `--network` flag selects. Injectable so the test suite can run this script for real
 *        against a chain that already holds the prerequisites, rather than testing a copy of it.
 */
export async function deployDiamond(config: DiamondConfig, connection?: { viem: any }) {
  const { viem } = (connection ?? (await network.connect())) as { viem: any };
  const publicClient = await viem.getPublicClient();
  const log = (label: string, value: string) => console.log(`  ${label.padEnd(26)} ${value}`);

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value.startsWith("0x") && value.length === 42 && value === zeroAddress) {
      throw new Error(`config.${key} is the zero address`);
    }
  }

  // ---- 1. facets -----------------------------------------------------------
  // All four config values go to every facet that carries them, as `immutable`. That is what
  // keeps `accountOf` free of storage reads — eight protocol contracts call it on their
  // settlement paths — and the diamond's constructor checks the copies agree.
  const animaConfig = {
    registry: config.registry,
    accountImplementation: config.accountImplementation,
    accountSalt: config.accountSalt ?? ZERO32,
    keyRegistry: config.keyRegistry,
  } as const;

  console.log("\nfacets");
  const reuse = config.facets;
  const core = reuse?.core
    ? await viem.getContractAt("AnimaCoreFacet", reuse.core)
    : await viem.deployContract("AnimaCoreFacet", [animaConfig]);
  log("AnimaCoreFacet", core.address);
  const agent = reuse?.agent
    ? await viem.getContractAt("AnimaAgentFacet", reuse.agent)
    : await viem.deployContract("AnimaAgentFacet", [animaConfig]);
  log("AnimaAgentFacet", agent.address);
  const brain = reuse?.brain
    ? await viem.getContractAt("AnimaBrainFacet", reuse.brain)
    : await viem.deployContract("AnimaBrainFacet", [animaConfig]);
  log("AnimaBrainFacet", brain.address);
  const loupe = reuse?.loupe
    ? await viem.getContractAt("AnimaLoupeFacet", reuse.loupe)
    : await viem.deployContract("AnimaLoupeFacet");
  log("AnimaLoupeFacet", loupe.address);
  const init = reuse?.init
    ? await viem.getContractAt("AnimaInit", reuse.init)
    : await viem.deployContract("AnimaInit", [animaConfig]);
  log("AnimaInit", init.address);

  // The diamond's constructor reads every one of these before it will deploy.
  for (const [name, c] of [
    ["AnimaCoreFacet", core],
    ["AnimaAgentFacet", agent],
    ["AnimaBrainFacet", brain],
    ["AnimaLoupeFacet", loupe],
    ["AnimaInit", init],
  ] as const) {
    await waitForCode(publicClient, c.address as Address, name);
  }

  // ---- 2. the cut, derived ------------------------------------------------
  const cuts = deriveFacetCut({
    tokenAbi: ANIMA_ABI,
    base: { name: "AnimaCoreFacet", address: core.address, abi: core.abi },
    specialised: [
      { name: "AnimaAgentFacet", address: agent.address, abi: agent.abi },
      { name: "AnimaBrainFacet", address: brain.address, abi: brain.abi },
    ],
    additional: [{ name: "AnimaLoupeFacet", address: loupe.address, abi: loupe.abi }],
  });
  if (!cutIsImmutable(cuts)) throw new Error("derived cut routes diamondCut — refusing to deploy");

  const routed = cuts.flatMap((c) => c.functionSelectors);
  console.log(
    `\ncut: ${routed.length} selectors over ${cuts.length} facets ` +
      `(${cuts.map((c) => c.functionSelectors.length).join(" + ")})`
  );

  // ---- 3. the diamond ------------------------------------------------------
  const diamond = await viem.deployContract("AnimaDiamond", [
    cuts,
    init.address,
    encodeFunctionData({
      abi: init.abi,
      functionName: "init",
      args: [config.name, config.symbol, config.owner, config.verifier, config.royaltyReceiver, config.royaltyBps],
    }),
  ]);
  console.log("");
  log("AnimaDiamond", diamond.address);
  await waitForCode(publicClient, diamond.address as Address, "AnimaDiamond");

  // ---- 4. verification, on chain ------------------------------------------
  // The constructor already refuses a duplicate selector, a non-Add action, a codeless facet,
  // facets that disagree about the configuration, and a diamond that did not initialise. What it
  // cannot check is whether the cut it was handed was the *right* cut — that is this section.
  const token = await viem.getContractAt("AnimaAgent", diamond.address);
  const view = await viem.getContractAt("AnimaLoupeFacet", diamond.address);

  // `waitForCode` proves *a* node has the diamond; the next read can still land on one that does
  // not. Retry the first read until it answers rather than reporting a verification failure that
  // is really an infrastructure hiccup — a false "do NOT publish this address" is its own hazard.
  for (let i = 0; i < 40; i++) {
    try {
      await view.read.facetAddresses();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };

  // (a) Every function AnimaAgent declares resolves to the facet the cut assigned it. Checking
  //     only that it resolves to *something* would miss a selector repointed elsewhere — and the
  //     initialiser runs by delegatecall, so repointing one is a thing an initialiser can do.
  //     AnimaDiamond's constructor now refuses that outright; this re-checks it from outside.
  const assignedTo = new Map<string, Address>();
  for (const cut of cuts) for (const selector of cut.functionSelectors) assignedTo.set(selector, cut.facetAddress);

  const declared = ANIMA_ABI.filter((e) => e.type === "function").map((e) => toFunctionSelector(e as never));
  for (const selector of declared) {
    const expectedFacet = assignedTo.get(selector);
    const actual = await view.read.facetAddress([selector]);
    if (!expectedFacet) {
      failures.push(`selector ${selector} is in AnimaAgent's ABI but the cut never assigned it`);
    } else {
      check(
        getAddress(actual) === getAddress(expectedFacet),
        `selector ${selector} resolves to ${actual}, but the cut assigned it to ${expectedFacet}`
      );
    }
  }

  // (b) Nothing routes diamondCut, so the table can never change.
  check(
    (await view.read.facetAddress([DIAMOND_CUT_SELECTOR])) === zeroAddress,
    "a selector resolves to diamondCut — this diamond is NOT immutable"
  );

  // (c) The loupe reports exactly the facets deployed above, and no others.
  const expected = [core.address, agent.address, brain.address, loupe.address].map(getAddress).sort();
  const reported = (await view.read.facetAddresses()).map(getAddress).sort();
  check(
    JSON.stringify(reported) === JSON.stringify(expected),
    `loupe reports ${reported.join(", ")}, expected ${expected.join(", ")}`
  );

  // (d) Every facet holds the code this repo compiles, not something else at the same address —
  //     and none of them contains a diamondCut, so no later deployment could wire one in either.
  for (const [name, deployed] of [
    ["AnimaCoreFacet", core],
    ["AnimaAgentFacet", agent],
    ["AnimaBrainFacet", brain],
    ["AnimaLoupeFacet", loupe],
  ] as const) {
    const onChain = (await publicClient.getCode({ address: deployed.address })) ?? "0x";
    const { deployedBytecode, immutableReferences } = artifact("diamond", name);
    check(
      maskImmutables(onChain, immutableReferences) === maskImmutables(deployedBytecode, immutableReferences),
      `${name}'s on-chain code differs from what this repo compiles`
    );
    check(!onChain.includes(DIAMOND_CUT_SELECTOR.slice(2)), `${name} contains the diamondCut selector`);
  }

  // (d2) …and the immutables inside those masked ranges are the configuration that was asked for.
  //      This is the half a bytecode diff cannot see, and it is the half that decides where every
  //      agent's wallet lives.
  const expectedConfig = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, bytes32, address"), [
      animaConfig.registry,
      animaConfig.accountImplementation,
      animaConfig.accountSalt,
      animaConfig.keyRegistry,
    ])
  );
  for (const [name, deployed] of [
    ["AnimaCoreFacet", core],
    ["AnimaAgentFacet", agent],
    ["AnimaBrainFacet", brain],
  ] as const) {
    const facet = await viem.getContractAt("AnimaCoreFacet", deployed.address);
    check(
      (await facet.read.animaConfigHash()) === expectedConfig,
      `${name} was built against a different ERC-6551 configuration than requested`
    );
  }
  check(
    getAddress(await token.read.REGISTRY()) === getAddress(config.registry) &&
      getAddress(await token.read.KEY_REGISTRY()) === getAddress(config.keyRegistry) &&
      getAddress(await token.read.ACCOUNT_IMPLEMENTATION()) === getAddress(config.accountImplementation),
    "the token reports a different ERC-6551 configuration than was requested"
  );

  // (e) Initialisation took effect. `nextAgentId` is asserted by the constructor; these are the
  //     rest of what AnimaInit is responsible for.
  check((await token.read.name()) === config.name, "ERC-721 name did not initialise");
  check((await token.read.symbol()) === config.symbol, "ERC-721 symbol did not initialise");
  check(
    getAddress(await token.read.owner()) === getAddress(config.owner),
    "owner did not initialise — the module allowlist would be unreachable forever"
  );
  check(
    getAddress(await token.read.verifier()) === getAddress(config.verifier),
    "re-key verifier did not initialise"
  );
  check((await token.read.totalMinted()) === 0n, "agent ids are not one-based");
  const [, domainName, version, , verifyingContract] = await token.read.eip712Domain();
  check(domainName === "AnimaAgent" && version === "1", "EIP-712 domain is not (AnimaAgent, 1)");
  check(
    getAddress(verifyingContract) === getAddress(diamond.address),
    "EIP-712 verifyingContract is not this diamond"
  );

  // (f) It answers ERC-165 for everything the standard claims, plus the loupe it implements.
  for (const [label, id] of [
    ["ERC-165", "0x01ffc9a7"],
    ["ERC-721", "0x80ac58cd"],
    ["ERC-721Metadata", "0x5b5e139f"],
    ["ERC-2981", "0x2a55205a"],
    ["ERC-4906", "0x49064906"],
    ["ERC-4907", "0xad092b5c"],
    ["ERC-5192", "0xb45a3c0e"],
    ["ERC-6454", "0x91a6262f"],
    ["ERC-5646", "0xf5112315"],
    ["ERC-7572", "0xe8a3d485"],
    ["IDiamondLoupe", "0x48e2b093"],
  ] as const) {
    check(await token.read.supportsInterface([id]), `does not report ${label} (${id})`);
  }
  check(!(await token.read.supportsInterface(["0xffffffff"])), "reports 0xffffffff, violating ERC-165");

  if (failures.length) {
    console.error(`\n${failures.length} verification failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    throw new Error("deployed diamond failed verification — do NOT publish this address");
  }
  console.log(`\n  ✓ ${declared.length} selectors routed, no diamondCut, initialised, ERC-165 correct`);

  // ---- 5. what only a human can do ----------------------------------------
  console.log(
    [
      "",
      "Before publishing this address, independently confirm:",
      "  1. Each facet is source-verified on the explorer, and its verified source is this repo.",
      `  2. facetAddress(${DIAMOND_CUT_SELECTOR}) returns the zero address, from a node you trust.`,
      "  3. The ERC-6551 registry above is the canonical one for this chain.",
      "",
      "There is no diamondCut. None of the above can be corrected after the fact.",
      "",
    ].join("\n")
  );

  return {
    token: diamond.address as Address,
    facets: {
      core: core.address as Address,
      agent: agent.address as Address,
      brain: brain.address as Address,
      loupe: loupe.address as Address,
    },
    init: init.address as Address,
    cuts,
  };
}
