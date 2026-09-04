"""Chromium functional checks in an in-memory document (runner navigation is restricted).
Uses a clearly test-only storage fixture and EIP-1193 shim. RPC transactions execute
against the real disposable Hardhat EVM; this is NOT a real extension-wallet test.
Run: python scripts/commons-browser-check.py /mnt/data/ANIMA_Sanctuary_3D.html
"""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json,sys,urllib.request,time,os
HTML=Path(sys.argv[1] if len(sys.argv)>1 else '/mnt/data/ANIMA_Sanctuary_3D.html').read_text()
CONFIG=Path(os.environ.get('COMMONS_LOCAL_CONFIG','anima-local-config.json'))
OUT=Path(os.environ.get('COMMONS_TEST_OUTPUT','.'));OUT.mkdir(parents=True,exist_ok=True)
LIVE_BODY=f'A browser-originated post committed to the actual local EVM. Run {time.time_ns()}.'
results=[]
def check(name,condition):
    if not condition: raise AssertionError(name)
    results.append({'check':name,'passed':True})
def install_storage(page,data=None):
    page.evaluate('''(seed)=>{let values=seed||{};window.__storage=values;
      Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>values[k]??null,setItem:(k,v)=>values[k]=String(v),removeItem:k=>delete values[k],clear:()=>{for(const k of Object.keys(values))delete values[k]}}});
    }''',data or {})
def click(page,action,extra=''):
    page.locator(f'[data-action="{action}"]{extra}').first.click()
def nav(page,id):page.locator(f'.navbutton[data-id="{id}"]').click()
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1440,'height':1040});errors=[];requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:requests.append(r.url));install_storage(page)
    page.set_content(HTML,wait_until='domcontentloaded');page.wait_for_timeout(400)
    check('launch renders all six native destinations',page.locator('.navbutton[data-id]').count()==6)
    check('initial exploration makes no network request',len(requests)==0)
    check('no unsolicited wallet prompt',page.get_by_text('Connect wallet',exact=True).count()==1)
    renderer=page.locator('canvas').get_attribute('data-renderer')
    check('3D geometry renders through an available path',renderer in ('projected-3d','webgl'))
    check('desktop has no horizontal overflow',not page.evaluate('document.documentElement.scrollWidth>innerWidth'))
    page.screenshot(path=str(OUT/'ANIMA_Sanctuary_3D_Desktop.png'),full_page=True)
    click(page,'flat');check('flat mode is an explicit equivalent', 'flat' in page.locator('#hero').get_attribute('class'))
    click(page,'flat');check('3D view can be restored','flat' not in page.locator('#hero').get_attribute('class'))
    nav(page,'circles');click(page,'enter-circle','[data-id="1"]')
    check('circle displays public rules',page.get_by_text('Be specific. Share evidence. Ask before promoting. No financial promises.',exact=False).count()>0)
    form=page.locator('form[data-form="post"]');form.locator('textarea').fill('How can we make onboarding genuinely welcoming?');form.locator('select[name="kind"]').select_option('1');form.locator('[type="submit"]').click()
    check('a local question is clearly labeled',page.locator('.post').filter(has_text='How can we make onboarding').get_by_text('Local only',exact=True).count()==1)
    state=page.evaluate('JSON.parse(__storage["anima.commons.explore.v1"])');postid=state['posts'][-1]['id']
    click(page,'save',f'[data-id="{postid}"]');nav(page,'saved')
    check('library saves a usable reference',page.locator('.post').filter(has_text='How can we make onboarding').count()==1)
    click(page,'thread',f'[data-id="{postid}"]');page.locator('#dialog textarea[name="body"]').fill('Show one meaningful action before asking for a wallet.');page.locator('#dialog form [type="submit"]').click()
    check('threaded reply preserves context',page.locator('#dialog .reply').count()==1)
    click(page,'accept');check('author can select a helpful reply',page.locator('#dialog').get_by_text('The author selected a helpful reply.',exact=False).count()==1)
    click(page,'close');nav(page,'circles');click(page,'enter-circle','[data-id="1"]')
    form=page.locator('form[data-form="post"]');form.locator('textarea').fill('<img src=x onerror="window.__xss=1">');form.locator('[type="submit"]').click()
    check('untrusted post HTML is text, never executable',page.evaluate('window.__xss===undefined') and page.locator('img').count()==0)
    page.locator('#circle-search').fill('welcoming');check('search filters the loaded conversations',page.locator('#posts .post').count()==1)
    page.locator('#circle-search').fill('');click(page,'post-options','[data-id="sample-1"]');click(page,'block');check('muting removes an author from circle view',page.locator('#posts .post').filter(has_text='Imani').count()==0)
    nav(page,'home');check('muting also removes their catchup items',page.locator('.digest-item').filter(has_text='What would make an agent').count()==0)
    click(page,'mark-read');check('finite catchup ends without infinite scroll',page.get_by_text('You’re all caught up.',exact=True).count()==1)
    nav(page,'work');form=page.locator('#brief-form');form.locator('[name="body"]').fill('Compare three sources and cite disagreements.');form.locator('[name="amount"]').fill('10');form.locator('[type="submit"]').click()
    check('brief review is explicitly not funded',page.locator('#dialog').get_by_text('Draft only. Nothing was signed, offered, or funded.',exact=True).count()==1)
    check('work brief includes a reproducible hash','specHash' in page.locator('#dialog pre').inner_text());click(page,'close')
    nav(page,'agents');page.locator('#agent-form button[type="submit"]').click();check('unconfigured live inspection fails closed','Configure' in page.locator('#toast').inner_text())
    nav(page,'circles');click(page,'enter-circle','[data-id="1"]');page.locator('textarea[name="body"]').fill('A recoverable unfinished thought');nav(page,'home');nav(page,'circles');click(page,'enter-circle','[data-id="1"]')
    check('draft survives route changes',page.locator('textarea[name="body"]').input_value()=='A recoverable unfinished thought')
    storage=page.evaluate('window.__storage');restored=b.new_page(viewport={'width':1440,'height':1040});install_storage(restored,storage);restored.set_content(HTML,wait_until='domcontentloaded');nav(restored,'circles');click(restored,'enter-circle','[data-id="1"]')
    check('serialized local state restores drafts and posts',restored.locator('textarea[name="body"]').input_value()=='A recoverable unfinished thought' and restored.locator('.post').filter(has_text='How can we make onboarding').count()==1)
    click(page,'settings');page.locator('#pref-motion').uncheck();check('motion preference is stored',not page.evaluate('JSON.parse(__storage["anima.commons.explore.v1"]).motion'));click(page,'close')
    check('keyboard focus styles remain reachable',page.locator('.navbutton').first.evaluate('(e)=>{e.focus();return document.activeElement===e}'))
    mobile=b.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True);install_storage(mobile);mobile.set_content(HTML,wait_until='domcontentloaded');mobile.wait_for_timeout(300)
    check('mobile layout has no horizontal overflow',not mobile.evaluate('document.documentElement.scrollWidth>innerWidth'))
    check('all mobile navigation targets meet 24 CSS pixels',mobile.locator('.navbutton[data-id]').evaluate_all('(es)=>es.every(e=>{let b=e.getBoundingClientRect();return b.width>=24&&b.height>=24})'))
    mobile.screenshot(path=str(OUT/'ANIMA_Sanctuary_3D_Mobile.png'),full_page=True)
    nav(mobile,'circles');click(mobile,'enter-circle','[data-id="1"]');check('mobile reaches same circle composer',mobile.locator('form[data-form="post"]').count()==1)
    mobile.evaluate('window.scrollTo(0,0)');mobile.wait_for_timeout(100)
    mobile.screenshot(path=str(OUT/'ANIMA_Commons_Mobile.png'),full_page=True)
    fresh=b.new_page(viewport={'width':1440,'height':1000});install_storage(fresh);fresh.set_content(HTML,wait_until='domcontentloaded');nav(fresh,'circles');click(fresh,'enter-circle','[data-id="1"]');fresh.evaluate('window.scrollTo(0,0)');fresh.wait_for_timeout(100);fresh.screenshot(path=str(OUT/'ANIMA_Commons_Desktop.png'),full_page=True)
    check('no uncaught UI exception in local workflows',not errors)
    if not CONFIG.exists(): raise RuntimeError('Start the local EVM first and point COMMONS_LOCAL_CONFIG at its JSON config; live checks cannot be skipped.')
    if CONFIG.exists():
      config=json.loads(CONFIG.read_text());rpc_calls=[];transactions=[];receipts=[]
      def rpc(body):
        payload=json.loads(body);rpc_calls.append(payload)
        req=urllib.request.Request(config['rpc'],data=body.encode(),headers={'Content-Type':'application/json'})
        response=urllib.request.urlopen(req,timeout=25).read().decode()
        parsed=json.loads(response)
        for request,result in zip(payload if isinstance(payload,list) else [payload],parsed if isinstance(parsed,list) else [parsed]):
            if request['method']=='eth_sendTransaction' and result.get('result'):transactions.append(result['result'])
            if request['method']=='eth_getTransactionReceipt' and result.get('result'):receipts.append(result['result'])
        return response
      live=b.new_page(viewport={'width':1440,'height':1050});live.on('pageerror',lambda e:print('LIVE ERROR',str(e),flush=True));install_storage(live);live.expose_function('__testRpc',rpc)
      live.evaluate('''(c)=>{window.__walletEvents={};window.__walletCalls=[];
        window.ethereum={request:async q=>{__walletCalls.push(q.method);if(q.method==='eth_requestAccounts'||q.method==='eth_accounts')return [c.account];if(q.method==='eth_chainId')return '0x7a69';let r=JSON.parse(await __testRpc(JSON.stringify({jsonrpc:'2.0',id:1,...q})));if(r.error)throw Error(r.error.message);return r.result},on:(e,f)=>(__walletEvents[e]??=[]).push(f),removeListener:(e,f)=>__walletEvents[e]=(__walletEvents[e]||[]).filter(v=>v!==f)};
        window.fetch=async(u,opts)=>{if(String(u)!==c.rpc&&String(u)!==c.rpc+'/')throw Error('Unexpected test network destination');return new Response(await __testRpc(opts.body),{status:200,headers:{'Content-Type':'application/json'}})};
      }''',config)
      live.set_content(HTML,wait_until='domcontentloaded');click(live,'settings');nf=live.locator('#network-form');nf.locator('[name="chainId"]').select_option('31337')
      for k in ['rpc','anima','work','commons']:nf.locator(f'[name="{k}"]').fill(config[k])
      nf.locator('[type="submit"]').click();live.get_by_text('Chain and contract bindings checked.',exact=False).wait_for(timeout=20000)
      check('live configuration verifies real contract wiring',len(rpc_calls)>4)
      click(live,'mode-live');live.locator('.circle-card').first.wait_for(timeout=15000);check('circle data comes from the EVM, not samples','Sample circle' not in live.locator('#content').inner_text())
      click(live,'wallet');live.get_by_text('Wallet connected.',exact=False).wait_for();check('wallet connects only on explicit action',live.evaluate('__walletCalls.filter(x=>x==="eth_requestAccounts").length')==1)
      nav(live,'circles');click(live,'load-circles');live.locator('.circle-card').first.wait_for();click(live,'enter-circle','[data-id="1"]');live.locator('form[data-form="post"]').wait_for(timeout=15000)
      form=live.locator('form[data-form="post"]');form.locator('[name="body"]').fill(LIVE_BODY);form.locator('[type="submit"]').click();live.get_by_text('Review, then decide',exact=True).wait_for(timeout=15000)
      check('simulation does not send before review',live.evaluate('__walletCalls.filter(x=>x==="eth_sendTransaction").length')==0)
      click(live,'confirm-tx');live.get_by_text('Confirmed at block',exact=False).wait_for(timeout=20000);live.locator('.post').filter(has_text=LIVE_BODY).wait_for(timeout=15000)
      check('reviewed publication executes a real transaction',live.evaluate('__walletCalls.filter(x=>x==="eth_sendTransaction").length')==1)
      check('confirmed post is read back from contract storage',live.locator('.post').filter(has_text=LIVE_BODY).get_by_text('On-chain',exact=True).count()==1)
      card=live.locator('.post').filter(has_text=LIVE_BODY);card.locator('[data-action="react"]').click();live.get_by_text('Review, then decide',exact=True).wait_for();click(live,'confirm-tx');live.get_by_text('Confirmed at block',exact=False).wait_for();live.wait_for_timeout(500)
      check('reaction executes separately and reloads chain state',live.evaluate('__walletCalls.filter(x=>x==="eth_sendTransaction").length')==2)
      nav(live,'agents');live.locator('#agent-form [type="submit"]').click();live.locator('#agent-result').get_by_text('Owner',exact=True).wait_for(timeout=15000)
      check('agent inspection returns real ownership and attested count',config['agentOwner'].lower() in live.locator('#agent-result').inner_text().lower())
      live.evaluate('()=>{for(let f of (__walletEvents.accountsChanged||[]))f([])}');check('account changes invalidate the connected identity',live.get_by_text('Connect wallet',exact=True).count()==1)
      live.screenshot(path=str(OUT/'ANIMA_Agent_Inspector_LocalEVM.png'),full_page=True)
    (OUT/'ANIMA_Browser_Verification.json').write_text(json.dumps({'passed':len(results),'failed':0,'renderer':renderer,'transactions':transactions,'receipts':receipts,'checks':results,'environment':'Chromium in-memory document; explicit storage fixture; real Hardhat EVM over test-only EIP-1193 transport; no real wallet extension tested'},indent=2));print(json.dumps({'passed':len(results),'failed':0}));b.close()
