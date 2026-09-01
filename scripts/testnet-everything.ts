/** Exercise every remaining market/reach function family on the live Base deployment. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, maxUint256,
  parseEther, parseEventLogs, toHex, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const USD = (n: number | bigint) => BigInt(n) * 1_000_000n;
const TOK = (n: number | bigint) => BigInt(n) * 10n ** 18n;
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

async function main() {
  const path = process.env.ANIMA_DEPLOYMENT ?? "deployments/84532.json";
  const keyDir = process.env.ANIMA_KEY_DIR;
  if (!keyDir) throw new Error("ANIMA_KEY_DIR is required");
  const rec = JSON.parse(readFileSync(path, "utf8")); rec.extended ??= {};
  const save = () => writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
  const { viem } = await network.connect({ network: "baseSepolia" }) as any;
  const pc = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
  const owner = getAddress(wallet.account.address); const c = rec.contracts;
  if (getAddress(rec.deployer) !== owner) throw new Error("deployment/deployer mismatch");
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const cast = (role: string) => createWalletClient({
    account: privateKeyToAccount(readFileSync(`${keyDir}/${rec.cast[role].keyFile}`, "utf8").trim() as Hex),
    chain: baseSepolia, transport: http(rpc),
  });
  const client = cast("client"), buyer = cast("buyer");
  let step = 0;
  const tx = async (label: string, run: () => Promise<Hex>) => {
    const hash = await run(); const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    for (let i = 0; i < 60 && await pc.getBlockNumber({ cacheTime: 0 }) < receipt.blockNumber; i++) await sleep(1000);
    console.log(`${String(++step).padStart(2)}. ${label.padEnd(42)} https://sepolia.basescan.org/tx/${hash}`);
    return receipt;
  };
  const once = async (key: string, name: string, args: unknown[] = []) => {
    if (rec.extended[key]) return rec.extended[key] as Address;
    const deployed = await viem.deployContract(name, args);
    for (let i = 0; i < 60; i++) { if ((await pc.getCode({ address: deployed.address })) !== "0x") break; await sleep(1000); }
    rec.extended[key] = getAddress(deployed.address); save();
    console.log(`deployed ${name.padEnd(24)} ${deployed.address}`); return deployed.address as Address;
  };
  const at = async (n: string, a: Address, w?: any) => viem.getContractAt(n, a, w ? { client: { wallet: w } } : undefined);
  const anima = await at("AnimaAgent", c.anima), usdc = await at("MockERC20", c.usdc);

  const launchpadAddr = await once("launchpad", "AgentLaunchpad", [c.usdc, c.anima, c.anima, owner, owner,
    { protocolBps: 100, treasuryBps: 100, agentBps: 100 }]);
  const liquidityAddr = await once("liquidityDeployer", "MockLiquidityDeployer");
  const swapAddr = await once("swapRouter", "AgentSwapRouter", [c.anima, c.anima, owner]);
  const swapVenueAddr = await once("swapVenue", "MockVenue");
  const inAddr = await once("swapTokenIn", "MockERC20", ["Live Input", "LIN", 18]);
  const outAddr = await once("swapTokenOut", "MockERC20", ["Live Output", "LOUT", 18]);
  const deskAddr = await once("derivatives", "AgentDerivativesDesk", [c.usdc, c.anima, c.anima, owner]);
  const perpAddr = await once("perpVenue", "MockPerpVenue", [c.usdc]);
  const bindingsAddr = await once("bindings", "AnimaBindings", [c.anima]);
  const launchpad = await at("AgentLaunchpad", launchpadAddr), liquidity = await at("MockLiquidityDeployer", liquidityAddr);
  const swap = await at("AgentSwapRouter", swapAddr), venue = await at("MockVenue", swapVenueAddr);
  const tokenIn = await at("MockERC20", inAddr), tokenOut = await at("MockERC20", outAddr);
  const desk = await at("AgentDerivativesDesk", deskAddr), perp = await at("MockPerpVenue", perpAddr);
  const bindings = await at("AnimaBindings", bindingsAddr), comms = await at("AgentComms", c.comms);
  const keyRegistry = await at("EncryptionKeyRegistry", c.keyRegistry), market = await at("AgentMarket", c.market);

  const mint = await tx("mint extended-test agent", () => anima.write.mintAgent([owner, "https://live.example/everything.json",
    keccak256(toHex("everything-manifest")), { weightsRoot: keccak256(toHex("everything-weights")), runtimeMeasurement: ZERO32,
      attestationKind: 1, modelId: "live/everything" }, [], 1, []]));
  const mintLog: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: mint.logs }).find((x: any) => x.args.from === zeroAddress);
  const agentId = mintLog.args.tokenId as bigint;
  rec.extended.inProgress = { agentId: agentId.toString() }; save();
  await tx("deploy extended agent account", () => anima.write.deployAccount([agentId]));
  const accountAddr = await anima.read.accountOf([agentId]); const account = await at("AgentAccount", accountAddr);
  await tx("activate extended agent", () => anima.write.setStatus([agentId, 1]));

  // Encryption-key publication and revocation.
  await tx("publish encryption key", () => keyRegistry.write.setEncryptionKey([1, toHex("live-x25519-public-key")]));
  await tx("revoke encryption key", () => keyRegistry.write.revokeEncryptionKey());

  // Agent bindings: the owner controls both the ERC-8004 identity and its master NFT.
  await tx("bind ERC-8004 identity to NFT", () => bindings.write.bind([agentId, 0, c.anima, agentId]));

  // Chat: paid send, reply, and authenticated broadcast.
  await tx("configure paid chat inbox", () => comms.write.configureInbox([agentId, c.usdc, USD(3), 3600n, true]));
  const usdcClient = await at("MockERC20", c.usdc, client), commsClient = await at("AgentComms", c.comms, client);
  await tx("client approves chat postage", () => usdcClient.write.approve([c.comms, USD(10)]));
  const sent = await tx("send paid chat message", () => commsClient.write.send([agentId, 0n, keccak256(toHex("everything-thread")),
    keccak256(toHex("hello agent")), "ipfs://live-chat/request", c.usdc, USD(3)]));
  const message: any = parseEventLogs({ abi: comms.abi, eventName: "MessageSent", logs: sent.logs })[0];
  await tx("reply and collect postage", () => comms.write.reply([message.args.messageId, keccak256(toHex("hello human")), "ipfs://live-chat/reply"]));
  await tx("broadcast authenticated update", () => comms.write.broadcast([agentId, keccak256(toHex("news")), keccak256(toHex("live")), "ipfs://live-chat/broadcast"]));

  // Launch, buy, sell, redeem, sync revenue, and graduate into the mock liquidity adapter.
  await tx("configure liquidity deployer", () => launchpad.write.setLiquidityDeployer([liquidityAddr]));
  const created = await tx("create agent-token launch", () => launchpad.write.createLaunch([{
    agentId, name: "Everything Agent", symbol: "EVERY", totalSupply: TOK(1_000_000_000), curveSupply: TOK(800_000_000),
    virtualQuote: USD(1000), graduationTarget: USD(3000), startsAt: 0n, fairWindow: 0n, maxBuyInWindow: USD(5000),
    snipeTaxStartBps: 0, lpRecipient: "0x000000000000000000000000000000000000dEaD",
  }]));
  const launchEvent: any = parseEventLogs({ abi: launchpad.abi, eventName: "LaunchCreated", logs: created.logs })[0];
  const launchId = launchEvent.args.launchId as bigint, agentTokenAddr = launchEvent.args.token as Address;
  const agentToken = await at("AgentToken", agentTokenAddr);
  await tx("approve launch quote token", () => usdc.write.approve([launchpadAddr, USD(5000)]));
  await tx("buy on bonding curve", () => launchpad.write.buy([launchId, USD(500), 0n]));
  const held = await agentToken.read.balanceOf([owner]);
  await tx("approve curve token sale", () => agentToken.write.approve([launchpadAddr, held / 5n]));
  await tx("sell on bonding curve", () => launchpad.write.sell([launchId, held / 5n, 0n]));
  const redeemable = (await agentToken.read.balanceOf([owner])) / 20n;
  await tx("redeem against token floor", () => agentToken.write.redeem([redeemable]));
  await tx("send protocol revenue to token", () => usdc.write.transfer([agentTokenAddr, USD(10)]));
  await tx("sync redemption treasury", () => agentToken.write.sync());
  await tx("buy to graduation threshold", () => launchpad.write.buy([launchId, USD(3500), 0n]));
  await tx("graduate into locked liquidity", () => launchpad.write.graduate([launchId]));
  if ((await liquidity.read.lastQuoteAmount()) === 0n) throw new Error("graduation deployed no liquidity");

  // Spot swap through the account under owner-published limits.
  await tx("mint swap input to agent", () => tokenIn.write.mint([accountAddr, TOK(1000)]));
  await tx("fund live swap venue output", () => tokenOut.write.mint([swapVenueAddr, TOK(1000)]));
  await tx("allow live swap venue", () => swap.write.setVenue([swapVenueAddr, true]));
  await tx("publish swap token limit", () => swap.write.setLimit([agentId, inAddr, TOK(100), TOK(250)]));
  await tx("agent approves swap router", () => account.write.execute([inAddr, 0n,
    encodeFunctionData({ abi: tokenIn.abi, functionName: "approve", args: [swapAddr, TOK(1000)] }), 0]));
  const swapDeadline = BigInt((await pc.getBlock()).timestamp) + 3600n;
  await tx("agent executes bounded swap", () => account.write.execute([swapAddr, 0n,
    encodeFunctionData({ abi: swap.abi, functionName: "swap", args: [{ agentId, tokenIn: inAddr, tokenOut: outAddr,
      amountIn: TOK(100), minOut: TOK(100), deadline: swapDeadline, venue: swapVenueAddr,
      venueCalldata: encodeFunctionData({ abi: venue.abi, functionName: "swap", args: [inAddr, outAddr, TOK(100)] }) }] }), 0]));
  await tx("guardian-style revoke swap token", () => swap.write.revokeToken([agentId, inAddr]));

  // Perpetual position open and close through the typed adapter boundary.
  const marketId = keccak256(toHex("LIVE-PERP"));
  await tx("mint margin to agent account", () => usdc.write.mint([accountAddr, USD(1000)]));
  await tx("allow perpetual adapter", () => desk.write.setVenue([perpAddr, perpAddr]));
  await tx("publish perpetual limit", () => desk.write.setLimit([agentId, marketId, USD(5000), USD(500), 1000]));
  await tx("publish portfolio limit", () => desk.write.setPortfolioLimit([agentId, USD(500)]));
  await tx("agent approves derivatives desk", () => account.write.execute([c.usdc, 0n,
    encodeFunctionData({ abi: usdc.abi, functionName: "approve", args: [deskAddr, USD(1000)] }), 0]));
  const perpDeadline = BigInt((await pc.getBlock()).timestamp) + 3600n;
  await tx("agent opens bounded perpetual", () => account.write.execute([deskAddr, 0n,
    encodeFunctionData({ abi: desk.abi, functionName: "trade", args: [{ agentId, market: marketId, venue: perpAddr,
      marginIn: USD(100), deadline: perpDeadline, venueCalldata: encodeFunctionData({ abi: perp.abi,
        functionName: "open", args: [accountAddr, marketId, USD(100)] }) }] }), 0]));
  await tx("agent closes perpetual", () => account.write.execute([deskAddr, 0n,
    encodeFunctionData({ abi: desk.abi, functionName: "trade", args: [{ agentId, market: marketId, venue: perpAddr,
      marginIn: 0n, deadline: perpDeadline, venueCalldata: encodeFunctionData({ abi: perp.abi,
        functionName: "close", args: [accountAddr, marketId, USD(100)] }) }] }), 0]));

  // Signed marketplace settlement to the independent buyer.
  const marketMint = await tx("mint marketplace agent", () => anima.write.mintAgent([owner, "https://live.example/market.json",
    ZERO32, { weightsRoot: ZERO32, runtimeMeasurement: ZERO32, attestationKind: 0, modelId: "market" }, [], 0, []]));
  const marketLog: any = parseEventLogs({ abi: anima.abi, eventName: "Transfer", logs: marketMint.logs }).find((x: any) => x.args.from === zeroAddress);
  const saleId = marketLog.args.tokenId as bigint;
  await tx("approve marketplace operator", () => anima.write.setApprovalForAll([c.market, true]));
  const order = { kind: 0, maker: owner, taker: zeroAddress, agentId: saleId, payToken: zeroAddress,
    price: parseEther("0.001"), start: 0n, expiry: BigInt((await pc.getBlock()).timestamp) + 3600n, duration: 0n,
    nonce: BigInt(Date.now()), makerEpoch: await market.read.makerEpoch([owner]), expectedAccountState: maxUint256,
    expectedBrainRoot: ZERO32, expectedBrainEpoch: 0n, minBondCoverage: 0n } as const;
  const signature = await wallet.signTypedData({ domain: { name: "AnimaMarket", version: "1", chainId: await pc.getChainId(),
    verifyingContract: c.market }, types: { Order: [
      { name: "kind", type: "uint8" }, { name: "maker", type: "address" }, { name: "taker", type: "address" },
      { name: "agentId", type: "uint256" }, { name: "payToken", type: "address" }, { name: "price", type: "uint256" },
      { name: "start", type: "uint64" }, { name: "expiry", type: "uint64" }, { name: "duration", type: "uint64" },
      { name: "nonce", type: "uint256" }, { name: "makerEpoch", type: "uint256" },
      { name: "expectedAccountState", type: "uint256" }, { name: "expectedBrainRoot", type: "bytes32" },
      { name: "expectedBrainEpoch", type: "uint64" }, { name: "minBondCoverage", type: "uint256" },
    ] }, primaryType: "Order", message: order });
  const buyerMarket = await at("AgentMarket", c.market, buyer);
  await tx("buyer fills signed market order", () => buyerMarket.write.fillOrder([order, signature], { value: order.price }));
  if (getAddress(await anima.read.ownerOf([saleId])) !== getAddress(rec.cast.buyer.address)) throw new Error("market owner mismatch");

  rec.extended.lastRun = { agentId: agentId.toString(), launchId: launchId.toString(), agentToken: agentTokenAddr,
    marketAgentId: saleId.toString(), completed: true }; save();
  console.log(`PASS: ${step} live transactions; agent #${agentId}, launch #${launchId}, market agent #${saleId}`);
}
await main();
