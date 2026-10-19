// Browser regression against a synthetic API. It never changes a real Canvas.
import {chromium,expect} from '@playwright/test';

const adminOrigin='https://napplet-delete-admin.fixture',ownerOrigin='https://napplet-delete-owner.fixture';
const workshopId=crypto.randomUUID(),projectId=crypto.randomUUID(),revisionId=crypto.randomUUID(),admin='a'.repeat(64),owner='b'.repeat(64);
const project={id:projectId,owner,title:'Weather Desk',description:'Fixture Napplet',current_revision:revisionId,shared_revision:null,source_hash:'c'.repeat(64),number:1,created_at:1,appVersionUrl:null};
const member=(isOwner:boolean)=>isOwner?{pubkey:owner,name:'Owner',host:true,admin:false,identity_type:'extension',state:'admitted'}:{pubkey:admin,name:'Administrator',host:true,admin:true,identity_type:'extension',state:'admitted'};
const room=(isOwner:boolean,present:boolean)=>({room:{id:workshopId,title:'Fixture Canvas',introduction:'Deletion browser regression',pictures:[],lightning:'',support_label:'Support',paused:false,admission:'open'},member:member(isOwner),workshopId,projects:present?[project]:[],gallery:[],starters:[],board:{version:present?1:2,objects:[...(present?[{id:projectId,kind:'napplet',projectId,x:24,y:24,width:440,height:424,groupId:null}]:[]),{id:'workshop-donation',kind:'donation',x:500,y:24,width:320,height:240,groupId:null}],napplets:present?[project]:[]},additionalProjectsAvailable:true});
const source=await Bun.file('public/app.js').text(),bootstrap="try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }";
const fixtureSource=source.replace(bootstrap,`const fixtureOwner=location.origin.includes('owner');selectedWorkshop=${JSON.stringify(workshopId)};state=${JSON.stringify(room(false,true))};state.member=fixtureOwner?${JSON.stringify(member(true))}:${JSON.stringify(member(false))};setMember(state.member);csrf='fixture';screen='page';render();`);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
  let present=true;const deleteCalls:any[]=[],errors:string[]=[];
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),isOwner=url.origin===ownerOrigin;
    if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:await Bun.file('public/index.html').text()});return;}
    if(url.pathname==='/app.js'){await route.fulfill({contentType:'application/javascript',body:fixtureSource});return;}
    if(['/activity-time.js','/chat-attachments.js','/invitation-url.js','/napplet-host.js','/napplet-cache.js','/canvas-host.js','/canvas-images.js','/identity.js'].includes(url.pathname)){await route.fulfill({contentType:'application/javascript',body:await Bun.file('public'+url.pathname).text()});return;}
    if(url.pathname==='/style.css'){await route.fulfill({contentType:'text/css',body:await Bun.file('public/style.css').text()});return;}
    if(url.pathname==='/api/v1/browser-origin'){await route.fulfill({json:{origin:url.origin}});return;}
    if(url.pathname==='/api/v1/room'&&request.method()==='GET'){await route.fulfill({json:room(isOwner,present)});return;}
    if(url.pathname==='/api/v1/workshops'&&request.method()==='GET'){await route.fulfill({json:{workshops:[],legacyWorkshopId:workshopId}});return;}
    if(url.pathname===`/api/v1/projects/${projectId}`&&request.method()==='DELETE'){
      deleteCalls.push(request.postDataJSON());expect(request.headers()['x-csrf-token']).toBe('fixture');
      if(isOwner){await route.fulfill({status:403,json:{error:'Site administrator access required'}});return;}
      present=false;await route.fulfill({json:{deletedNappletId:projectId,externalArtifactsRetained:true,nativeLifecycleFenced:true,requestsCancelled:1}});return;
    }
    await route.fulfill({status:404,json:{error:'Fixture route not found'}});
  });

  const ownerPage=await context.newPage();ownerPage.on('pageerror',error=>errors.push(error.message));await ownerPage.goto(ownerOrigin);await expect(ownerPage.getByRole('button',{name:'Settings for Weather Desk'})).toBeVisible();await ownerPage.getByRole('button',{name:'Settings for Weather Desk'}).click();await expect(ownerPage.getByRole('button',{name:'Delete Napplet'})).toHaveCount(0);

  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(adminOrigin);await page.getByRole('button',{name:'Settings for Weather Desk'}).click();await page.getByRole('button',{name:'Delete Napplet'}).click();
  const dialog=page.locator('#dialog');await expect(dialog).toContainText('Delete Weather Desk?');await expect(dialog).toContainText('External publication artifacts and native transcripts are not erased.');
  const submit=page.getByRole('button',{name:'Permanently delete Napplet'}),confirmation=page.getByLabel('Type Weather Desk to permanently delete this Napplet');
  await expect(submit).toBeDisabled();await confirmation.fill('weather desk');await expect(submit).toBeDisabled();await confirmation.fill('Weather Desk');await expect(submit).toBeEnabled();
  await page.getByRole('button',{name:'Cancel'}).click();await expect(dialog).not.toBeVisible();expect(deleteCalls).toEqual([]);

  await page.getByRole('button',{name:'Settings for Weather Desk'}).click();await page.getByRole('button',{name:'Delete Napplet'}).click();await confirmation.fill('Weather Desk');await submit.click();
  await expect(dialog).not.toBeVisible();await expect(page.getByRole('button',{name:'Settings for Weather Desk'})).toHaveCount(0);expect(deleteCalls).toHaveLength(1);
  expect(deleteCalls[0]).toEqual({confirmTitle:'Weather Desk',confirmPermanent:true,expectedRevisionId:revisionId});expect(errors).toEqual([]);
  await context.close();
}finally{await browser.close();}
