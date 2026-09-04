/** Disposable, loopback-only EVM harness. No external chain or private-key input. */
import http from 'node:http';
import fs from 'node:fs';
import {deployProtocol,mintAgent,ZERO32} from '../test/helpers.js';
const p=await deployProtocol();
const commons=await p.viem.deployContract('AnimaCommons',[p.anima.address,p.escrow.address]);
await commons.write.createCircle(['The Foundry','Make useful things together','Show evidence. No secrets. Be kind.',false,0],{account:p.alice.account});
await commons.write.publish([1n,0n,0n,ZERO32,1,'What useful thing should we build together?'],{account:p.alice.account});
// Exercise latest-page pagination, not only an almost-empty circle.
for(let i=0;i<21;i++)await commons.write.publish([1n,0n,0n,ZERO32,3,`Local test progress ${i+1}`],{account:p.alice.account});
await mintAgent(p,p.bob.account.address);
await p.usdc.write.mint([p.alice.account.address,100_000_000n]);
const port=18745;
const config={chainId:31337,rpc:`http://127.0.0.1:${port}`,anima:p.anima.address,work:p.escrow.address,commons:commons.address,account:p.alice.account.address,agentOwner:p.bob.account.address,asset:p.usdc.address};
fs.writeFileSync(process.env.COMMONS_LOCAL_CONFIG || 'anima-local-config.json',JSON.stringify(config,null,2));
const methods=new Set(['eth_chainId','eth_call','eth_getCode','eth_getBalance','eth_blockNumber','eth_getBlockByNumber','eth_sendTransaction','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getTransactionCount','eth_estimateGas','eth_feeHistory','eth_gasPrice','eth_maxPriorityFeePerGas','net_version']);
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');
 if(req.method==='OPTIONS'){res.end();return;}
 if(req.method==='GET'&&req.url==='/config'){res.end(JSON.stringify(config));return;}
 if(req.method!=='POST'){res.statusCode=405;res.end('{}');return;}
 let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000){res.statusCode=413;res.end('{}');return;}}
 try{const input=JSON.parse(body);const run=async(x:any)=>{if(!methods.has(x.method))return {jsonrpc:'2.0',id:x.id,error:{code:-32601,message:'Test RPC method not allowed'}};try{const result=await p.connection.provider.request({method:x.method,params:x.params||[]});return {jsonrpc:'2.0',id:x.id,result}}catch(e:any){return {jsonrpc:'2.0',id:x.id,error:{code:e.code||-32000,message:e.message,data:e.data}}}};res.end(JSON.stringify(Array.isArray(input)?await Promise.all(input.map(run)):await run(input)));}
 catch{res.statusCode=400;res.end('{}');}
});
server.listen(port,'127.0.0.1',()=>console.log('Disposable Commons EVM ready on loopback',config));
