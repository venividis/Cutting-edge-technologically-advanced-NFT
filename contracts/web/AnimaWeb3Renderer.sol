// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IAnimaWeb3View {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
}

/**
 * @title AnimaWeb3Renderer
 * @notice ERC-4804 manual-mode pages for ANIMA agents.
 * @dev A Web3URL client sends the URL path as raw fallback calldata. The fallback response is an
 *      ABI-encoded string, as required by manual mode. Keeping this separate from the immutable
 *      ANIMA diamond lets an existing collection gain a browser without changing token logic.
 */
contract AnimaWeb3Renderer {
    using Strings for address;
    using Strings for uint256;

    IAnimaWeb3View public immutable ANIMA;

    error ZeroAddress();

    constructor(IAnimaWeb3View anima_) {
        if (address(anima_) == address(0)) revert ZeroAddress();
        ANIMA = anima_;
    }

    /// @notice Selects ERC-4804 manual routing, where the complete path is fallback calldata.
    function resolveMode() external pure returns (bytes32) {
        return bytes32("manual");
    }

    /// @notice Serves `/token/{id}/live`; `/` serves a small usage page.
    fallback(bytes calldata path) external returns (bytes memory) {
        if (path.length == 1 && path[0] == bytes1("/")) return abi.encode(_index());
        (bool valid, uint256 tokenId) = _tokenPath(path);
        if (!valid) return abi.encode(_notFound());

        try ANIMA.ownerOf(tokenId) returns (address owner) {
            return abi.encode(_token(tokenId, owner, ANIMA.accountOf(tokenId)));
        } catch {
            return abi.encode(_notFound());
        }
    }

    function _tokenPath(bytes calldata path) private pure returns (bool valid, uint256 tokenId) {
        bytes memory prefix = bytes("/token/");
        bytes memory suffix = bytes("/live");
        if (path.length <= prefix.length + suffix.length) return (false, 0);
        for (uint256 i; i < prefix.length; ++i) if (path[i] != prefix[i]) return (false, 0);
        for (uint256 i; i < suffix.length; ++i) {
            if (path[path.length - suffix.length + i] != suffix[i]) return (false, 0);
        }
        uint256 end = path.length - suffix.length;
        for (uint256 i = prefix.length; i < end; ++i) {
            uint8 digit = uint8(path[i]);
            if (digit < 48 || digit > 57) return (false, 0);
            tokenId = tokenId * 10 + digit - 48;
        }
        return (true, tokenId);
    }

    function _index() private view returns (string memory) {
        return string.concat(
            _head("ANIMA Web3"),
            '<main><p class="eyebrow">ANIMA &middot; ONCHAIN</p><h1>Sovereign agents,<br><i>direct from Ethereum.</i></h1>',
            '<p>Open <code>/token/{id}/live</code> to inspect an agent.</p><p class="mono">Collection ',
            address(ANIMA).toHexString(),
            "</p></main></body></html>"
        );
    }

    function _token(uint256 id, address owner, address account) private view returns (string memory) {
        string memory idText = id.toString();
        return string.concat(
            _head(string.concat("ANIMA #", idText)),
            '<div class="noise"></div><header><a class="brand">&#10022; ANIMA</a><div class="chain"><i></i>', _chainName(), '</div><button id="connect">CONNECT WALLET</button></header>',
            '<main id="app" data-token="', idText, '" data-contract="', address(ANIMA).toHexString(),
            '" data-chain="', block.chainid.toString(), '"><section class="hero"><div><p class="eyebrow">SOVEREIGN AGENT &middot; ',
            idText, '</p><h1>Not merely owned.<br><em>Fully alive.</em></h1><p class="lede">A programmable identity with memory, agency, and an address of its own.</p></div>',
            '<div class="sigil" aria-hidden="true"><span>&#10022;</span><i></i><b></b></div></section>',
            '<nav aria-label="Agent console"><button class="tab active" data-tab="overview">OVERVIEW</button><button class="tab" data-tab="identity">IDENTITY</button><button class="tab" data-tab="control">CONTROL</button><button class="tab" data-tab="advanced">ADVANCED</button></nav>',
            '<section class="panel active" data-panel="overview"><div class="statusline"><span>AGENT #', idText,
            '</span><strong id="status">SYNCING</strong></div><div class="grid"><article><label>OWNER</label><code id="owner">', owner.toHexString(),
            '</code><button class="copy" data-copy="owner">COPY</button></article><article><label>ERC-6551 WEB3 ACCOUNT</label><code id="account">', account.toHexString(),
            '</code><button class="copy" data-copy="account">COPY</button></article><article><label>COLLECTION</label><code id="collection">', address(ANIMA).toHexString(),
            '</code><button class="copy" data-copy="collection">COPY</button></article><article><label>STATE FINGERPRINT</label><code id="fingerprint">SYNCING...</code></article></div>',
            '<div class="capabilities"><h2>Everything this being carries</h2><div class="chips"><span>ERC-721 IDENTITY</span><span>ERC-6551 WALLET</span><span>ENCRYPTED MEMORY</span><span>AUTONOMY POLICY</span><span>GUARDIAN</span><span>REPUTATION</span><span>VALIDATION</span><span>BONDS</span><span>MARKET</span><span>LEASES</span><span>OMNICHAIN</span><span>PAID COMMS</span></div></div></section>',
            '<section class="panel" data-panel="identity"><div class="grid"><article><label>MODEL</label><code id="model">SYNCING...</code></article><article><label>MEMORY ROOT</label><code id="brain">SYNCING...</code></article><article><label>MEMORY EPOCH</label><code id="epoch">SYNCING...</code></article><article><label>SEAL POLICY</label><code id="seal">SYNCING...</code></article><article><label>MANIFEST URI</label><code id="uri">SYNCING...</code></article><article><label>TRANSFER LOCK</label><code id="locked">SYNCING...</code></article></div></section>',
            '<section class="panel" data-panel="control"><div class="actions"><article><h3>WEB3 ACCOUNT</h3><p>Materialize the reserved ERC-6551 address onchain.</p><button class="action" data-action="deploy">ACTIVATE ACCOUNT</button></article><article><h3>LIFECYCLE</h3><p>Awaken, pause, or retire this agent. Every request is simulated first.</p><div class="row"><button class="action" data-status="1">AWAKEN</button><button class="action secondary" data-status="2">PAUSE</button><button class="action danger" data-status="4">RETIRE</button></div></article><article><h3>GUARDIAN</h3><p>Appoint an emergency pause authority.</p><input id="guardian" placeholder="0x guardian address"><button class="action secondary" data-action="guardian">SET GUARDIAN</button></article><article><h3>OPERATOR</h3><p>Delegate controller permissions without transferring ownership.</p><input id="operator" placeholder="0x operator address"><div class="row"><button class="action secondary" data-action="operator-on">ALLOW</button><button class="action secondary" data-action="operator-off">REVOKE</button></div></article></div></section>',
            '<section class="panel" data-panel="advanced"><div class="advanced"><p class="eyebrow">POWER USER CONSOLE</p><h2>Simulate raw ANIMA calldata</h2><p>Paste ABI-encoded calldata. The console performs an <code>eth_call</code> first and only then asks your wallet to sign.</p><label>CALLDATA</label><textarea id="calldata" placeholder="0x..."></textarea><button class="action" data-action="raw">SIMULATE &amp; EXECUTE</button><pre id="result">Ready. No transaction is sent without wallet confirmation.</pre></div></section>',
            '<footer><span>ERC-4804 ONCHAIN INTERFACE</span><a id="explorer" target="_blank" rel="noreferrer">VIEW PROVENANCE &#8599;</a></footer></main><div id="toast" role="status" aria-live="polite"></div>',
            _script(), "</body></html>"
        );
    }

    function _chainName() private view returns (string memory) {
        if (block.chainid == 84532) return "BASE SEPOLIA";
        if (block.chainid == 11155111) return "ETHEREUM SEPOLIA";
        return string.concat("CHAIN ", block.chainid.toString());
    }

    function _notFound() private pure returns (string memory) {
        return string.concat(_head("ANIMA - Not found"), '<main><p class="eyebrow">ANIMA</p><h1>Agent not found.</h1>',
            '<p>Use <code>/token/{id}/live</code>.</p></main></body></html>');
    }

    function _head(string memory title) private pure returns (string memory) {
        return string.concat(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            "<title>", title,
            '</title><style>', _style(), '</style></head><body>'
        );
    }

    function _style() private pure returns (string memory) {
        return string.concat(
            ':root{color-scheme:dark;--ink:#f4f0e8;--muted:#918a9e;--violet:#b999ff;--line:#ffffff18;--panel:#0d0c13cc}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;background:#07060b;color:var(--ink);font:15px Inter,ui-sans-serif,system-ui,sans-serif;overflow-x:hidden}body:before{content:"";position:fixed;inset:0;background:radial-gradient(circle at 75% 8%,#7046c52b,transparent 34%),radial-gradient(circle at 15% 55%,#3c77bd1d,transparent 38%);pointer-events:none}.noise{position:fixed;inset:0;opacity:.035;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg viewBox=%270 0 180 180%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%27.9%27 numOctaves=%274%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E")}header{height:74px;display:flex;align-items:center;gap:24px;padding:0 clamp(20px,5vw,72px);border-bottom:1px solid var(--line);position:relative}.brand{font:700 17px Georgia,serif;letter-spacing:.18em}.brand:first-letter{color:var(--violet)}.chain{margin-left:auto;font:10px ui-monospace,monospace;letter-spacing:.14em;color:#aaa3b6}.chain i{display:inline-block;width:6px;height:6px;border-radius:50%;background:#62dda2;box-shadow:0 0 12px #62dda2;margin-right:8px}button,input,textarea{font:inherit}button{min-height:44px;border:1px solid #ffffff25;background:#ffffff09;color:var(--ink);padding:0 18px;letter-spacing:.1em;font-size:11px;cursor:pointer;transition:.2s}button:hover{border-color:var(--violet);background:#b999ff16;transform:translateY(-1px)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--violet);outline-offset:3px}#connect{border-color:#b999ff66}main{position:relative;width:min(1180px,92vw);margin:auto}.hero{min-height:480px;display:grid;grid-template-columns:1.3fr .7fr;align-items:center;border-bottom:1px solid var(--line)}.eyebrow,label{font:10px ui-monospace,monospace;letter-spacing:.2em;color:var(--violet)}h1{font:400 clamp(48px,7vw,94px)/.93 Georgia,serif;margin:24px 0}em{font-weight:400;color:#cdbcf2}.lede{max-width:540px;color:#a8a1b1;font:18px/1.7 Georgia,serif}.sigil{width:min(310px,32vw);aspect-ratio:1;border:1px solid #b999ff55;border-radius:50%;display:grid;place-items:center;position:relative;box-shadow:0 0 100px #6843a233,inset 0 0 80px #6843a222}.sigil:before,.sigil:after,.sigil i,.sigil b{content:"";position:absolute;inset:14%;border:1px solid #b999ff44;border-radius:50%;transform:rotate(60deg)}.sigil:after{transform:rotate(-60deg)}.sigil i{border-radius:0;transform:rotate(45deg);inset:25%}.sigil b{inset:38%;background:#b999ff16}.sigil span{font-size:54px;color:#d8c8ff;text-shadow:0 0 30px #a273ff}nav{display:flex;gap:0;border-bottom:1px solid var(--line);overflow:auto}.tab{border:0;border-bottom:2px solid transparent;background:none;padding:0 24px;height:62px;white-space:nowrap}.tab.active{color:var(--violet);border-color:var(--violet)}.panel{display:none;padding:48px 0 72px}.panel.active{display:block}.statusline{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;color:var(--muted);font:11px ui-monospace,monospace;letter-spacing:.15em}.statusline strong{color:#77e7aa;border:1px solid #77e7aa44;padding:8px 12px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.grid article,.actions article,.advanced,.capabilities{position:relative;padding:26px;border:1px solid var(--line);background:var(--panel);min-width:0}.grid label{display:block;margin-bottom:14px}.grid code{display:block;color:#ddd7e8;font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;padding-right:60px}.copy{position:absolute;right:15px;top:18px;min-height:30px;padding:0 9px;font-size:9px}.capabilities{margin-top:12px}.capabilities h2,.advanced h2{font:400 30px Georgia,serif;margin:0 0 22px}.chips{display:flex;flex-wrap:wrap;gap:8px}.chips span{padding:9px 12px;border:1px solid #ffffff14;color:#aaa2b5;font:9px ui-monospace,monospace;letter-spacing:.12em}.actions{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.actions h3{font:12px ui-monospace,monospace;letter-spacing:.16em;color:var(--violet);margin:0}.actions p,.advanced p{color:var(--muted);line-height:1.6}.row{display:flex;gap:8px;flex-wrap:wrap}.action{background:#b999ff;color:#100c18;border-color:#b999ff;font-weight:800;margin-top:14px}.action.secondary{background:#ffffff09;color:var(--ink);border-color:#ffffff25}.action.danger{background:#ff668d;color:#19050a;border-color:#ff668d}input,textarea{width:100%;background:#050409;border:1px solid #ffffff20;color:#fff;padding:13px;margin-top:10px;font:12px ui-monospace,monospace}textarea{min-height:100px;resize:vertical}.advanced{max-width:820px}.advanced label{display:block;margin-top:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#050409;padding:18px;border:1px solid #ffffff12;color:#9eeca8;font:12px/1.6 ui-monospace,monospace}footer{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font:10px ui-monospace,monospace;letter-spacing:.13em}a{color:inherit;text-decoration:none}#toast{position:fixed;right:24px;bottom:24px;max-width:380px;padding:16px 20px;background:#17131f;border:1px solid #b999ff66;opacity:0;pointer-events:none;transform:translateY(140%);transition:.3s;z-index:9}#toast.show{opacity:1;transform:none}@media(max-width:720px){header{padding:0 16px}.chain{display:none}main{width:min(94vw,620px)}.hero{grid-template-columns:1fr;min-height:620px;padding:60px 0}.sigil{width:210px;justify-self:center}.grid,.actions{grid-template-columns:1fr}nav{margin:0 -3vw}.tab{padding:0 18px}footer{gap:20px;flex-direction:column}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}'
        );
    }

    function _script() private pure returns (string memory) {
        return string.concat(
            '<script>',
            'const app=document.querySelector("#app"),id=BigInt(app.dataset.token),address=app.dataset.contract,chainId=Number(app.dataset.chain);const rpc={11155111:"https://ethereum-sepolia-rpc.publicnode.com",84532:"https://sepolia.base.org"}[chainId];const explorer=chainId===84532?"https://sepolia.basescan.org":"https://sepolia.etherscan.io";document.querySelector("#explorer").href=`${explorer}/token/${address}?a=${id}`;',
            'const chain={id:chainId,name:chainId===84532?"Base Sepolia":"Ethereum Sepolia",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18}};let user;const selectors={ownerOf:"6352211e",accountOf:"8f4e4321",statusOf:"ad35efd4",getStateFingerprint:"f5112315",modelOf:"57759fc6",brainRoot:"870b72c7",brainEpoch:"fd30a23a",sealPolicyOf:"50026a43",tokenURI:"c87b56dd",locked:"b45a3c0e",deployAccount:"171602fb",setStatus:"d896dd64",setGuardian:"c02f5582",setOperator:"16d4b2ed"};',
            'const el=x=>document.querySelector(x),toast=m=>{const t=el("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3200)},short=x=>x?`${x.slice(0,10)}...${x.slice(-8)}`:"-",word=x=>BigInt(x).toString(16).padStart(64,"0"),addressWord=x=>x.toLowerCase().replace(/^0x/,"").padStart(64,"0"),statuses=["DORMANT","AWAKE","PAUSED","DISPUTED","RETIRED"],seals=["NONE","COMMITTED","RE-KEYED","SEALED TEE","SEALED ZK","THRESHOLD"];async function request(method,params){const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});if(!response.ok)throw Error(`RPC HTTP ${response.status}`);const body=await response.json();if(body.error)throw Error(body.error.message);return body.result}const call=data=>request("eth_call",[{to:address,data},"latest"]),at=(x,n)=>x.slice(2+n*64,66+n*64),number=(x,n=0)=>BigInt(`0x${at(x,n)}`),addr=x=>`0x${at(x,0).slice(24)}`,text=(x,n=0)=>{const offset=Number(number(x,n))/32,length=Number(number(x,offset));const hex=x.slice(2+(offset+1)*64,2+(offset+1)*64+length*2);return new TextDecoder().decode(Uint8Array.from(hex.match(/../g)||[],b=>parseInt(b,16)))};async function read(fn){const raw=await call(`0x${selectors[fn]}${word(id)}`);if(fn==="ownerOf"||fn==="accountOf")return addr(raw);if(fn==="statusOf"||fn==="brainEpoch"||fn==="sealPolicyOf")return number(raw);if(fn==="locked")return number(raw)!==0n;if(fn==="tokenURI")return text(raw);if(fn==="modelOf")return text(raw,4);return `0x${at(raw,0)}`}',
            'async function refresh(){const names=["ownerOf","accountOf","statusOf","getStateFingerprint","modelOf","brainRoot","brainEpoch","sealPolicyOf","tokenURI","locked"];const v=await Promise.all(names.map(n=>read(n).catch(()=>null)));el("#owner").textContent=v[0]||"UNAVAILABLE";el("#account").textContent=v[1]||"UNAVAILABLE";el("#status").textContent=statuses[Number(v[2])]||String(v[2]);el("#fingerprint").textContent=v[3]||"UNAVAILABLE";el("#model").textContent=v[4]||"UNDECLARED";el("#brain").textContent=v[5]||"EMPTY";el("#epoch").textContent=String(v[6]??0);el("#seal").textContent=seals[Number(v[7])]||`UNKNOWN (${String(v[7])})`;el("#uri").textContent=v[8]||"UNSET";el("#locked").textContent=v[9]?"LOCKED":"TRANSFERABLE"}refresh();',
            'document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab,.panel").forEach(x=>x.classList.remove("active"));b.classList.add("active");el(`[data-panel=${b.dataset.tab}]`).classList.add("active")});document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(el(`#${b.dataset.copy}`).textContent);toast("Copied to clipboard")});',
            'async function connect(){if(!window.ethereum)return toast("Install an EIP-1193 wallet to continue");[user]=await window.ethereum.request({method:"eth_requestAccounts"});if(Number(await window.ethereum.request({method:"eth_chainId"}))!==chainId){try{await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:`0x${chainId.toString(16)}`}]})}catch{await window.ethereum.request({method:"wallet_addEthereumChain",params:[{chainId:`0x${chainId.toString(16)}`,chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:[rpc],blockExplorerUrls:[explorer]}]})}}el("#connect").textContent=short(user);return user}el("#connect").onclick=connect;',
            'async function sendData(data,output=el("#result")){try{await connect();output.textContent="Simulating...";await window.ethereum.request({method:"eth_call",params:[{from:user,to:address,data},"latest"]});output.textContent="Simulation passed. Confirm in wallet.";const hash=await window.ethereum.request({method:"eth_sendTransaction",params:[{from:user,to:address,data}]});output.textContent=`Submitted ${hash}\nWaiting for confirmation...`;let receipt;while(!receipt){await new Promise(r=>setTimeout(r,2000));receipt=await request("eth_getTransactionReceipt",[hash])}if(receipt.status!=="0x1")throw Error("Transaction reverted");output.textContent=`Confirmed in block ${BigInt(receipt.blockNumber)}\n${explorer}/tx/${hash}`;await refresh()}catch(e){output.textContent=e.message||String(e);toast(e.message||"Transaction refused")}}const encode=(fn,args)=>`0x${selectors[fn]}${args.join("")}`;document.querySelectorAll("[data-status]").forEach(b=>b.onclick=()=>sendData(encode("setStatus",[word(id),word(b.dataset.status)])));',
            'document.querySelector("[data-action=deploy]").onclick=()=>sendData(encode("deployAccount",[word(id)]));document.querySelector("[data-action=guardian]").onclick=()=>sendData(encode("setGuardian",[word(id),addressWord(el("#guardian").value)]));document.querySelector("[data-action=operator-on]").onclick=()=>sendData(encode("setOperator",[word(id),addressWord(el("#operator").value),word(1)]));document.querySelector("[data-action=operator-off]").onclick=()=>sendData(encode("setOperator",[word(id),addressWord(el("#operator").value),word(0)]));document.querySelector("[data-action=raw]").onclick=()=>{const data=el("#calldata").value.trim();if(!/^0x(?:[0-9a-fA-F]{2})+$/.test(data))return el("#result").textContent="Enter valid even-length hex calldata beginning with 0x.";sendData(data)};</script>'
        );
    }
}
