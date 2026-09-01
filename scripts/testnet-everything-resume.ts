/** Resume the final derivatives close and signed marketplace legs after a public-RPC gas under-estimate. */
import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, maxUint256,
  parseEther, parseEventLogs, toHex, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
const ZERO32=`0x${"00".repeat(32)}` as Hex; const USD=(n:number)=>BigInt(n)*1_000_000n;
async function main(){
 const path=process.env.ANIMA_DEPLOYMENT!; const keyDir=process.env.ANIMA_KEY_DIR!; const rec=JSON.parse(readFileSync(path,"utf8"));
 const {viem}=await network.connect({network:"baseSepolia"}) as any; const pc=await viem.getPublicClient(); const [wallet]=await viem.getWalletClients();
 const owner=getAddress(wallet.account.address), c=rec.contracts, x=rec.extended;
 const selectedAgent=process.env.EVERYTHING_AGENT_ID ?? x.inProgress?.agentId ?? x.lastRun?.agentId;
 if(!selectedAgent) throw new Error("set EVERYTHING_AGENT_ID or run testnet-everything.ts first");
 const agentId=BigInt(selectedAgent);
 const buyer=createWalletClient({account:privateKeyToAccount(readFileSync(`${keyDir}/${rec.cast.buyer.keyFile}`,"utf8").trim() as Hex),chain:baseSepolia,transport:http(process.env.BASE_SEPOLIA_RPC??"https://sepolia.base.org")});
 const client=createWalletClient({account:privateKeyToAccount(readFileSync(`${keyDir}/${rec.cast.client.keyFile}`,"utf8").trim() as Hex),chain:baseSepolia,transport:http(process.env.BASE_SEPOLIA_RPC??"https://sepolia.base.org")});
 const at=async(n:string,a:Address,w?:any)=>viem.getContractAt(n,a,w?{client:{wallet:w}}:undefined);
 const anima=await at("AnimaAgent",c.anima), accountAddr=await anima.read.accountOf([agentId]), account=await at("AgentAccount",accountAddr);
 const desk=await at("AgentDerivativesDesk",x.derivatives), perp=await at("MockPerpVenue",x.perpVenue), market=await at("AgentMarket",c.market);
 let step=0; const tx=async(label:string,run:()=>Promise<Hex>)=>{const h=await run();const r=await pc.waitForTransactionReceipt({hash:h});if(r.status!=="success")throw Error(`${label} reverted ${h}`);for(let i=0;i<60&&await pc.getBlockNumber({cacheTime:0})<r.blockNumber;i++)await new Promise(x=>setTimeout(x,1000));console.log(`${++step}. ${label}: https://sepolia.basescan.org/tx/${h}`);return r};
 const marketId=keccak256(toHex("LIVE-PERP")), deadline=BigInt((await pc.getBlock()).timestamp)+3600n;
 if((await desk.read.positionOf([agentId,marketId])).lastNotional!==0n){
  await tx("close perpetual with explicit gas",()=>account.write.execute([x.derivatives,0n,encodeFunctionData({abi:desk.abi,functionName:"trade",args:[{agentId,market:marketId,venue:x.perpVenue,marginIn:0n,deadline,venueCalldata:encodeFunctionData({abi:perp.abi,functionName:"close",args:[accountAddr,marketId,USD(100)]})}]}),0],{gas:1_000_000n}));
  await tx("halt perpetual market",()=>desk.write.haltMarket([agentId,marketId]));
  await tx("disable perpetual venue",()=>desk.write.setVenue([x.perpVenue,zeroAddress]));
 }
 const minted=await tx("mint marketplace agent",()=>anima.write.mintAgent([owner,"https://live.example/market.json",ZERO32,{weightsRoot:ZERO32,runtimeMeasurement:ZERO32,attestationKind:0,modelId:"market"},[],0,[]]));
 const log:any=parseEventLogs({abi:anima.abi,eventName:"Transfer",logs:minted.logs}).find((z:any)=>z.args.from===zeroAddress);const saleId=log.args.tokenId as bigint;
 await tx("approve marketplace",()=>anima.write.setApprovalForAll([c.market,true]));
 const order={kind:0,maker:owner,taker:zeroAddress,agentId:saleId,payToken:zeroAddress,price:parseEther("0.001"),start:0n,expiry:BigInt((await pc.getBlock()).timestamp)+3600n,duration:0n,nonce:BigInt(Date.now()),makerEpoch:await market.read.makerEpoch([owner]),expectedAccountState:maxUint256,expectedBrainRoot:ZERO32,expectedBrainEpoch:0n,minBondCoverage:0n} as const;
 const orderTypes={Order:[{name:"kind",type:"uint8"},{name:"maker",type:"address"},{name:"taker",type:"address"},{name:"agentId",type:"uint256"},{name:"payToken",type:"address"},{name:"price",type:"uint256"},{name:"start",type:"uint64"},{name:"expiry",type:"uint64"},{name:"duration",type:"uint64"},{name:"nonce",type:"uint256"},{name:"makerEpoch",type:"uint256"},{name:"expectedAccountState",type:"uint256"},{name:"expectedBrainRoot",type:"bytes32"},{name:"expectedBrainEpoch",type:"uint64"},{name:"minBondCoverage",type:"uint256"}]} as const;
 const domain={name:"AnimaMarket",version:"1",chainId:await pc.getChainId(),verifyingContract:c.market} as const;
 const signature=await wallet.signTypedData({domain,types:orderTypes,primaryType:"Order",message:order});
 const buyerMarket=await at("AgentMarket",c.market,buyer); await tx("fill signed market order",()=>buyerMarket.write.fillOrder([order,signature],{value:order.price}));
 const buyerAnima=await at("AnimaAgent",c.anima,buyer); await tx("buyer approves rental market",()=>buyerAnima.write.setApprovalForAll([c.market,true]));
 const rental={...order,kind:1,maker:getAddress(rec.cast.buyer.address),price:parseEther("0.0001"),duration:3600n,
   nonce:order.nonce+1n,makerEpoch:await market.read.makerEpoch([rec.cast.buyer.address])} as const;
 const rentalSig=await buyer.signTypedData({account:buyer.account!,domain,types:orderTypes,primaryType:"Order",message:rental});
 const clientMarket=await at("AgentMarket",c.market,client); await tx("client fills rental order",()=>clientMarket.write.fillOrder([rental,rentalSig],{value:rental.price}));
 rec.extended.lastRun={agentId:String(agentId),marketAgentId:String(saleId),completed:true};writeFileSync(path,JSON.stringify(rec,null,2)+"\n");
 console.log(`PASS final legs: derivatives closed; market agent #${saleId} sold`);
}
await main();
