/** UI contract test with synthetic Tower responses. Live backend acceptance is separate. */
import { chromium,expect } from '@playwright/test';
import { generateSecretKey,finalizeEvent,verifyEvent,nip19,getPublicKey } from 'nostr-tools';
import { sha256 } from '../src/assets.ts';
import { mkdirSync } from 'node:fs';
const [adapterPath,evidence]=Bun.argv.slice(2);
if(!adapterPath||!evidence||Bun.spawnSync(['git','check-ignore',evidence]).exitCode!==0)throw Error('Usage: bun scripts/tower-connect-browser-acceptance.ts ignored-host-api-adapter.ts ignored-evidence-directory');
const {hostApi,origin}=await import(new URL(adapterPath,`file://${process.cwd()}/`).href),{cookie}=await hostApi();
mkdirSync(evidence,{recursive:true});
const secret=generateSecretKey(),appNpub=nip19.npubEncode('a'.repeat(64)),towerOrigin='https://synthetic-tower.example',workspaceId=crypto.randomUUID(),createdId=crypto.randomUUID(),towerId='synthetic-connector';
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const proof:any={mode:'Synthetic UI contract; no real Tower requests or storage objects',checks:[]};
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'lf_session',value:cookie.slice('lf_session='.length),url:origin,httpOnly:true,secure:true,sameSite:'Strict'}]);
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('syntheticSign',(event:any)=>finalizeEvent(event,secret));await page.addInitScript(()=>{(window as any).nostr={signEvent:(e:any)=>(window as any).syntheticSign(e)};});
  let created=false,binds=0,createCalls=0,fail=true,ready=false,otherTower=false;const storage=()=>({configured:true,namespaceReady:ready,appNpub,towerOrigin,localRoot:'/synthetic/napplets',...(binds?{binding:{status:ready?'ready':'probing',target:{workspaceId:createdId}},probe:{error:null}}:{})});
  const entries=()=>[{label:'Existing workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:nip19.npubEncode(getPublicKey(secret))}},...(created?[{label:'Created workspace',identity:{workspace_id:createdId,workspace_owner_npub:nip19.npubEncode(getPublicKey(secret))}}]:[])];
  const assertEvent=(event:any,url:string,method:string,body?:any)=>{expect(verifyEvent(event)).toBe(true);expect(event.tags.find((t:string[])=>t[0]==='u')?.[1]).toBe(url);expect(event.tags.find((t:string[])=>t[0]==='method')?.[1]).toBe(method);if(body)expect(event.tags.find((t:string[])=>t[0]==='payload')?.[1]).toBe(sha256(JSON.stringify(body)));};
  await page.route(origin+'/api/v1/site/towers',route=>route.fulfill({json:{towers:[{id:towerId,label:'Synthetic Tower',origin:towerOrigin}]}}));
  await page.route(origin+'/api/v1/host/storage',route=>route.fulfill({json:storage()}));
  await page.route(origin+'/api/v1/site/towers/'+towerId+'/*',async route=>{
   const action=new URL(route.request().url()).pathname.split('/').pop(),body=route.request().postDataJSON();
   if(action==='connect'){assertEvent(body.event,towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET');await route.fulfill({json:{workspaces:entries(),storage:otherTower?{configured:false,otherTower:true}:storage()}});}
   if(action==='create-intent'){await route.fulfill({json:{url:towerOrigin+'/api/v4/admin/flightdeck-pg/workspaces',payload:{creator_npub:nip19.npubEncode(getPublicKey(secret)),workspace_name:body.workspaceName,app_npub:appNpub}}});}
   if(action==='create'){createCalls++;assertEvent(body.event,towerOrigin+'/api/v4/admin/flightdeck-pg/workspaces','POST',{creator_npub:nip19.npubEncode(getPublicKey(secret)),workspace_name:body.workspaceName,app_npub:appNpub});created=true;await route.fulfill({json:{workspace_id:createdId}});}
   if(action==='bind'){binds++;expect(body.workspaceId).toBe(createdId);expect(body.namespaceEvent).toBeUndefined();assertEvent(body.event,`${towerOrigin}/api/v4/flightdeck-pg/workspaces/${createdId}/invites`,'POST',{invitee_npub:appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'});await route.fulfill({json:storage()});}
  });
  await page.route(origin+'/api/v1/host/storage/probe',async route=>{if(fail){fail=false;await route.fulfill({json:{...storage(),probe:{error:'Synthetic private readback failure'}}});}else{ready=true;await route.fulfill({json:storage()});}});
  await page.goto(origin);await page.getByRole('button',{name:'Open identity menu'}).click();await page.getByRole('button',{name:/^Site (Admin|administration)$/}).click();await page.getByRole('button',{name:'Connect Tower',exact:true}).click();await expect(page.getByRole('heading',{name:'Choose a workspace',exact:true})).toBeVisible();
  await page.getByLabel('New workspace name',{exact:true}).fill('Created workspace');await page.getByRole('button',{name:'Create workspace',exact:true}).click();await expect(page.locator('#tower-setup-error')).toContainText('Workspace created');expect(binds).toBe(0);
  await page.getByRole('button',{name:'Created workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Storage setup needs attention',exact:true})).toBeVisible();await expect(page.getByRole('alert')).toContainText('Synthetic private readback failure');await page.screenshot({path:evidence+`/${width}-retry.png`,fullPage:true});
  await page.getByRole('button',{name:'Retry setup',exact:true}).click();await expect(page.getByRole('heading',{name:'Ready',exact:true})).toBeVisible();expect(createCalls).toBe(1);expect(binds).toBe(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);await page.screenshot({path:evidence+`/${width}-ready.png`,fullPage:true});await page.getByRole('button',{name:'Close',exact:true}).click();otherTower=true;await page.getByRole('button',{name:'Connect Tower',exact:true}).click();await expect(page.getByRole('heading',{name:'Tower account connected',exact:true})).toBeVisible();await expect(page.locator('#dialog')).toContainText('Its saved destination is unchanged');await expect(page.locator('#main [role=status]')).toContainText('Ready · private storage verified');expect(binds).toBe(2);await page.screenshot({path:evidence+`/${width}-additional-account.png`,fullPage:true});proof.checks.push({width,additionalAccountPreservesReady:true,explicitSelection:true,directAdminSignature:true,scopedGrant:true,automaticProvisioningProgress:true,failureRetry:true,noDuplicateCreation:true,noOverflow:true});await context.close();
 }
 await Bun.write(evidence+'/results.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{secret.fill(0);await browser.close();}
