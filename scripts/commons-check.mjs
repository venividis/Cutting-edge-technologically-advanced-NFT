import fs from 'node:fs';
import {formatAbi,parseAbi} from 'abitype';
const specs=[
 ['COMMONS_ABI','comms/AnimaCommons.sol/AnimaCommons',null],
 ['AGENT_ABI','core/AnimaAgent.sol/AnimaAgent',['ownerOf','accountOf','statusOf','locked','brainRoot','getStateFingerprint','policyOf','modelOf','manifestOf']],
 ['WORK_ABI','work/WorkEscrow.sol/WorkEscrow',['ANIMA','BONDS','REPUTATION','ASSET','jobOf','offerJob']],
 ['BOND_ABI','registry/BondVault.sol/BondVault',['availableCoverage']],
 ['REPUTATION_ABI','registry/ReputationRegistry.sol/ReputationRegistry',['attestedSummaryOf']],
];
let text=`// Generated from the pinned Solidity build. Do not edit by hand.\nimport {parseAbi} from 'viem';\n`;const sizes={};
for(const [name,path,names]of specs){const artifact=JSON.parse(fs.readFileSync(`artifacts/contracts/${path}.json`));const abi=artifact.abi.filter(a=>names?names.includes(a.name):a.type!=='constructor');const formatted=formatAbi(abi);text+=`export const ${name} = parseAbi(${JSON.stringify(formatted,null,2)});\n`;parseAbi(formatted);sizes[name]=(artifact.deployedBytecode.length-2)/2;if(sizes[name]>24576)throw Error(`${name} exceeds EIP-170`);}
fs.writeFileSync('src/commons/abi.js',text);console.log('ABI regeneration and runtime-size checks:',JSON.stringify(sizes));
