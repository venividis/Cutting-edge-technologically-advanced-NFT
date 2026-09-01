/**
 * Resumable LayerZero testnet star exerciser.
 *
 * OMNI_HOME=baseSepolia OMNI_MIRRORS=sepolia,bscTestnet,robinhoodTestnet,unichainSepolia \
 *   npx hardhat run scripts/testnet-omni.ts --network baseSepolia
 *
 * State is evidence, not authority: every saved address, peer and packet phase is checked on
 * chain before it is reused.  A journey is resumed from custody/ownership, so re-running after
 * an RPC timeout never mints a second token or sends a second packet.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, isAddress, keccak256, pad, toHex, zeroAddress, type Address, type Hex } from "viem";
import { lzReceiveOptions, ShardKind } from "../sdk/src/index.js";

type Chain = { chainId: number; eid: number; endpoint: Address; explorer: string };
const CHAINS: Record<string, Chain> = {
  baseSepolia: { chainId: 84532, eid: 40245, endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f", explorer: "https://sepolia.basescan.org" },
  sepolia: { chainId: 11155111, eid: 40161, endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f", explorer: "https://sepolia.etherscan.io" },
  bscTestnet: { chainId: 97, eid: 40102, endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f", explorer: "https://testnet.bscscan.com" },
  robinhoodTestnet: { chainId: 46630, eid: 40451, endpoint: "0x3acaaf60502791d199a5a5f0b173d78229ebfe32", explorer: "https://explorer.testnet.chain.robinhood.com" },
  unichainSepolia: { chainId: 1301, eid: 40333, endpoint: "0xb8815f3f882614048cbe201a67ef9c6f10fe5035", explorer: "https://sepolia.uniscan.xyz" },
};
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const addressWord = (a: Address) => pad(a);
const hasCode = (code?: Hex) => !!code && code !== "0x";

type Journey = { agentId?: string; outboundTx?: Hex; returnTx?: Hex; brainRoot?: Hex; brainEpoch?: string; manifestHash?: Hex; completed?: boolean };
type State = { version: 1; home: { network: string; chainId: number; anima: Address; oapp?: Address }; mirrors: Record<string, { chainId: number; oapp?: Address }>; journeys: Record<string, Journey> };

function loadState(path: string, homeName: string, home: Chain, anima: Address): State {
  const fresh: State = { version: 1, home: { network: homeName, chainId: home.chainId, anima }, mirrors: {}, journeys: {} };
  if (!existsSync(path)) return fresh;
  const value = JSON.parse(readFileSync(path, "utf8")) as State;
  if (value.version !== 1 || value.home.network !== homeName || value.home.chainId !== home.chainId ||
      getAddress(value.home.anima) !== anima || typeof value.mirrors !== "object" || typeof value.journeys !== "object") {
    throw new Error(`deployment state ${path} does not describe this home deployment`);
  }
  return value;
}

export async function main() {
  const homeName = process.env.OMNI_HOME ?? "baseSepolia";
  const homeCfg = CHAINS[homeName];
  if (!homeCfg) throw new Error(`unknown OMNI_HOME ${homeName}`);
  const targets = (process.env.OMNI_MIRRORS ?? "sepolia,bscTestnet,robinhoodTestnet,unichainSepolia")
    .split(",").map((x) => x.trim()).filter(Boolean);
  if (!targets.length || new Set(targets).size !== targets.length || targets.some((x) => !CHAINS[x] || x === homeName))
    throw new Error("OMNI_MIRRORS must be a unique comma-separated list of configured non-home networks");

  const selected = await network.connect({ network: homeName }) as any;
  const [selectedWallet] = await selected.viem.getWalletClients();
  const selectedOwner = getAddress(selectedWallet.account.address);
  const ownedPath = `deployments/${homeCfg.chainId}-${selectedOwner.toLowerCase()}.json`;
  const deploymentPath = existsSync(ownedPath) ? ownedPath : `deployments/${homeCfg.chainId}.json`;
  if (!existsSync(deploymentPath)) throw new Error(`run testnet-deploy.ts on ${homeName} first`);
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  if (deployment.chainId !== homeCfg.chainId || !isAddress(deployment.contracts?.anima)) throw new Error(`invalid ${deploymentPath}`);
  const animaAddress = getAddress(deployment.contracts.anima);
  mkdirSync("deployments", { recursive: true });
  const statePath = `deployments/omni-${homeCfg.chainId}.json`;
  const state = loadState(statePath, homeName, homeCfg, animaAddress);
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const home = selected;
  const homePc = await home.viem.getPublicClient();
  const [homeWallet] = await home.viem.getWalletClients();
  const owner = getAddress(homeWallet.account.address);
  if (await homePc.getChainId() !== homeCfg.chainId) throw new Error(`${homeName} RPC returned the wrong chain`);
  if (!hasCode(await homePc.getCode({ address: animaAddress }))) throw new Error(`saved ANIMA has no code on ${homeName}`);
  if (deployment.deployer && getAddress(deployment.deployer) !== owner) throw new Error("deployment record belongs to another deployer");

  async function checkedOApp(side: any, address: Address, cfg: Chain, contract: string, agents?: Address) {
    const pc = await side.viem.getPublicClient();
    if (!hasCode(await pc.getCode({ address }))) throw new Error(`${address} has no code on chain ${cfg.chainId}`);
    const app = await side.viem.getContractAt(contract, address);
    if (getAddress(await app.read.ENDPOINT()) !== getAddress(cfg.endpoint)) throw new Error(`${address} uses an unexpected LayerZero endpoint`);
    if (agents && getAddress(await app.read.AGENTS()) !== agents) throw new Error(`${address} is attached to a different ANIMA token`);
    return app;
  }
  async function receipt(pc: any, hash: Hex, label: string, cfg: Chain) {
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60; i++) {
      if ((await pc.getBlockNumber({ cacheTime: 0 })) >= r.blockNumber) break;
      await sleep(1000);
    }
    console.log(`${label}: ${cfg.explorer}/tx/${hash}`);
    return r;
  }
  async function waitForCode(pc: any, address: Address, label: string) {
    for (let i = 0; i < 60; i++) {
      if (hasCode(await pc.getCode({ address }))) { console.log(`${label}: ${address}`); return; }
      await sleep(1000);
    }
    throw new Error(`${label} produced no code at ${address}`);
  }

  if (!state.home.oapp) {
    const c = await home.viem.deployContract("OmniAgentHome", [animaAddress, homeCfg.endpoint, owner, owner]);
    await waitForCode(homePc, c.address, "deploy home OApp");
    state.home.oapp = getAddress(c.address); save();
  }
  const homeOApp = await checkedOApp(home, state.home.oapp, homeCfg, "OmniAgentHome", animaAddress);
  const anima = await home.viem.getContractAt("AnimaAgent", animaAddress);
  const options = lzReceiveOptions(BigInt(process.env.OMNI_RECEIVE_GAS ?? "500000"));

  for (const target of targets) {
    const cfg = CHAINS[target];
    const away = await network.connect({ network: target }) as any;
    const awayPc = await away.viem.getPublicClient();
    const [awayWallet] = await away.viem.getWalletClients();
    if (await awayPc.getChainId() !== cfg.chainId) throw new Error(`${target} RPC returned the wrong chain`);
    if (getAddress(awayWallet.account.address) !== owner) throw new Error(`${target} uses a different deployer`);
    if (!hasCode(await awayPc.getCode({ address: cfg.endpoint }))) throw new Error(`LayerZero endpoint absent on ${target}`);
    state.mirrors[target] ??= { chainId: cfg.chainId };
    if (state.mirrors[target].chainId !== cfg.chainId) throw new Error(`saved ${target} chain id mismatch`);
    if (!state.mirrors[target].oapp) {
      const c = await away.viem.deployContract("OmniAgentMirror", ["ANIMA Mirror", "mANIMA", cfg.endpoint, owner, owner]);
      await waitForCode(awayPc, c.address, `deploy ${target} mirror`);
      state.mirrors[target].oapp = getAddress(c.address); save();
    }
    const mirrorAddress = state.mirrors[target].oapp!;
    const mirror = await checkedOApp(away, mirrorAddress, cfg, "OmniAgentMirror");
    const expectedMirror = addressWord(mirrorAddress), expectedHome = addressWord(state.home.oapp!);
    if ((await homeOApp.read.peers([cfg.eid])) !== expectedMirror)
      await receipt(homePc, await homeOApp.write.setPeer([cfg.eid, expectedMirror]), `peer home -> ${target}`, homeCfg);
    if ((await mirror.read.peers([homeCfg.eid])) !== expectedHome)
      await receipt(awayPc, await mirror.write.setPeer([homeCfg.eid, expectedHome]), `peer ${target} -> home`, cfg);

    const j = state.journeys[target] ??= {};
    let id: bigint;
    if (!j.agentId) {
      const content = `omni-${target}-${Date.now()}`;
      const brain = [{ dataHash: keccak256(toHex(content)), keyCommitment: keccak256(toHex(`key:${content}`)), size: BigInt(content.length), kind: ShardKind.Memory, uri: `ipfs://anima/${content}`, description: target }];
      const hash = await anima.write.mintAgent([owner, `https://anima.example/${target}.json`, keccak256(toHex(content)),
        { weightsRoot: keccak256(toHex("omni-test")), runtimeMeasurement: ZERO32, attestationKind: 1, modelId: "omni-test" }, brain, 1, []]);
      const r = await receipt(homePc, hash, `mint ${target} round-trip agent`, homeCfg);
      const { parseEventLogs } = await import("viem");
      const event: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: r.logs }).find((x: any) => x.args.from === zeroAddress);
      if (!event) throw new Error("mint receipt did not contain a mint Transfer");
      id = event.args.tokenId; j.agentId = id.toString();
      j.brainRoot = await anima.read.brainRoot([id]); j.brainEpoch = String(await anima.read.brainEpoch([id]));
      j.manifestHash = (await anima.read.manifestOf([id]))[1]; save();
    } else id = BigInt(j.agentId);

    // Repair a record captured through a lagging public RPC immediately after mint. A zero root
    // is not a valid departure snapshot for the non-empty brain minted above.
    if (j.brainRoot === ZERO32) {
      j.brainRoot = await anima.read.brainRoot([id]);
      j.brainEpoch = String(await anima.read.brainEpoch([id]));
      j.manifestHash = (await anima.read.manifestOf([id]))[1];
      save();
    }

    const homeOwner = async () => { try { return getAddress(await anima.read.ownerOf([id])); } catch { return zeroAddress; } };
    const mirrorOwner = async () => { try { return getAddress(await mirror.read.ownerOf([id])); } catch { return zeroAddress; } };
    // A saved hash prevents a process crash between submission and receipt from duplicating a
    // packet. A mined revert is safe to retry; an absent receipt remains deliberately pending.
    const reconcile = async (pc: any, hash: Hex | undefined, sourceStillOwned: boolean, leg: string) => {
      if (!hash || !sourceStillOwned) return hash;
      try {
        const r = await pc.getTransactionReceipt({ hash });
        if (r.status === "reverted") return undefined;
        throw new Error(`${leg} is mined but source custody has not updated; refusing a duplicate send`);
      } catch (error: any) {
        if (!String(error?.message).includes("could not be found") && !String(error?.name).includes("NotFound")) throw error;
        throw new Error(`${leg} transaction ${hash} has no receipt yet; re-run after it mines (do not duplicate it)`);
      }
    };
    if (j.completed) {
      if (await homeOwner() !== owner || await mirrorOwner() !== zeroAddress || await homeOApp.read.awayOn([id]) !== 0)
        throw new Error(`${target} was marked complete but on-chain custody disagrees`);
      console.log(`${target}: agent #${id} already completed`); continue;
    }
    if (await homeOwner() === owner && await homeOApp.read.awayOn([id]) === 0) {
      j.outboundTx = await reconcile(homePc, j.outboundTx, true, `${target} outbound`); save();
      const fee: any = await homeOApp.read.quoteSend([cfg.eid, addressWord(owner), id, options]);
      await receipt(homePc, await anima.write.approve([state.home.oapp, id]), `approve #${id}`, homeCfg);
      j.outboundTx = await homeOApp.write.send([cfg.eid, addressWord(owner), id, options, fee, owner, false], { value: fee.nativeFee }); save();
      await receipt(homePc, j.outboundTx, `send #${id} to ${target}`, homeCfg);
      console.log(`LayerZero: https://testnet.layerzeroscan.com/tx/${j.outboundTx}`);
    }
    // If returnTx is already saved, the mirror may quite correctly be burned while the return
    // packet is in flight. Do not mistake that resumable state for a failed outbound delivery.
    if (!j.returnTx || await mirrorOwner() === owner) {
      for (let i = 0; await mirrorOwner() !== owner && i < 120; i++) await sleep(10_000);
      if (await mirrorOwner() !== owner) throw new Error(`outbound packet for ${target} is still pending; re-run to resume`);
      const replica: any = await mirror.read.replicaOf([id]);
      if (replica.brainRoot !== j.brainRoot || String(replica.brainEpoch) !== j.brainEpoch || replica.manifestHash !== j.manifestHash || Number(replica.homeEid) !== homeCfg.eid)
        throw new Error(`${target} replica diverges from the recorded departure snapshot`);
      j.returnTx = await reconcile(awayPc, j.returnTx, true, `${target} return`); save();
    }
    if (!j.returnTx) {
      const fee: any = await mirror.read.quoteSend([homeCfg.eid, addressWord(owner), id, options]);
      j.returnTx = await mirror.write.send([homeCfg.eid, addressWord(owner), id, options, fee, owner], { value: fee.nativeFee }); save();
      await receipt(awayPc, j.returnTx, `return #${id} from ${target}`, cfg);
      console.log(`LayerZero: https://testnet.layerzeroscan.com/tx/${j.returnTx}`);
    }
    for (let i = 0; await homeOwner() !== owner && i < 120; i++) await sleep(10_000);
    if (await homeOwner() !== owner) throw new Error(`return packet from ${target} is still pending; re-run to resume`);
    if (await mirrorOwner() !== zeroAddress || await homeOApp.read.awayOn([id]) !== 0) throw new Error(`${target} final custody invariant failed`);
    j.completed = true; save();
    console.log(`${target}: agent #${id} completed a verified round trip`);
  }
}

await main();
