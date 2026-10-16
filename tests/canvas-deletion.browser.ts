// Browser UI against a synthetic API. No live Canvas, storage, or publication data is changed.
import {chromium,expect} from '@playwright/test';

const ownerOrigin='https://canvas-delete-owner.fixture',participantOrigin='https://canvas-delete-participant.fixture';
const owner='a'.repeat(64),participant='b'.repeat(64),successId=crypto.randomUUID(),errorId=crypto.randomUUID(),legacyId=crypto.randomUUID();
const initial=[
  {id:successId,title:'Project Sunrise',introduction:'Delete this Canvas',owner,canManage:true,canDelete:true,legacy:false,overview:{nappletCount:2,decorationCount:1}},
  {id:errorId,title:'Keep On Failure',introduction:'This deletion fails',owner,canManage:true,canDelete:true,legacy:false,overview:{nappletCount:1,decorationCount:0}},
  {id:legacyId,title:'Default Canvas',introduction:'Bootstrap Canvas',owner,canManage:true,canDelete:false,legacy:true,overview:{nappletCount:0,decorationCount:0}}
];
const source=await Bun.file('public/app.js').text(),bootstrap="try { const result = await api('me'); setMember(result.member); csrf = result.csrf; await enterAfterSignIn(); } catch { screen = 'start'; render(); }";
const fixtureSource=source.replace(bootstrap,`const fixtureParticipant=location.origin.includes('participant');setMember(fixtureParticipant?${JSON.stringify({pubkey:participant,name:'Participant',host:false,admin:false,identity_type:'extension',state:'admitted'})}:${JSON.stringify({pubkey:owner,name:'Canvas owner',host:true,admin:false,identity_type:'extension',state:'admitted'})});csrf='fixture';await workshopsPage();`);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
  const remaining=structuredClone(initial),deleteCalls:string[]=[],errors:string[]=[];
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),isParticipant=url.origin===participantOrigin;
    if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:await Bun.file('public/index.html').text()});return;}
    if(url.pathname==='/app.js'){await route.fulfill({contentType:'application/javascript',body:fixtureSource});return;}
    if(['/activity-time.js','/chat-attachments.js','/invitation-url.js','/napplet-host.js','/canvas-host.js','/identity.js'].includes(url.pathname)){await route.fulfill({contentType:'application/javascript',body:await Bun.file('public'+url.pathname).text()});return;}
    if(url.pathname==='/style.css'){await route.fulfill({contentType:'text/css',body:await Bun.file('public/style.css').text()});return;}
    if(url.pathname==='/api/v1/browser-origin'){await route.fulfill({json:{origin:url.origin}});return;}
    if(url.pathname==='/api/v1/workshops'&&request.method()==='GET'){
      await route.fulfill({json:{workshops:remaining.map(item=>isParticipant?{...item,canManage:false,canDelete:false}:item),legacyWorkshopId:legacyId}});return;
    }
    const deletion=url.pathname.match(/^\/api\/v1\/workshops\/([a-f0-9-]{36})$/);
    if(deletion&&request.method()==='DELETE'){
      deleteCalls.push(deletion[1]!);
      if(isParticipant){await route.fulfill({status:403,json:{error:'Canvas owner or site administrator access required'}});return;}
      const canvas=remaining.find(item=>item.id===deletion[1]),body=request.postDataJSON();
      expect(request.headers()['x-csrf-token']).toBe('fixture');expect(body).toMatchObject({confirmTitle:canvas?.title,confirmPermanent:true});
      if(deletion[1]===errorId){await route.fulfill({status:500,json:{error:'Synthetic transaction failure'}});return;}
      remaining.splice(remaining.findIndex(item=>item.id===deletion[1]),1);
      await route.fulfill({json:{deletedCanvasId:deletion[1],externalDataRetained:true,message:'Canvas deleted; external data retained'}});return;
    }
    await route.fulfill({status:404,json:{error:'Fixture route not found'}});
  });

  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(ownerOrigin);await page.waitForTimeout(250);if(errors.length)throw Error(errors.join('\n'));await expect(page.getByRole('heading',{name:'Canvases'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Delete Canvas'})).toHaveCount(2);
  await expect(page.locator('section.canvas-card').filter({hasText:'Default Canvas'}).getByRole('button',{name:'Delete Canvas'})).toHaveCount(0);

  const sunrise=page.locator('section.canvas-card').filter({hasText:'Project Sunrise'});
  await sunrise.getByRole('button',{name:'Delete Canvas'}).click();
  await expect(page.getByRole('dialog')).toContainText('Delete Project Sunrise Canvas?');
  await expect(page.getByRole('dialog')).toContainText('cannot be undone');
  await expect(page.getByRole('dialog')).toContainText('datasets and published artifacts');
  const permanent=page.getByRole('button',{name:'Permanently delete Canvas'});await expect(permanent).toBeDisabled();
  await page.getByLabel('Type Project Sunrise to confirm').fill('Project');await expect(permanent).toBeDisabled();
  await page.getByLabel('Type Project Sunrise to confirm').fill('Project Sunrise');await expect(permanent).toBeEnabled();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();expect(deleteCalls).toEqual([]);

  const failing=page.locator('section.canvas-card').filter({hasText:'Keep On Failure'});
  await failing.getByRole('button',{name:'Delete Canvas'}).click();await page.getByLabel('Type Keep On Failure to confirm').fill('Keep On Failure');await permanent.click();
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('alert')).toHaveText('Synthetic transaction failure');await expect(failing).toBeVisible();
  expect(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('freedom-canvases:'+'a'.repeat(64))||'[]').some((item:any)=>item.id===id),errorId)).toBe(true);
  await page.getByRole('dialog').getByRole('button',{name:'Close'}).click();

  await page.evaluate(({owner,id})=>sessionStorage.setItem('canvas-create:'+owner,JSON.stringify({workshopId:id,title:'Project Sunrise'})),{owner,id:successId});
  await sunrise.getByRole('button',{name:'Delete Canvas'}).click();await page.getByLabel('Type Project Sunrise to confirm').fill('Project Sunrise');await permanent.click();
  await expect(sunrise).toHaveCount(0);await expect(page.getByRole('heading',{name:'Canvases'})).toBeVisible();expect(new URL(page.url()).searchParams.has('workshop')).toBe(false);
  expect(await page.evaluate(owner=>sessionStorage.getItem('canvas-create:'+owner),owner)).toBeNull();
  expect(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('freedom-canvases:'+'a'.repeat(64))||'[]').some((item:any)=>item.id===id),successId)).toBe(false);

  const participantPage=await context.newPage();participantPage.on('pageerror',error=>errors.push(error.message));await participantPage.goto(participantOrigin);
  await expect(participantPage.getByRole('heading',{name:'Canvases'})).toBeVisible();await expect(participantPage.getByRole('button',{name:'Delete Canvas'})).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
}finally{await browser.close();}
