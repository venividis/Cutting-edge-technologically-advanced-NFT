/** Pure presentation model. No wallet authority or financial side effects. */
export const VERSION = 1;
export const KINDS = ['Conversation', 'Question', 'Work request', 'Progress'];
export const SECTIONS = [
  {id:'home',label:'Sanctuary',hint:'Your place to begin',icon:'sun'},
  {id:'circles',label:'Circles',hint:'People around a purpose',icon:'circles'},
  {id:'work',label:'Work atelier',hint:'Turn an idea into a result',icon:'work'},
  {id:'agents',label:'Observatory',hint:'Know your agents',icon:'spark'},
  {id:'tools',label:'Tool garden',hint:'Useful, with boundaries',icon:'shield'},
  {id:'saved',label:'Your library',hint:'Keep what matters',icon:'book'},
];
export const emptyState = () => ({version:VERSION,joined:['1'],saved:[],blocked:[],drafts:{},read:{},goal:'Finish one useful thing with my circle.',flat:false,motion:true,posts:[],circles:[],reactions:{},resolved:{}});
export function restoreState(raw) {
  const s = emptyState();
  try {
    const x = JSON.parse(raw || '{}');
    if (x.version !== VERSION) return s;
    for (const k of ['joined','saved','blocked']) if (Array.isArray(x[k])) s[k]=[...new Set(x[k].filter(v=>typeof v==='string'&&v.length<240))].slice(0,500);
    for (const k of ['flat','motion']) if(typeof x[k]==='boolean')s[k]=x[k];
    if(typeof x.goal==='string')s.goal=x.goal.slice(0,160);
    if(x.drafts&&typeof x.drafts==='object')for(const [k,v]of Object.entries(x.drafts).slice(0,80))if(/^\d+$/.test(k)&&typeof v==='string')s.drafts[k]=v.slice(0,4096);
    if(x.read&&typeof x.read==='object')for(const [k,v]of Object.entries(x.read).slice(0,80))if(/^[a-zA-Z0-9:._-]{1,240}$/.test(k)&&Number.isFinite(v))s.read[k]=v;
    if(Array.isArray(x.posts))s.posts=x.posts.filter(isLocalPost).slice(-300);
    if(Array.isArray(x.circles))s.circles=x.circles.filter(c=>c&&typeof c.id==='string'&&/^\d+$/.test(c.id)&&typeof c.name==='string'&&byteLength(c.name)<=64&&typeof c.purpose==='string'&&byteLength(c.purpose)<=256&&typeof c.rules==='string'&&byteLength(c.rules)<=2048&&c.steward==='you').slice(-50);
    if(x.reactions&&typeof x.reactions==='object')for(const [k,v]of Object.entries(x.reactions))if(/^local-\d+$|^sample-\d+$/.test(k)&&Number.isInteger(v)&&v>=0&&v<=3)s.reactions[k]=v;
    if(x.resolved&&typeof x.resolved==='object')for(const [k,v]of Object.entries(x.resolved))if(typeof v==='string'&&v.length<80)s.resolved[k]=v;
  } catch { /* Corrupt or blocked browser storage must not prevent navigation. */ }
  return s;
}
function isLocalPost(p){return p&&typeof p.id==='string'&&/^local-\d+$/.test(p.id)&&typeof p.body==='string'&&byteLength(p.body)<=1024&&typeof p.circleId==='string'&&typeof p.author==='string'&&Number.isFinite(p.createdAt)&&Number.isInteger(p.kind)&&p.kind>=0&&p.kind<=3&&p.sample===false&&p.local===true;}
export function byteLength(value){return new TextEncoder().encode(value).length;}
export function validateBody(body){if(typeof body!=='string'||!body.trim())throw Error('Write a message first.');if(byteLength(body)>1024)throw Error('Keep this message within 1,024 UTF-8 bytes.');return body.trim();}
export function escapeHTML(value=''){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function safeHttp(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)return null;return u.href;}catch{return null;}}
export function parseTokenId(value){if(!/^[1-9]\d{0,77}$/.test(String(value)))throw Error('Use a positive whole-number token ID.');const v=BigInt(value);if(v>2n**256n-1n)throw Error('Token ID is too large.');return v;}
export function toggle(values,value){return values.includes(value)?values.filter(x=>x!==value):[...values,value];}
export function visiblePosts(posts,{circleId=null,blocked=[],query='',kind=null,rootsOnly=true,saved=null}={}){
 const q=String(query).trim().toLocaleLowerCase();
 return posts.filter(p=>!p.hidden&&!p.withdrawn&&(!circleId||p.circleId===circleId)&&!blocked.includes(p.author)&&(!rootsOnly||!p.parentId||p.parentId==='0')&&(kind===null||p.kind===kind)&&(!saved||saved.includes(p.id))&&(!q||`${p.body} ${p.name||''}`.toLocaleLowerCase().includes(q))).sort((a,b)=>b.createdAt-a.createdAt||String(b.id).localeCompare(String(a.id)));
}
export function catchUp(posts,joined,read,blocked=[]){return visiblePosts(posts,{blocked}).filter(p=>joined.includes(p.circleId)&&p.createdAt>(read[p.circleId]||0)).slice(0,5);}
export function workBrief({body,agentId,amount,coverage,deadline,reviewHours}){
 const text=validateBody(body);const id=parseTokenId(agentId);
 for(const v of [amount,coverage])if(!/^\d+(\.\d{1,6})?$/.test(String(v)))throw Error('Use a non-negative amount with at most 6 decimal places.');
 const due=Date.parse(deadline);const h=Number(reviewHours);
 if(!Number.isFinite(due)||due<=Date.now())throw Error('Choose a future deadline.');
 if(!Number.isInteger(h)||h<1||h>720)throw Error('Review window must be 1–720 whole hours.');
 if(Number(amount)<=0)throw Error('Payment must be greater than zero.');
 return {body:text,agentId:id.toString(),amount:String(amount),coverage:String(coverage),deadline:Math.floor(due/1000),reviewWindow:h*3600};
}
export function sampleData(){
 const base=Date.UTC(2026,8,4,18);
 const circles=[
  {id:'1',name:'The Foundry',purpose:'Build useful things, together.',topic:'BUILD & LEARN',color:'#d8b882',members:3,steward:'sample-imani',rules:'Be specific. Share evidence. Ask before promoting. No financial promises.',inviteOnly:false},
  {id:'2',name:'Quiet Intelligence',purpose:'Agents that help without overstepping.',topic:'AGENTS & RESEARCH',color:'#8cbfa9',members:2,steward:'sample-noor',rules:'Label agent-generated work. Explain limitations. Never post secrets.',inviteOnly:false},
  {id:'3',name:'The Commons',purpose:'A good question can be a beginning.',topic:'MEET & EXPLORE',color:'#a8add1',members:3,steward:'sample-eli',rules:'Welcome newcomers. Keep critique kind and useful. Respect consent.',inviteOnly:false}
 ];
 const posts=[
  {id:'sample-1',circleId:'1',parentId:'0',author:'sample-imani',name:'Imani',role:'Human · sample',body:'What would make an agent genuinely useful in your day? I’m building a research companion that shows its sources before it asks for your trust.',kind:1,createdAt:base+240000,sample:true,replies:0},
  {id:'sample-2',circleId:'1',parentId:'0',author:'sample-eli',name:'Eli',role:'Human · sample',body:'A small win: our onboarding checklist now explains every permission in plain language. No more mystery signatures. The next step is testing it with someone new.',kind:3,createdAt:base+120000,sample:true,replies:0},
  {id:'sample-3',circleId:'2',parentId:'0',author:'sample-noor',name:'Noor',role:'Human · sample',body:'Looking for a collaborator to compare three public research sources. Deliverable: a one-page synthesis, citations, and an honest note about disagreements.',kind:2,createdAt:base,sample:true,replies:0},
  {id:'sample-4',circleId:'3',parentId:'0',author:'sample-imani',name:'Imani',role:'Human · sample',body:'You do not need to own an agent to belong here. Introduce the thing you’re curious about, not your portfolio.',kind:0,createdAt:base-240000,sample:true,replies:0}
 ];
 return {circles,posts};
}
