import {chromium,expect,type Frame,type Page} from '@playwright/test';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {application} from '../src/application.ts';
import {previewPolicy} from '../src/assets.ts';
import {validateGeneratedHtml} from '../src/pipeline/artifact.ts';

// Real Chrome + isolated application. External HTTPS/WSS are deterministic
// browser routes, so this proves CSP/CORS behavior without a public dependency.
const evidence='tmp/docs/handoffs/napplet-network-evidence';mkdirSync(evidence,{recursive:true});
const secret=generateSecretKey(),hostApiRequests:{path:string;origin:string|null;cookie:boolean;status:number}[]=[];
const tlsDir=mkdtempSync(evidence+'/tls-'),keyPath=tlsDir+'/key.pem',certPath=tlsDir+'/cert.pem';
const openssl=Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdout:'ignore',stderr:'ignore'});
if(openssl.exitCode!==0)throw Error('Local HTTPS fixture certificate generation failed; openssl is required');
const app=application({dataDir:mkdtempSync(evidence+'/data-'),hostPubkey:getPublicKey(secret),origin:null,version:'network-acceptance'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:Bun.file(keyPath),cert:Bun.file(certPath)},fetch:async request=>{
 const response=await app.handle(request),path=new URL(request.url).pathname;
 if((['/api/v1/me','/api/v1/logout'].includes(path)&&request.headers.get('origin')==='null')||path.startsWith('/api/v1/napplet/'))hostApiRequests.push({path,origin:request.headers.get('origin'),cookie:request.headers.has('cookie'),status:response.status});
 return response;
}});
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks:string[]=[],corsOrigins:string[]=[],webSockets:string[]=[];let blockedActiveRequests=0;
const external=Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:Bun.file(keyPath),cert:Bun.file(certPath)},fetch(request,server){
 const url=new URL(request.url);corsOrigins.push(request.headers.get('origin')||'');
 if(url.pathname==='/socket'&&server.upgrade(request))return;
 if(url.pathname==='/data')return Response.json({service:'controlled-cors',ok:true},{headers:{'access-control-allow-origin':'null'}});
 if(url.pathname==='/no-cors')return Response.json({unsafe:true});
 if(url.pathname.startsWith('/assets/')){blockedActiveRequests++;return new Response('window.remoteAssetExecuted=true',{headers:{'content-type':'application/javascript'}});}
 return new Response('not found',{status:404});
},websocket:{open(){webSockets.push('open')},message(socket,message){socket.send('echo:'+message)},close(){}}});
const externalOrigin=external.url.origin.replace('http:','https:');

async function login(page:Page){
 await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,secret));
 await page.addInitScript(()=>{if(parent===window)(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)};});
 await page.goto(server.url.href);await page.getByRole('button',{name:'Log in with browser extension',exact:true}).click();
 await expect(page.getByRole('button',{name:'Open identity menu'})).toBeVisible();
}
async function openCanvas(page:Page){
 await page.waitForFunction(()=>document.querySelector('.board-viewport')||Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Open Canvas'));
 if(!await page.locator('.board-viewport').count())await page.getByRole('button',{name:'Open Canvas',exact:true}).first().click();
 await expect(page.locator('.board-viewport')).toBeVisible();
}
async function results(frame:Frame){await expect.poll(()=>frame.evaluate(()=>!!(window as any).networkResults),{timeout:10000}).toBe(true);return frame.evaluate(()=>(window as any).networkResults);}

const fixture=validateGeneratedHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Network boundary fixture</title></head><body><p id="status">Testing</p><script>
(async()=>{const out={};
 try{const response=await fetch(${JSON.stringify(externalOrigin+'/data')});out.https=await response.json();}catch(error){out.https={error:String(error)}}
 try{await fetch(${JSON.stringify(externalOrigin+'/no-cors')});out.noCors='readable';}catch{out.noCors='denied'}
 out.wss=await new Promise(resolve=>{const socket=new WebSocket(${JSON.stringify(externalOrigin.replace('https:','wss:')+'/socket')}),timer=setTimeout(()=>{socket.close();resolve('timeout')},3000);socket.onopen=()=>socket.send('hello');socket.onmessage=event=>{clearTimeout(timer);resolve(event.data);socket.close()};socket.onerror=()=>{clearTimeout(timer);resolve('error')}});
 try{out.cookie=document.cookie||'readable-empty'}catch{out.cookie='denied'}
 try{out.parentText=parent.document.body.innerText}catch{out.parentText='denied'}
 try{localStorage.setItem('network-test','x');out.localStorage='allowed'}catch{out.localStorage='denied'}
 try{await fetch('/api/v1/me',{credentials:'include'});out.hostRead='readable'}catch{out.hostRead='denied'}
 out.script=await new Promise(resolve=>{const node=document.createElement('script'),timer=setTimeout(()=>resolve('timeout'),1500);node.src=${JSON.stringify(externalOrigin+'/assets/remote.js')};node.onload=()=>{clearTimeout(timer);resolve('loaded')};node.onerror=()=>{clearTimeout(timer);resolve('blocked')};document.head.append(node)});
 try{await import(${JSON.stringify(externalOrigin+'/assets/module.js')});out.module='loaded'}catch{out.module='blocked'}
 const child=document.createElement('iframe');child.src=${JSON.stringify(externalOrigin+'/assets/frame.html')};document.body.append(child);await new Promise(resolve=>setTimeout(resolve,300));out.frameElement=!!child.contentWindow;child.remove();
 document.getElementById('status').textContent='Done';window.networkResults=out;
})()</script></body></html>`);

try{
 const context=await browser.newContext({viewport:{width:1280,height:900},ignoreHTTPSErrors:true}),page=await context.newPage();
 await login(page);const me=await page.evaluate(async()=>await(await fetch('/api/v1/me')).json()),member=app.workshop.scoped(me.member),created=app.workshop.create(member,'blank',undefined,true);
 const revision=app.workshop.addRevision(created.project,app.workshop.assets.put(fixture),member.pubkey);app.workshop.share(member,created.project.id,{revisionId:revision});app.db.run("UPDATE room SET admission='open' WHERE id=1");
 await page.reload();await openCanvas(page);const runtimeElement=page.locator(`iframe[data-project="${created.project.id}"]`).first();await expect(runtimeElement).toHaveAttribute('data-runtime-ready','true');expect(await runtimeElement.getAttribute('data-cache-hit')).toBe('false');
 let runtimeFrame=await runtimeElement.elementHandle().then(handle=>handle!.contentFrame()) as Frame,runtimeResults=await results(runtimeFrame);
 expect(runtimeResults.https).toEqual({service:'controlled-cors',ok:true});expect(runtimeResults.noCors).toBe('denied');expect(runtimeResults.wss).toBe('echo:hello');
 expect(runtimeResults).toMatchObject({cookie:'denied',parentText:'denied',localStorage:'denied',hostRead:'denied',script:'blocked',module:'blocked'});
 expect(await runtimeFrame.evaluate(async()=>{try{await fetch('/api/v1/logout',{method:'POST',credentials:'include'});return 'readable'}catch{return 'denied'}})).toBe('denied');
 const runtimeUrl=await runtimeElement.getAttribute('src'),runtimeResponse=await page.request.get(new URL(runtimeUrl!,server.url).href);expect(runtimeResponse.headers()['content-security-policy']).toBe(previewPolicy);
 checks.push('Served runtime: controlled HTTPS/CORS fetch and secure WebSocket succeed; non-CORS response, host APIs, remote script/import/frame execution and browser storage/parent access remain unavailable');

 await page.reload();await openCanvas(page);const cachedElement=page.locator(`iframe[data-project="${created.project.id}"]`).first();await expect(cachedElement).toHaveAttribute('data-runtime-ready','true');expect(await cachedElement.getAttribute('data-cache-hit')).toBe('true');runtimeFrame=await cachedElement.elementHandle().then(handle=>handle!.contentFrame()) as Frame;runtimeResults=await results(runtimeFrame);expect(runtimeResults.https.ok).toBe(true);expect(runtimeResults.wss).toBe('echo:hello');
 checks.push('Cached immutable payload: fresh authenticated runtime shell reuses the same CSP and direct HTTPS/WSS policy');

 const previewUrl=`/api/v1/projects/${created.project.id}/preview?workshop=${app.workshop.id}&revision=${revision}`;
 const previewResponse=await page.request.get(new URL(previewUrl,server.url).href);expect(previewResponse.headers()['content-security-policy']).toBe(previewPolicy);
 const direct=await page.evaluate(({previewUrl,projectId,revision,sourceHash,workshopId})=>{const frame=document.createElement('iframe');frame.dataset.napplet='';frame.dataset.project=projectId;frame.dataset.revision=revision;frame.dataset.sourceHash=sourceHash;frame.dataset.workshop=workshopId;frame.sandbox.add('allow-scripts','allow-forms');frame.src=previewUrl;frame.id='direct-preview-network';document.body.append(frame);return true;},{previewUrl,projectId:created.project.id,revision,sourceHash:created.project.current_revision===revision?created.project.source_hash:(app.db.query('SELECT source_hash FROM revisions WHERE id=?').get(revision) as any).source_hash,workshopId:app.workshop.id});expect(direct).toBe(true);
 await expect.poll(()=>page.frames().some(frame=>frame.url().includes('/preview?')&&frame.url().includes(revision))).toBe(true);const directFrame=page.frames().find(frame=>frame.url().includes('/preview?')&&frame.url().includes(revision))!;const directResults=await results(directFrame);expect(directResults.https.ok).toBe(true);expect(directResults.wss).toBe('echo:hello');expect(directResults).toMatchObject({cookie:'denied',parentText:'denied',localStorage:'denied',hostRead:'denied',script:'blocked',module:'blocked'});
 checks.push('Fresh direct preview: exact same CSP and external-service behavior as the cached/served revision path');

 const requestOrigins=corsOrigins.filter(Boolean);expect(requestOrigins.length).toBeGreaterThanOrEqual(6);expect(new Set(requestOrigins)).toEqual(new Set(['null']));expect(webSockets.length).toBeGreaterThanOrEqual(3);expect(blockedActiveRequests).toBe(0);
 expect(hostApiRequests.some(request=>request.path==='/api/v1/me')).toBe(true);expect(hostApiRequests.some(request=>request.path==='/api/v1/logout'&&request.status===403)).toBe(true);expect(await page.evaluate(async()=>(await fetch('/api/v1/me')).status)).toBe(200);
 checks.push('Opaque children send null Origin, cannot read authenticated Freedom Tools APIs or log out the parent, and CSP prevents remote active requests from reaching the network');
 await Bun.write(evidence+'/results.json',JSON.stringify({proof:'Real Chrome with isolated Freedom Tools backend and deterministic external HTTPS/WSS browser routes',checks,corsOrigins,webSockets,blockedActiveRequests,hostApiRequests,policy:previewPolicy},null,2));
 console.log(JSON.stringify({checks,evidence}));await context.close();
}finally{await browser.close();external.stop(true);server.stop(true);app.db.close();}
