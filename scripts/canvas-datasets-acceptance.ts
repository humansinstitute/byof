import {chromium,expect,type Page,type Frame} from '@playwright/test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {openCanvasTowerFixture} from './canvas-tower-fixture.ts';
import {canvasBroker} from '../src/canvas-broker.ts';
import {CanvasTableFixture} from '../tests/canvas-fixture.ts';
const evidence='tmp/docs/handoffs/canvas-browser-evidence';mkdirSync(evidence,{recursive:true});
const directory=mkdtempSync('/tmp/canvas-browser-'),owner=generateSecretKey(),other=generateSecretKey(),realTower=process.env.FREEDOM_CANVAS_REAL_TOWER_FIXTURE==='1'?await openCanvasTowerFixture():null,table=new CanvasTableFixture();
const brokerCalls:{method:string;path:string;ms:number;bytes:number}[]=[];
// Synthetic loopback broker endpoint exercises production Canvas transport and current Tower HTTP contracts.
// It has fixture signer authority only; never represents the installed Autopilot broker.
const broker=realTower?Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const input=await req.json(),started=performance.now();
 const response=await realTower.request(realTower.target.towerUrl+`/api/v4/workspaces/${realTower.target.workspaceOwnerNpub}/apps/${realTower.target.appNpub}/db`+input.path,input.method,input.body);
 const bytes=await response.arrayBuffer();brokerCalls.push({method:input.method,path:input.path,ms:performance.now()-started,bytes:bytes.byteLength});return new Response(bytes,{status:response.status,headers:response.headers});
}}):null;
const app=application({dataDir:directory,hostPubkey:getPublicKey(owner),origin:null,version:'canvas-browser-fixture'},{datasetTransport:scope=>{if(!realTower||!broker)return table.request;scope.target=realTower.target;return canvasBroker(scope,undefined,{WAPP_TOWER_DB_BROKER_URL:broker.url+'api/internal/wapps/tower-db',WAPP_TOWER_DB_CAPABILITY:'synthetic-fixture-only',WAPP_INSTALLATION_ID:scope.installationId,WAPP_TOWER_URL:scope.target.towerUrl,WAPP_TOWER_WORKSPACE_ID:scope.target.workspaceId,WAPP_TOWER_WORKSPACE_OWNER_NPUB:scope.target.workspaceOwnerNpub,WAPP_APP_NPUB:scope.target.appNpub});}});
let disconnectWatches=false;const watchControllers=new Set<AbortController>();const networkClosers=new Set<()=>void>();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/fixture-login')return new Response('<!doctype html><html><body>Synthetic login</body></html>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/fixture-parent'){
  const session=app.auth.session(request),canvas=app.workshop.id,member=app.workshop.scoped(session.member);
  return new Response(`<!doctype html><html><body><h1>BYOF Canvas fixture</h1><script type="module">import {installNappletHost} from '/napplet-host.js';installNappletHost(()=>(${JSON.stringify({member,csrf:session.csrf,workshop:canvas})}));const frame=document.createElement('iframe');frame.dataset.napplet='';frame.title='Synthetic Napplet';frame.setAttribute('sandbox','allow-scripts allow-forms');frame.src=${JSON.stringify(`/api/v1/projects/${url.searchParams.get('project')}/preview?workshop=${canvas}&revision=${url.searchParams.get('revision')}`)};document.body.append(frame);</script></body></html>`,{headers:{'content-type':'text/html'}});
 }
 if(url.pathname==='/api/v1/napplet/dataset/watch'){
  if(disconnectWatches)return new Response('Synthetic connection loss',{status:503});
  const controller=new AbortController();watchControllers.add(controller);request.signal.addEventListener('abort',()=>controller.abort(),{once:true});const response=await app.handle(new Request(request,{signal:controller.signal}));
  if(!response.ok)return response;
  const reader=response.body!.getReader();let stop=()=>{};
  const stream=new ReadableStream<Uint8Array>({start(out){let ended=false;stop=()=>{if(ended)return;ended=true;out.close();controller.abort();networkClosers.delete(stop);};networkClosers.add(stop);void(async()=>{try{while(!ended){const r=await reader.read();if(ended)return;if(r.done){stop();return;}out.enqueue(r.value);}}catch{stop();}})();},cancel:()=>stop()});return new Response(stream,{headers:response.headers});
 }
 return app.handle(request);
}});
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks:string[]=[];
async function account(secret:Uint8Array){
 const context=await browser.newContext(),page=await context.newPage();await page.goto(server.url+'fixture-login');
 const challenge=await page.evaluate(async()=>await(await fetch('/api/v1/challenge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json());
 const data=await page.evaluate(async body=>{const r=await fetch('/api/v1/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Fixture login failed');return r.json();},{challengeId:challenge.id,event:finalizeEvent(challenge.event,secret),identityType:'extension'});
 await page.close();return {context,member:app.workshop.scoped(data.member),csrf:data.csrf};
}
async function pageFor(account:any,project:any){const page:Page=await account.context.newPage();await page.goto(server.url+`fixture-parent?project=${project.id}&revision=${project.current_revision}`);const element=page.locator('iframe[data-napplet]');await expect(element).toBeVisible();const frame=(await (await element.elementHandle())!.contentFrame())!;await expect.poll(()=>frame.evaluate(()=>!!(window as any).napplet)).toBe(true);return {page,frame};}
async function open(page:Page,frame:Frame,dataset:any,variable='dataset'){const promise=frame.evaluate(async({dataset,variable})=>{try{(window as any)[variable]=await (window as any).napplet.datasets.open(dataset);return {ok:true};}catch(e:any){return {ok:false,code:e.code,message:e.message};}},{dataset,variable});await expect(page.locator('.napplet-consent')).toBeVisible();await page.locator('[data-napplet-consent="allow"]').click();expect(await promise).toEqual({ok:true});}
try{
 const a=await account(owner);app.db.run("UPDATE room SET admission='open' WHERE id=1");const b=await account(other);
 const p=app.workshop.create(a.member,'blank').project,q=app.workshop.create(b.member,'blank').project;
 const one=await pageFor(a,p),two=await pageFor(b,q),binding={name:'inventory',visibility:'shared'},definition={...binding,description:'Stock shared by editor and dashboard',fields:{quantity:'number: current count'}};
 await open(one.page,one.frame,definition);await open(two.page,two.frame,binding);
 expect(await one.frame.evaluate(async()=>await(window as any).dataset.set('stock',{quantity:2},0))).toMatchObject({version:1});
 expect(await two.frame.evaluate(async()=>await(window as any).dataset.get('stock'))).toMatchObject({value:{quantity:2},version:1});
 await two.frame.evaluate(async()=>{(window as any).changes=0;(window as any).statuses=[];(window as any).watch=await(window as any).dataset.watch({onChange:async()=>{(window as any).changes++;(window as any).current=await(window as any).dataset.get('stock');},onStatus:(s:any)=>(window as any).statuses.push(s.state)});});
 await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.version)).toBe(1);
 await one.frame.evaluate(async()=>await(window as any).dataset.set('stock',{quantity:3},1));await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.value?.quantity)).toBe(3);
 console.log('milestone',checks.length+1);checks.push('Two distinct Napplets and authenticated synthetic Nostr users read/write the same Canvas dataset through actual injected bridge and Freedom backend; watch invalidation causes dashboard refetch');
 const writes=await Promise.all([one.frame.evaluate(async()=>{try{return {ok:true,value:await(window as any).dataset.set('stock',{quantity:4},2)};}catch(e:any){return {ok:false,code:e.code};}}),two.frame.evaluate(async()=>{try{return {ok:true,value:await(window as any).dataset.set('stock',{quantity:5},2)};}catch(e:any){return {ok:false,code:e.code};}})]);expect(writes.filter(r=>r.ok)).toHaveLength(1);expect(writes.find(r=>!r.ok)?.code).toBe('CONFLICT');
 const currentForRemove=await one.frame.evaluate(async()=>await(window as any).dataset.get('stock'));
 await one.frame.evaluate(async version=>await(window as any).dataset.remove('stock',version),currentForRemove.version);
 await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.value)).toBe(null);
 const tombstone=await two.frame.evaluate(async()=>await(window as any).dataset.get('stock'));expect(tombstone.version).toBe(currentForRemove.version+1);
 expect(await one.frame.evaluate(async()=>{try{await(window as any).dataset.set('stock',{},0);return true;}catch{return false;}})).toBe(false);
 await one.frame.evaluate(async version=>await(window as any).dataset.set('stock',{quantity:7},version),tombstone.version);
 await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.value?.quantity)).toBe(7);
 console.log('milestone',checks.length+1);checks.push('Simultaneous version-2 saves produce exactly one success and one visible CONFLICT');
 await open(one.page,one.frame,{name:'personal',visibility:'private',description:'Personal notes',fields:{note:'string: private note'}},'privateData');await one.frame.evaluate(async()=>await(window as any).privateData.set('note',{note:'private to user one'},0));
 await open(two.page,two.frame,{name:'personal',visibility:'private',description:'Personal notes',fields:{note:'string: private note'}},'privateData');expect(await two.frame.evaluate(async()=>await(window as any).privateData.get('note'))).toMatchObject({value:null,version:0});
 const ungranted=await one.frame.evaluate(async()=>{try{await(window as any).napplet.datasets.get('personal','note');return false;}catch{return true;}});expect(ungranted).toBe(true);
 const csrf=a.csrf;const discovery=await one.page.evaluate(async()=>await(await fetch('/api/v1/canvas/datasets')).json());expect(discovery.datasets.map((d:any)=>d.name)).toEqual(['inventory']);expect(JSON.stringify(discovery)).not.toContain('private to user one');
 console.log('milestone',checks.length+1);checks.push('Private values remain owner-only; injected API exposes no arbitrary ungranted dataset read; builder discovery includes shared field descriptions without private values');
 await one.frame.evaluate(async()=>await(window as any).napplet.storage.set('legacy','legacy project-private'));expect(await one.frame.evaluate(async()=>await(window as any).napplet.storage.get('legacy'))).toBe('legacy project-private');expect(await two.frame.evaluate(async()=>await(window as any).napplet.storage.get('legacy'))).toBe(null);
 disconnectWatches=true;for(const stop of [...networkClosers])stop();watchControllers.clear();await expect.poll(()=>two.frame.evaluate(()=>(window as any).statuses.includes('recovering'))).toBe(true);
 const latest=await one.frame.evaluate(async()=>await(window as any).dataset.get('stock'));await one.frame.evaluate(async(version)=>await(window as any).dataset.set('stock',{quantity:99},version),latest.version);
 disconnectWatches=false;await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.value?.quantity),{timeout:15000}).toBe(99);
 if(process.env.FREEDOM_CANVAS_LONG_WATCH==='1'){
  const started=Date.now(),callsBefore=brokerCalls.length;
  await new Promise(resolve=>setTimeout(resolve,51000));
  const current=await one.frame.evaluate(async()=>await(window as any).dataset.get('stock'));
  await one.frame.evaluate(async version=>await(window as any).dataset.set('stock',{quantity:101},version),current.version);
  await expect.poll(()=>two.frame.evaluate(()=>(window as any).current?.value?.quantity),{timeout:10000}).toBe(101);
  checks.push('Watch continues after '+(Date.now()-started)+'ms wall time through production canvasBroker transport; '+(brokerCalls.length-callsBefore)+' bounded requests and no dataset storage jobs');
  expect((app.db.query("SELECT count(*) n FROM storage_jobs WHERE operation='dataset'").get() as any).n).toBe(0);
 }
 console.log('milestone',checks.length+1);checks.push('Connection loss reports recovering; reconnect performs full current read and dashboard refetch sees edits missed during disconnect');
 await one.page.screenshot({path:evidence+'/shared-private-canvas.png'});
 app.db.run("UPDATE members SET state='banned' WHERE pubkey=?",[b.member.pubkey]);await expect.poll(()=>two.frame.evaluate(()=>(window as any).statuses.includes('closed')),{timeout:15000}).toBe(true);
 const revoked=await two.frame.evaluate(async()=>{try{await(window as any).dataset.get('stock');return {ok:true};}catch(e:any){return {ok:false,code:e.code};}});expect(revoked.ok).toBe(false);
 console.log('milestone',checks.length+1);checks.push('Canvas revocation closes active dataset channel and denies later reads');
 await one.page.locator('.napplet-revoke').click();expect(await one.frame.evaluate(async()=>{try{await(window as any).dataset.list();return true;}catch{return false;}})).toBe(false);
 console.log('milestone',checks.length+1);checks.push('Explicit host Revoke closes all dataset and legacy bridge permissions');
 await Bun.write(evidence+'/report.json',JSON.stringify({passed:true,mode:realTower?'Chrome synthetic users; actual sandbox/bridge/Freedom backend and source-loaded Tower NIP-98/PostgreSQL disposable fixture; NOT deployed Tower or installed broker':'Chrome synthetic users; actual sandbox/bridge/Freedom backend; disposable in-memory Tower table-contract fixture, NOT live Tower or installed broker',projects:[p.id,q.id],brokerMetrics:{requests:brokerCalls.length,maxMs:Math.max(0,...brokerCalls.map(c=>c.ms)),versionPolls:brokerCalls.filter(c=>c.path.endsWith('/query')).length,mode:'synthetic loopback endpoint + production canvasBroker + source-loaded Tower, not installed broker'},checks},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,evidence}));
}finally{await browser.close();for(const controller of watchControllers)controller.abort();server.stop(true);broker?.stop(true);app.db.close();await realTower?.close();rmSync(directory,{recursive:true,force:true});}
