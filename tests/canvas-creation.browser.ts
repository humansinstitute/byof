// Real UI with synthetic Tower/API and disposable signatures. No live grant/storage claim.
import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent,verifyEvent} from 'nostr-tools';
import {sha256} from '../src/assets.ts';
const origin='https://freedom.fixture',nstack='https://nstack.otherstuff.ai',sb4='https://sb4.otherstuff.studio',key=generateSecretKey(),actor=getPublicKey(key),owner=nip19.npubEncode(actor),appNpub=nip19.npubEncode('a'.repeat(64)),workspaceId=crypto.randomUUID();
const towers=[{id:'sb4',label:'Managed Tower',origin:sb4,connected:true},{id:'nstack',label:'Nstack',origin:nstack,connected:true}],workshops:any[]=[];
let createCalls=0,bindCalls=0,nativeSignatures=0,refuse=false,delaySign=false,releaseSign:()=>void=()=>{},reusable=false,failProbe=false,slowProbe=false,emptyWorkspaces=false,status:any={},seenIntents=new Map<string,any>(),lastBind:any,connectionFailure=false;
const source=await Bun.file('public/app.js').text(),bootstrap="try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }";
expect(source).toContain(bootstrap);
const fixtureSource=source.replace(bootstrap,`setMember(${JSON.stringify({pubkey:actor,name:'Fixture administrator',host:true,admin:true,identity_type:'extension',state:'admitted'})});csrf='fixture';await workshopsPage();`);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.setDefaultTimeout(10000);
 await page.exposeFunction('fixtureSign',async(event:any)=>{
  if(delaySign)await new Promise<void>(resolve=>{releaseSign=resolve;});
  if(refuse)throw Error('Fixture signature refused');
  if(event.tags.some((t:any)=>t[0]==='method'&&t[1]==='POST'))nativeSignatures++;
  return finalizeEvent(event,key);
 });
 await page.addInitScript(()=>{(window as any).nostr={signEvent:(e:any)=>(window as any).fixtureSign(e)};});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin){await route.abort();return;}
  if(url.pathname.startsWith('/api/v1/')){
   const path=url.pathname.slice(8);let body:any={};
   if(path==='browser-origin')body={origin};
   else if(path==='site/towers'){if(req.method()==='POST'){const input=req.postDataJSON();towers.push({id:'added',label:input.label,origin:input.origin,connected:false});}body={towers};}
   else if(path==='site/people')body={people:[{pubkey:actor,identity_type:'extension',name:'Fixture administrator'}]};
   else if(path==='workshops')body={workshops:workshops.map(w=>({...w,setupState:w.tower_id?(status.state||w.setupState):undefined})),legacyWorkshopId:workshops[0]?.id};
   else if(path==='room')body={member:{pubkey:actor,name:'Fixture administrator',host:true,admin:true,identity_type:'extension',state:'admitted'},room:{title:workshops[0]?.title||'Canvas',introduction:'Keep these details',lightning:'',support_label:'Support',paused:false},gallery:[],projects:[],starters:[],additionalProjectsAvailable:true,board:{version:1,objects:[],napplets:[]},donationQr:''};
   else if(path==='site/workshops'){
    const input=req.postDataJSON();createCalls++;expect(input.towerId).toBe('nstack');expect(input.owner).toBe(actor);expect(input.idempotencyKey).toBeTruthy();
    if(!seenIntents.has(input.idempotencyKey)){const w={...input,id:crypto.randomUUID(),tower_id:input.towerId,canManage:true,setupState:'needs_authorization'};seenIntents.set(input.idempotencyKey,w);workshops.push(w);}
    body=seenIntents.get(input.idempotencyKey);status={configured:true,state:'needs_authorization',appNpub,towerOrigin:nstack,workshopId:body.id,namespaceReady:false,binding:null};
   }else if(path==='host/storage')body=status;
   else if(path.endsWith('/create-intent'))body={url:nstack+'/api/v4/admin/flightdeck-pg/workspaces',payload:{workspace_name:'New Nstack workspace',creator_npub:owner,app_npub:appNpub}};
   else if(path.endsWith('/create'))body={workspace_id:workspaceId};
   else if(path.endsWith('/connect')){if(connectionFailure){await route.fulfill({status:503,json:{error:'Fixture backend unavailable'}});return;}expect(path).toBe('site/towers/nstack/connect');body={storage:status,workspaces:emptyWorkspaces?[]:[{label:'Nstack workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}],reusable:reusable?[workspaceId]:[]};}
   else if(path.endsWith('/bind')){
    bindCalls++;lastBind=req.postDataJSON();expect(req.headers()['x-workshop-id']).toBe(workshops[0].id);expect(lastBind.workspaceId).toBe(workspaceId);expect(path).toBe('site/towers/nstack/bind');
    expect(verifyEvent(lastBind.namespaceEvent)).toBe(true);expect(lastBind.namespaceEvent.tags).toContainEqual(['u',`${nstack}/api/v4/workspaces/${owner}/apps`]);expect(lastBind.namespaceEvent.tags).toContainEqual(['method','POST']);expect(lastBind.namespaceEvent.tags).toContainEqual(['payload',sha256(JSON.stringify({app_npub:appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true}))]);
    status={...status,state:'probing',binding:{status:'probing',target:{towerUrl:nstack,workspaceId,workspaceOwnerNpub:owner,appNpub}},probe:{id:'fixture-probe'},namespaceReady:false};body=status;
   }else if(path==='host/storage/probe'){
    if(failProbe)status={...status,state:'error',probe:{error:'Fixture revoked permission: 403'}};
    else if(!slowProbe)status={...status,state:'ready',binding:{...status.binding,status:'ready'},namespaceReady:true};
    body=status;
   }
   await route.fulfill({json:body});return;
  }
  if(url.pathname==='/app.js'){await route.fulfill({contentType:'text/javascript',body:fixtureSource});return;}
  if(url.pathname==='/identity.js'){await route.fulfill({contentType:'text/javascript',body:"export const participantSigner=()=>null,verifyEvent=()=>false,getEventHash=()=>'fixture',temporaryIdentity=()=>{},forgetTemporaryIdentity=()=>{},humanText=x=>String(x??''),initials=()=> 'F',browserProfileCache=()=>({peek:()=>({name:'Fixture administrator'}),refresh:async()=>({name:'Fixture administrator'}),seed:()=>{}});"});return;}
  const file=Bun.file(url.pathname==='/'?'public/index.html':'public'+url.pathname);await route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':'text/html',body:await file.text()});
 });
 const modal=page.getByRole('dialog');
 await page.goto(origin);await page.getByRole('button',{name:'Create Canvas',exact:true}).click();
 await expect(modal).toHaveAttribute('aria-labelledby','canvas-setup-title');await expect(modal.getByRole('list')).toContainText('Confirm and launch');await page.getByRole('button',{name:'Next: Connect backend'}).click();await expect(modal.getByRole('alert')).toContainText('Canvas title');await expect(page.getByLabel('Canvas title')).toBeFocused();
 await page.getByLabel('Canvas title').fill('Recoverable Nstack Canvas');await page.getByLabel('Introduction').fill('Keep these details');await expect(page.getByLabel('Owner',{exact:true})).toHaveValue(actor);
 await page.getByRole('button',{name:'Close Canvas setup'}).click();await expect(modal).not.toBeVisible();await expect(page.getByRole('button',{name:'Create Canvas'})).toBeFocused();await page.getByRole('button',{name:'Create Canvas'}).click();await expect(page.getByLabel('Canvas title')).toHaveValue('Recoverable Nstack Canvas');
 await page.getByRole('button',{name:'Next: Connect backend'}).click();await expect(page.getByLabel('NStack backend',{exact:true})).toHaveValue('');await page.getByRole('button',{name:'Test connection'}).click();await expect(modal.getByRole('alert')).toContainText('Choose an NStack backend');await expect(page.getByLabel('NStack backend',{exact:true})).toBeFocused();
 await page.getByLabel('NStack backend',{exact:true}).selectOption('nstack');connectionFailure=true;await page.getByRole('button',{name:'Test connection'}).click();await expect(modal).toContainText('Connection failed');await expect(modal).toContainText('Fixture backend unavailable');expect(createCalls).toBe(1);expect(bindCalls).toBe(0);
 connectionFailure=false;emptyWorkspaces=true;await page.getByRole('button',{name:'Test connection'}).click();await expect(modal).toContainText('Connection successful');await page.getByRole('button',{name:'Next: Choose Workspace'}).click();await expect(modal).toContainText('No workspaces are available');
 emptyWorkspaces=false;await page.getByRole('button',{name:'Refresh workspaces'}).click();await expect(page.getByLabel(/Nstack workspace/)).toBeVisible();await page.getByLabel(/Nstack workspace/).check();await page.getByRole('button',{name:'Back'}).click();await page.getByRole('button',{name:'Next: Choose Workspace'}).click();await expect(page.getByLabel(/Nstack workspace/)).toBeChecked();await page.getByRole('button',{name:'Next: Confirm'}).click();await expect(modal).toContainText('Recoverable Nstack Canvas');await expect(modal).toContainText(workspaceId);
 await page.getByRole('button',{name:'Close Canvas setup'}).click();await page.getByRole('button',{name:'Complete setup'}).click();await expect(modal).toContainText('Connect an NStack backend');await page.getByRole('button',{name:'Test connection'}).click();await page.getByRole('button',{name:'Next: Choose Workspace'}).click();await expect(page.getByLabel(/Nstack workspace/)).toBeChecked();await page.getByRole('button',{name:'Next: Confirm'}).click();
 failProbe=true;await page.getByRole('button',{name:'Confirm and launch'}).click();await expect(modal).toContainText('Setup was not saved as complete');await expect(modal).toContainText('Fixture revoked permission: 403');expect(lastBind.workspaceId).toBe(workspaceId);expect(workshops[0].setupState).not.toBe('ready');
 failProbe=false;await page.getByRole('button',{name:'Retry confirm and launch'}).click();await expect(modal).not.toBeVisible();await expect(page.getByRole('heading',{name:'Recoverable Nstack Canvas'})).toBeVisible();expect(status.state).toBe('ready');expect(createCalls).toBe(1);expect(bindCalls).toBe(2);
 await page.locator('button[data-a="workshops"]').first().click();await expect(page.getByText('Setup incomplete')).toHaveCount(0);await page.reload();await expect(page.getByText('Setup incomplete')).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Create Canvas'}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(modal).toHaveCSS('height','844px');await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>document.activeElement?.closest('dialog')?.id)).toBe('dialog');await page.keyboard.press('Escape');await expect(modal).not.toBeVisible();expect(errors).toEqual([]);
 expect(nativeSignatures).toBe(4);console.log(JSON.stringify({fixture:true,createCalls,bindCalls,nativeSignatures,checks:['four-step modal','required-field focus','close/reopen preservation','focus restoration','connection pending/success/failure','passing test does not bind','empty workspace refresh','workspace selection preserved on Back and close/reopen','idempotent Canvas creation','exact namespace authorization for installation-wide connector','failed probe remains incomplete','confirm saves and launches','authoritative listing after return and reload','mobile sizing','keyboard focus trap and Escape','no browser errors']}));
}finally{await browser.close();key.fill(0);}
