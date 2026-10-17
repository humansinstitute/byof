import { chromium, expect, type Page, type Frame } from '@playwright/test';
import { getPublicKey, finalizeEvent } from 'nostr-tools';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { application } from '../src/application.ts';
import { validateGeneratedHtml } from '../src/pipeline/artifact.ts';
// Real Chrome, real backend, synthetic identities. Never touches the registered app.
const evidence='tmp/docs/handoffs/napplet-relay-evidence';mkdirSync(evidence,{recursive:true});
const secret=new Uint8Array(32).fill(1),foreign=new Uint8Array(32).fill(2);
const app=application({dataDir:mkdtempSync(evidence+'/data-'),hostPubkey:getPublicKey(secret),origin:null,version:'relay-acceptance'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks:string[]=[];
async function login(page:Page,key:Uint8Array){
 page.setDefaultTimeout(10000);
 await page.exposeFunction('syntheticPublicKey',(mode:string)=>getPublicKey(mode==='mismatch'?foreign:key));
 await page.exposeFunction('syntheticSign',(event:any,mode:string)=>{if(mode==='reject')throw Error('Synthetic rejection');return finalizeEvent(mode==='changed'?{...event,content:'changed by signer'}:event,mode==='mismatch'?foreign:key);});
 await page.addInitScript(()=>{if(window.parent!==window)return;(window as any).signerMode='normal';(window as any).signatureCalls=0;(window as any).nostr={getPublicKey:()=>(window as any).syntheticPublicKey((window as any).signerMode),signEvent:(event:any)=>{(window as any).signatureCalls++;if((window as any).signerMode==='hang')return new Promise(()=>{});return (window as any).syntheticSign(event,(window as any).signerMode);}};});
 await page.goto(server.url.href);await page.getByRole('button',{name:'Log in with browser extension',exact:true}).click();await expect(page.getByRole('button',{name:'Open identity menu'})).toBeVisible();await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');
}
async function invoke(frame:Frame,method:string,arg?:any):Promise<{ok:boolean;value?:any;code?:string;message?:string}>{return frame.evaluate(async({method,arg})=>{try{const n=(window as any).napplet;const [a,b]=method.split('.');const value=await (b?n[a][b](...(arg||[])):n[a]());return {ok:true,value};}catch(e:any){return {ok:false,code:e.code,message:e.message};}},{method,arg}).catch(e=>({ok:false,code:'FRAME_DETACHED',message:e.message}));}
async function activeFrame(page:Page){await page.waitForFunction(()=>document.querySelector('iframe[data-napplet]')||Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Open Canvas'));if(!await page.locator('iframe[data-napplet]').count())await page.getByRole('button',{name:'Open Canvas',exact:true}).first().click();const element=page.locator('iframe[data-napplet]').first();await expect(element).toBeVisible();const frame=await (await element.elementHandle())!.contentFrame();if(!frame)throw Error('No frame');await expect.poll(()=>frame.evaluate(()=>!!(window as any).napplet).catch(()=>false)).toBe(true);await expect.poll(async()=>await invoke(frame,'capabilities').then(result=>result.ok)).toBe(true);return frame;}
async function consent(page:Page,allow:boolean){const dialog=page.locator('.napplet-consent');await expect(dialog).toBeVisible();await dialog.locator(allow?'[data-napplet-consent="allow"]':'[data-napplet-consent="deny"]').click();}
const note=(text:string,tag='bussobushbash',time=1700000000)=>finalizeEvent({kind:1,created_at:time,tags:[['t',tag]],content:text},secret);
const history=note('Historical <img src=x onerror=alert(1)>'),live=note('Arrived after EOSE','bussobushbash',1700000001);
const wires:any[]=[],sockets:any[]=[];let mode='normal';
try {
 const context=await browser.newContext(),page=await context.newPage();
 // Delay subscribe responses so real MessageChannel event/status delivery precedes the handle.
 await page.addInitScript(()=>{if(window.parent!==window)return;const Native=MessageChannel;(window as any).MessageChannel=class extends Native {constructor(){super();const post=this.port1.postMessage.bind(this.port1);this.port1.postMessage=(message:any,...rest:any[])=>{if(message?.value?.subscriptionId)setTimeout(()=>post(message,...rest),100);else post(message,...rest);};}};});
 await page.routeWebSocket(/^wss:\/\/(relay\.damus\.io|nos\.lol|relay\.primal\.net)\/?$/,ws=>{
  sockets.push(ws);ws.onMessage(raw=>{const m=JSON.parse(String(raw));wires.push(m);if(m[0]!=='REQ')return;
   if(mode==='closed'){ws.send(JSON.stringify(['CLOSED',m[1],'blocked: fixture refusal']));return;}
   if(mode==='disconnect'){ws.close();return;}
   for(const event of [history,history,{...note('invalid'),sig:'0'.repeat(128)},note('wrong tag','other'),note('excess','bussobushbash',1699999999)])ws.send(JSON.stringify(['EVENT',m[1],event]));
   ws.send(JSON.stringify(['EOSE',m[1]]));
   setTimeout(()=>{try{ws.send(JSON.stringify(['EVENT',m[1],live]));}catch{}},200);
  });
 });
 await login(page,secret);const me=await page.evaluate(async()=>await(await fetch('/api/v1/me')).json());const member=app.workshop.scoped(me.member);const created=app.workshop.create(member,'dice',undefined,true);
 const fixture=validateGeneratedHtml('<!doctype html><html><head><title>Relay fixture</title></head><body><h1>Relay fixture</h1><pre id="feed"></pre></body></html>');const revision=app.workshop.addRevision(created.project,app.workshop.assets.put(fixture),member.pubkey);app.workshop.share(member,created.project.id,{revisionId:revision});await page.reload();const frame=await activeFrame(page);
 const options={filters:[{kinds:[1],'#t':['bussobushbash'],limit:1}],relays:['wss://nos.lol'],timeoutMs:2000};
 const result=await invoke(frame,'relay.query',[options]);expect(result.ok).toBe(true);expect(result.value.events.map((e:any)=>e.id)).toEqual([history.id]);expect(result.value.complete).toBe(true);expect(result.value.truncated).toBe(true);
 checks.push('Historical query through real injected bridge: signed exact hashtag note only, local limit=1 despite excess history, invalid signatures/wrong tags/duplicates rejected, honest truncation/EOSE');
 await frame.evaluate(async options=>{const w=window as any;w.events=[];w.statuses=[];w.handle=await w.napplet.relay.subscribe(options,{onEvent:(event:any)=>{w.events.push(event);document.getElementById('feed')!.textContent+=event.content+'\n';},onStatus:(s:any)=>w.statuses.push(s)});},options);
 await expect.poll(()=>frame.evaluate(()=>(window as any).events.length)).toBe(2);expect(await frame.locator('#feed').innerText()).toContain('Arrived after EOSE');expect(await frame.locator('#feed img').count()).toBe(0);
 expect(await frame.evaluate(()=>(window as any).statuses.some((s:any)=>s.state==='live'))).toBe(true);
 await frame.evaluate(event=>window.postMessage({version:1,type:'relay',subscriptionId:(window as any).handle.id,payload:{type:'event',event}},'*'),note('spoofed window delivery'));
 expect(await frame.evaluate(()=>(window as any).events.length)).toBe(2);
 // A second subscription shares the already-open relay and exercises early delivery again.
 await frame.evaluate(async options=>{const w=window as any;w.secondEvents=[];w.second=await w.napplet.relay.subscribe(options,{onEvent:(e:any)=>w.secondEvents.push(e),onStatus:()=>{}});},options);
 await expect.poll(()=>frame.evaluate(()=>(window as any).secondEvents.length)).toBe(2);await frame.evaluate(async()=>await(window as any).second.close());
 checks.push('Forged window relay message ignored; additional subscription reuses open socket and safely buffers delivery before response');await page.screenshot({path:evidence+'/historical-and-live.png'});
 const closeBefore=wires.filter(m=>m[0]==='CLOSE').length;await frame.evaluate(async()=>await(window as any).handle.close());await expect.poll(()=>wires.filter(m=>m[0]==='CLOSE').length).toBeGreaterThan(closeBefore);
 checks.push('Bounded early event/status buffering with delayed handle response; true post-EOSE live delivery, callbacks remain local, hostile content rendered as text, explicit handle.close sends CLOSE');
 for(const url of ['ws://127.0.0.1','wss://localhost','wss://nos.lol/private','wss://purplepag.es'])expect((await invoke(frame,'relay.query',[{...options,relays:[url]}])).code).toBe('FORBIDDEN');
 mode='closed';const failed=await invoke(frame,'relay.query',[options]);expect(failed.value.events).toEqual([]);expect(failed.value.complete).toBe(false);expect(failed.value.partial).toBe(true);expect(failed.value.relays[0].message).toContain('fixture refusal');
 await frame.evaluate(async options=>{const w=window as any;w.closedStatuses=[];w.closedHandle=await w.napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:(s:any)=>w.closedStatuses.push(s)});},options);
 await expect.poll(()=>frame.evaluate(()=>(window as any).closedStatuses.some((s:any)=>s.state==='closed'))).toBe(true);
 mode='disconnect';const reqBefore=wires.filter(m=>m[0]==='REQ').length;
 await frame.evaluate(async options=>{const w=window as any;w.retryStatuses=[];w.retryHandle=await w.napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:(s:any)=>w.retryStatuses.push(s)});},options);
 await expect.poll(()=>wires.filter(m=>m[0]==='REQ').length,{timeout:5000}).toBeGreaterThan(reqBefore+1);
 expect(await frame.evaluate(()=>(window as any).retryStatuses.some((s:any)=>s.retryMs>=1000&&s.gapPossible))).toBe(true);mode='normal';await frame.evaluate(async()=>await(window as any).retryHandle.close());
 checks.push('Unsupported URLs rejected, relay refusal yields partial failure rather than empty success, early terminal callback reaches client, retry/backoff/gapPossible observed');
 const isolation=await frame.evaluate(async()=>{try{await fetch('https://example.com');return false;}catch{return true;}});expect(isolation).toBe(true);
 const preview=await page.evaluate(async src=>(await fetch(src!)).headers.get('content-security-policy'),await page.locator('iframe[data-napplet]').first().getAttribute('src'));expect(preview).toContain('connect-src https: wss:');expect(preview).toContain('sandbox allow-scripts allow-forms');
 await frame.evaluate(async options=>{const w=window as any;w.revoked=[];w.revokeHandle=await w.napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:(s:any)=>w.revoked.push(s)});},options);await expect.poll(()=>wires.filter(m=>m[0]==='REQ').length).toBeGreaterThan(reqBefore+1);const revokeBefore=wires.filter(m=>m[0]==='CLOSE').length;
 await page.getByRole('button',{name:'Revoke Napplet permissions',exact:true}).click();await expect.poll(()=>wires.filter(m=>m[0]==='CLOSE').length).toBeGreaterThan(revokeBefore);expect((await invoke(frame,'relay.query',[options])).code).toBe('STALE');
 checks.push('Opaque iframe and browser CORS remain enforced with direct HTTPS/WSS enabled; revocation closes host relay sockets/channel and stale requests fail; only REQ/CLOSE outbound through the mediated relay API');
 // Fresh bindings exercise relay cleanup on one-hour expiry, navigation and logout.
 await page.reload();let fresh=await activeFrame(page);
 await fresh.evaluate(async options=>{(window as any).h=await(window as any).napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:()=>{}});},options);
 await expect.poll(()=>wires.at(-1)?.[0]).toBe('REQ');const expiryBefore=wires.filter(m=>m[0]==='CLOSE').length;
 await page.clock.install();await page.clock.fastForward(3600001);await expect.poll(()=>wires.filter(m=>m[0]==='CLOSE').length).toBeGreaterThan(expiryBefore);expect((await invoke(fresh,'relay.query',[options])).code).toBe('STALE');await page.clock.setFixedTime(new Date());
 await page.reload();fresh=await activeFrame(page);await fresh.evaluate(async options=>{(window as any).h=await(window as any).napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:()=>{}});},options);
 await expect.poll(()=>wires.at(-1)?.[0]).toBe('REQ');const navBefore=wires.filter(m=>m[0]==='CLOSE').length;await page.locator('iframe[data-napplet]').first().evaluate(el=>el.remove());await expect.poll(()=>wires.filter(m=>m[0]==='CLOSE').length).toBeGreaterThan(navBefore);
 await page.reload();fresh=await activeFrame(page);await fresh.evaluate(async options=>{(window as any).h=await(window as any).napplet.relay.subscribe(options,{onEvent:()=>{},onStatus:()=>{}});},options);
 await expect.poll(()=>wires.at(-1)?.[0]).toBe('REQ');const logoutBefore=wires.filter(m=>m[0]==='CLOSE').length;await page.getByRole('button',{name:'Open identity menu'}).click();await page.getByRole('button',{name:'My Profile',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect.poll(()=>wires.filter(m=>m[0]==='CLOSE').length).toBeGreaterThan(logoutBefore);await expect(page.locator('iframe')).toHaveCount(0);
 checks.push('Active relay subscriptions close on controlled one-hour parent lease expiry, frame removal/navigation and logout');expect(wires.every(m=>['REQ','CLOSE'].includes(m[0]))).toBe(true);
 await Bun.write(evidence+'/results.json',JSON.stringify({checks,wires},null,2));console.log(JSON.stringify({checks,evidence}));
}finally{await browser.close();server.stop(true);app.db.close();}
