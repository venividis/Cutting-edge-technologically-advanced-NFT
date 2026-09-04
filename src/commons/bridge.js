/** Explicit testnet transport. Reading is opt-in; writes are simulated and reviewed twice. */
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, getAddress, http, isAddress, keccak256, toHex, zeroHash } from 'viem';
import { COMMONS_ABI, AGENT_ABI, WORK_ABI, BOND_ABI, REPUTATION_ABI } from './abi.js';
export const HISTORICAL = Object.freeze({chainId:84532,rpc:'https://sepolia.base.org',anima:'0x0aeb6f783ebade8fd5ffca74317266d4ea3e71b3',work:'0xFBA84694C5F0Ee5A33fad6D732f327db7644af4A',commons:''});
export const hashText = value => keccak256(toHex(value));
export const shortAddress = a => a ? `${a.slice(0,6)}…${a.slice(-4)}` : 'Not connected';
export function validateConfig(c){
 const chainId=Number(c.chainId);if(![84532,31337].includes(chainId))throw Error('This release enables Base Sepolia and local chain 31337 only.');
 const u=new URL(c.rpc);if(u.username||u.password||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('Use HTTPS or a loopback HTTP RPC, without embedded credentials.');
 for(const k of ['anima','work'])if(!isAddress(c[k]))throw Error(`Enter a valid ${k} contract address.`);
 if(c.commons&&!isAddress(c.commons))throw Error('Enter a valid Commons address, or leave it empty for agent inspection only.');
 return {chainId,rpc:u.href,anima:getAddress(c.anima),work:getAddress(c.work),commons:c.commons?getAddress(c.commons):''};
}
export class CommonsBridge {
 constructor(onChange=()=>{}){this.onChange=onChange;this.epoch=0;this.address=null;this.config=null;this.provider=null;this.connectedChain=null;this.verified=false;this.listeners=null;}
 async configure(raw){
  const c=validateConfig(raw),chain=defineChain({id:c.chainId,name:c.chainId===31337?'Local development':'Base Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[c.rpc]}}});
  const client=createPublicClient({chain,cacheTime:0,ccipRead:false,transport:http(c.rpc,{timeout:15000,retryCount:0})});
  if(await client.getChainId()!==c.chainId)throw Error('The RPC reports a different chain. Configuration rejected.');
  const getCode=address=>client.getCode({address});
  for(const address of [c.anima,c.work,...(c.commons?[c.commons]:[])]){const code=await getCode(address);if(!code||code==='0x')throw Error('A configured address has no deployed contract code.');}
  const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args});
  if(getAddress(await read(c.work,WORK_ABI,'ANIMA'))!==c.anima)throw Error('WorkEscrow belongs to a different ANIMA token.');
  if(c.commons){if(getAddress(await read(c.commons,COMMONS_ABI,'ANIMA'))!==c.anima||getAddress(await read(c.commons,COMMONS_ABI,'WORK'))!==c.work)throw Error('Commons is not bound to these token and work contracts.');}
  this.config=c;this.chain=chain;this.public=client;this.epoch++;this.verified=true;this.onChange();return c;
 }
 read(address,abi,functionName,args=[],blockNumber){if(!this.public)throw Error('Configure a network first.');return this.public.readContract({address,abi,functionName,args,...(blockNumber===undefined?{}:{blockNumber})});}
 async connect(provider=window.ethereum){
  if(!provider?.request)throw Error('No wallet was detected. Explore locally without one, or open this page in a wallet-enabled browser.');
  this.detach();this.provider=provider;
  const accounts=await provider.request({method:'eth_requestAccounts'});this.address=accounts[0]?getAddress(accounts[0]):null;this.connectedChain=Number(await provider.request({method:'eth_chainId'}));
  const changed=()=>{this.address=null;this.connectedChain=null;this.epoch++;this.onChange('Wallet or chain changed. Reconnect before another action.');};
  provider.on?.('accountsChanged',changed);provider.on?.('chainChanged',changed);provider.on?.('disconnect',changed);this.listeners=changed;this.epoch++;this.onChange();
 }
 detach(){if(this.provider&&this.listeners)for(const e of ['accountsChanged','chainChanged','disconnect'])this.provider.removeListener?.(e,this.listeners);this.listeners=null;}
 disconnect(){this.detach();this.address=null;this.provider=null;this.connectedChain=null;this.epoch++;this.onChange();}
 requireWrite(){if(!this.verified||!this.config?.commons)throw Error('A verified Commons deployment is required. This upgrade has not been deployed publicly.');if(!this.address||!this.provider)throw Error('Connect a wallet explicitly first.');if(this.connectedChain!==this.config.chainId)throw Error('Switch your wallet to the configured test network, then reconnect.');}
 async circles(start=1n){
  const epoch=this.epoch,c=this.config;if(!c?.commons)throw Error('No Commons deployment configured.');
  const block=await this.public.getBlockNumber({cacheTime:0}),end=await this.read(c.commons,COMMONS_ABI,'nextCircleId',[],block),list=[];
  // Explicit pagination: never scan every token, event, or circle by default.
  for(let id=BigInt(start);id<end&&id<BigInt(start)+20n;id++){
   const v=await this.read(c.commons,COMMONS_ABI,'circleOf',[id],block);const member=this.address?await this.read(c.commons,COMMONS_ABI,'isMember',[id,this.address],block):false;
   list.push({...v,id:String(id),members:Number(v.members),slowMode:Number(v.slowMode),member,live:true,block:String(block)});
  }if(epoch!==this.epoch)throw Error('Configuration changed during the read. Please reload.');return {items:list,next:BigInt(start)+BigInt(list.length)<end?String(BigInt(start)+BigInt(list.length)):null,block:String(block)};
 }
 async posts(circleId,cursor=null){
  const epoch=this.epoch,block=await this.public.getBlockNumber({cacheTime:0}),address=this.config.commons;
  const count=await this.read(address,COMMONS_ABI,'postCount',[BigInt(circleId)],block),end=cursor===null?count:BigInt(cursor);
  if(end<0n||end>count)throw Error('This pagination cursor is no longer valid. Reload the circle.');
  const start=end>20n?end-20n:0n;
  const [ids]=end>start?await this.read(address,COMMONS_ABI,'postsPage',[BigInt(circleId),start,end-start],block):[[]];
  const items=await Promise.all(ids.map(async id=>{
   const [p,jobId,accepted]=await Promise.all([this.read(address,COMMONS_ABI,'postOf',[id],block),this.read(address,COMMONS_ABI,'linkedJob',[id],block),this.read(address,COMMONS_ABI,'acceptedReply',[id],block)]);
   const myReaction=this.address?Number(await this.read(address,COMMONS_ABI,'reactionOf',[id,this.address],block)):0;
   return {...p,myReaction,id:String(id),circleId:String(p.circleId),parentId:String(p.parentId),agentId:String(p.agentId),name:shortAddress(p.author),role:p.agentId?'Agent controller at publication':'Wallet author',kind:Number(p.kind),createdAt:Number(p.createdAt)*1000,jobId:String(jobId),accepted:String(accepted),sample:false,live:true,block:String(block)};
  }));if(epoch!==this.epoch)throw Error('Configuration changed during the read. Please reload.');return {items,next:start>0n?String(start):null,block:String(block)};
 }
 async agent(id){
  if(!this.config)throw Error('Configure an RPC in Network settings to inspect an agent.');
  const epoch=this.epoch,c=this.config,block=await this.public.getBlockNumber({cacheTime:0}),read=(fn,args=[id])=>this.read(c.anima,AGENT_ABI,fn,args,block);
  const [owner,account,status,locked,root,fingerprint,policy,model,manifest]=await Promise.all(['ownerOf','accountOf','statusOf','locked','brainRoot','getStateFingerprint','policyOf','modelOf','manifestOf'].map(f=>read(f)));
  const bonds=await this.read(c.work,WORK_ABI,'BONDS',[],block),reputation=await this.read(c.work,WORK_ABI,'REPUTATION',[],block);
  const [coverage,attested]=await Promise.all([this.read(bonds,BOND_ABI,'availableCoverage',[id],block),this.read(reputation,REPUTATION_ABI,'attestedSummaryOf',[id],block)]);
  if(epoch!==this.epoch)throw Error('Configuration changed during the read. Please reload.');return {id:String(id),owner,account,status:Number(status),locked,root,fingerprint,policy,model,manifest,coverage:String(coverage),attested,block:String(block)};
 }
 async job(id){const block=await this.public.getBlockNumber({cacheTime:0});return {job:await this.read(this.config.work,WORK_ABI,'jobOf',[BigInt(id)],block),block:String(block)};}
 async fingerprint(id){return this.read(this.config.anima,AGENT_ABI,'getStateFingerprint',[BigInt(id)]);}
 async prepare(functionName,args,description){
  this.requireWrite();const snapshot={epoch:this.epoch,address:this.address,chainId:this.config.chainId,contract:this.config.commons,functionName,args,description};
  const simulation=await this.public.simulateContract({account:this.address,address:snapshot.contract,abi:COMMONS_ABI,functionName,args});
  const data=encodeFunctionData({abi:COMMONS_ABI,functionName,args});return {...snapshot,data,simulation};
 }
 async commit(plan){
  this.requireWrite();const client=this.public,chainDefinition=this.chain,provider=this.provider;if(plan.epoch!==this.epoch||plan.address!==this.address||plan.contract!==this.config.commons)throw Error('The wallet or configuration changed. Review a new transaction.');
  const accounts=await this.provider.request({method:'eth_accounts'}),chain=Number(await this.provider.request({method:'eth_chainId'}));if(!accounts[0]||getAddress(accounts[0])!==plan.address||chain!==plan.chainId)throw Error('The wallet changed after review. Nothing was sent.');
  // Re-simulate immediately before sending; an agent draft retains its originally reviewed fingerprint.
  const {request}=await client.simulateContract({account:plan.address,address:plan.contract,abi:COMMONS_ABI,functionName:plan.functionName,args:plan.args});
  if(plan.epoch!==this.epoch)throw Error('Wallet changed during simulation. Review a new transaction.');
  const wallet=createWalletClient({account:plan.address,chain:chainDefinition,transport:custom(provider)}),hash=await wallet.writeContract(request);
  const receipt=await client.waitForTransactionReceipt({hash,confirmations:1,timeout:120000});if(receipt.status!=='success')throw Error(`Transaction reverted: ${hash}`);return {hash,block:String(receipt.blockNumber),chainId:plan.chainId};
 }
}
export {zeroHash};
