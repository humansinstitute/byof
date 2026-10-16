// Browser fixture: real UI assets, synthetic API responses and disposable signing identity.
// No grant is sent to a real Tower and this does not prove live human consent.
import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent,verifyEvent} from 'nostr-tools';
import {sha256} from '../src/assets.ts';
const origin='https://freedom.fixture',towerOrigin='https://nstack.otherstuff.ai',towerId=crypto.randomUUID(),workshopId=crypto.randomUUID(),workspaceId=crypto.randomUUID(),key=generateSecretKey(),owner=nip19.npubEncode(getPublicKey(key)),appNpub=nip19.npubEncode('a'.repeat(64));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let status:any={configured:true,state:'needs_authorization',appNpub,towerOrigin,workshopId,binding:null,namespaceReady:false};let binds=0,signatures:any[]=[],failure=false,cancelSignature=false;
const source=await Bun.file('public/app.js').text(),bootstrap="try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }";
if(!source.includes(bootstrap))throw Error('Browser fixture bootstrap changed; update deliberately');
const fixtureSource=source.replace(bootstrap,`setMember(${JSON.stringify({pubkey:getPublicKey(key),name:'Fixture administrator',host:true,admin:true,identity_type:'extension',state:'admitted'})});csrf='fixture';await siteAdmin();`);
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 await page.exposeFunction('fixtureSign',async(event:any)=>{if(cancelSignature){await new Promise(r=>setTimeout(r,250));throw Error('Fixture signer cancelled');}const signed=finalizeEvent(event,key);signatures.push(signed);return signed;});
 await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)};});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin){await route.abort();return;}
  if(url.pathname.startsWith('/api/v1/')){
   const path=url.pathname.slice('/api/v1/'.length);let body:any={};
   if(path==='browser-origin')body={origin};
   else if(path==='site/towers')body={towers:[{id:towerId,label:'Nstack',origin:towerOrigin}]};
   else if(path==='workshops')body={legacyWorkshopId:workshopId,workshops:[{id:workshopId,title:'Nstack workshop',tower_id:towerId}]};
   else if(path==='site/builder-prompt')body={scope:'site',prompt:{agentName:'Builder',text:'Fixture prompt',revision:1},maxChars:8000,agentNameMaxChars:80};
   else if(path==='host/storage')body=status;
   else if(path.endsWith('/connect'))body={workspaces:[{label:'Selected Nstack workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}],storage:status};
   else if(path.endsWith('/bind')){
    binds++;const input=req.postDataJSON();expect(req.headers()['x-workshop-id']).toBe(workshopId);expect(input.workspaceId).toBe(workspaceId);expect(input.reconnect).toBe(true);
    expect(input.namespaceEvent).toBeUndefined();const event=input.event,target=`${towerOrigin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,payload={invitee_npub:appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'};expect(verifyEvent(event)).toBe(true);expect(event.tags).toContainEqual(['u',target]);expect(event.tags).toContainEqual(['method','POST']);expect(event.tags).toContainEqual(['payload',sha256(JSON.stringify(payload))]);
    status={...status,state:'probing',binding:{status:'probing',target:{workspaceId}},probe:{id:'probe'},namespaceReady:false};body=status;
   }else if(path==='host/storage/probe'){
    status=failure?{...status,state:'error',probe:{error:'tower_storage_http_403'}}:{...status,state:'ready',binding:{...status.binding,status:'ready'},namespaceReady:true};body=status;
   }
   await route.fulfill({json:body});return;
  }
  if(url.pathname==='/app.js'){await route.fulfill({contentType:'text/javascript',body:fixtureSource});return;}
  if(url.pathname==='/identity.js'){await route.fulfill({contentType:'text/javascript',body:"export const participantSigner=()=>null,verifyEvent=()=>false,getEventHash=()=>'fixture',temporaryIdentity=()=>{},forgetTemporaryIdentity=()=>{},humanText=x=>String(x??''),initials=()=> 'F',browserProfileCache=()=>({peek:()=>({name:'Fixture administrator'}),refresh:async()=>({name:'Fixture administrator'}),seed:()=>{}});"});return;}
  const file=Bun.file(url.pathname==='/'?'public/index.html':'public'+url.pathname);await route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':'text/html',body:await file.text()});
 });
 await page.goto(origin+'/?workshop='+workshopId);await expect(page.getByRole('heading',{name:'Site administration'})).toBeVisible();
 await page.getByRole('button',{name:'Connect Tower',exact:true}).click();await page.getByRole('button',{name:'Selected Nstack workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Review app access'})).toBeVisible();
 await expect(page.locator('#dialog')).toContainText(towerOrigin);await expect(page.locator('#dialog')).toContainText('not a storage-only permission');expect(signatures).toHaveLength(1);expect(binds).toBe(0);
 await page.getByRole('button',{name:'Close',exact:true}).click();expect(binds).toBe(0);
 await page.getByRole('button',{name:'Reconnect Tower',exact:true}).click();await page.getByRole('button',{name:'Selected Nstack workspace',exact:true}).click();cancelSignature=true;
 await page.getByRole('button',{name:'Authorize and check storage',exact:true}).click();await expect(page.getByRole('heading',{name:'Storage setup needs attention'})).toBeVisible();expect(binds).toBe(0);cancelSignature=false;
 await page.getByRole('button',{name:'Retry setup',exact:true}).click();await page.getByRole('button',{name:'Authorize and check storage',exact:true}).click();await expect(page.getByRole('heading',{name:'Ready',exact:true})).toBeVisible();expect(binds).toBe(1);
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Connect Tower',exact:true}).click();await page.getByRole('button',{name:'Selected Nstack workspace',exact:true}).click();failure=true;
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Reauthorize and check storage',exact:true}).click();await expect(page.getByRole('heading',{name:'Storage setup needs attention'})).toBeVisible();await expect(page.locator('#dialog')).toContainText('tower_storage_http_403');expect(binds).toBe(2);expect(errors).toEqual([]);
 console.log(JSON.stringify({fixture:true,tower:towerOrigin,checks:['access review before signing','cancel before grant','signer cancellation without grant','one exact workspace-invite signature','managed namespace is not re-registered','probing then ready','reconnect failure visible','mobile overflow','no browser errors'],binds}));
}finally{await browser.close();key.fill(0);}
