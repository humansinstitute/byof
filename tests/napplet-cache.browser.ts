// Real Chromium + application acceptance. Uses isolated local data and no managed app.
import {chromium,expect,type Page} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';

const dataDir=mkdtempSync('/tmp/freedom-napplet-cache-browser-'),secret=generateSecretKey();
const app=application({dataDir,hostPubkey:getPublicKey(secret),origin:null,version:'cache-browser'});app.db.run("UPDATE room SET admission='open' WHERE id=1");
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
async function openCanvas(page:Page){await page.waitForFunction(()=>document.querySelector('.board-viewport')||Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Open Canvas'));if(!await page.locator('.board-viewport').count())await page.getByRole('button',{name:'Open Canvas',exact:true}).first().click();await expect(page.locator('.board-viewport')).toBeVisible();}
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('testSign',(event:any)=>finalizeEvent(event,secret));await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).testSign(event)};});
 await page.goto(server.url.href);await page.getByRole('button',{name:'Log in with browser extension',exact:true}).click();await openCanvas(page);
 const created=await page.evaluate(async()=>{const me=await(await fetch('/api/v1/me')).json();return (await(await fetch('/api/v1/projects',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify({starterId:'dice'})})).json()).project;});
 await page.reload();await openCanvas(page);
 await expect(page.locator(`[data-project-id="${created.id}"] iframe`)).toHaveAttribute('data-runtime-ready','true');await expect(page.locator(`[data-project-id="${created.id}"] iframe`).contentFrame().getByRole('heading',{name:'100 D6 rolls'})).toBeVisible();
 await page.locator(`[data-project-id="${created.id}"] iframe`).contentFrame().locator('#go').click();await expect(page.locator(`[data-project-id="${created.id}"] iframe`).contentFrame().locator('#rolls span')).toHaveCount(100);
 await page.evaluate(async()=>{for(const key of await caches.keys())await caches.delete(key);});
 const requests={room:0,runtime:0,payload:0};page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/api/v1/room')requests.room++;if(path.endsWith('/runtime'))requests.runtime++;if(path.endsWith('/payload'))requests.payload++;});
 const frame=()=>page.locator(`[data-project-id="${created.id}"] iframe`),content=()=>frame().contentFrame();
 await page.reload();await openCanvas(page);await expect(frame()).toHaveAttribute('data-runtime-ready','true');await expect(content().getByRole('heading',{name:'100 D6 rolls'})).toBeVisible();expect({...requests}).toEqual({room:1,runtime:1,payload:1});expect(await frame().getAttribute('data-cache-hit')).toBe('false');
 await page.reload();await openCanvas(page);await expect(frame()).toHaveAttribute('data-runtime-ready','true');await expect(content().getByRole('heading',{name:'100 D6 rolls'})).toBeVisible();expect({...requests}).toEqual({room:2,runtime:2,payload:1});expect(await frame().getAttribute('data-cache-hit')).toBe('true');
 await content().locator('#go').click();await expect(content().locator('#rolls span')).toHaveCount(100);
 const firstRevision=created.current_revision,project=app.db.query('SELECT * FROM projects WHERE id=?').get(created.id) as any;
 await page.goto('about:blank');const changed=app.workshop.addRevision(project,app.workshop.assets.put('<!doctype html><html><body><h1>Changed version</h1><button onclick="this.textContent=\'Working\'">Try latest</button></body></html>'),getPublicKey(secret));
 await page.goto(server.url.href);await openCanvas(page);await expect(frame()).toHaveAttribute('data-runtime-ready','true');await expect(content().getByRole('heading',{name:'Changed version'})).toBeVisible();await content().getByRole('button',{name:'Try latest'}).click();await expect(content().getByRole('button',{name:'Working'})).toBeVisible();expect(requests.payload).toBe(2);expect(await frame().getAttribute('data-cache-hit')).toBe('false');
 await page.goto('about:blank');app.db.run('UPDATE projects SET current_revision=? WHERE id=?',[firstRevision,created.id]);
 await page.goto(server.url.href);await openCanvas(page);await expect(frame()).toHaveAttribute('data-runtime-ready','true');await expect(content().getByRole('heading',{name:'100 D6 rolls'})).toBeVisible();expect(requests.payload).toBe(2);expect(await frame().getAttribute('data-cache-hit')).toBe('true');
 expect(requests.room).toBe(4);expect(requests.runtime).toBe(4);expect(errors).toEqual([]);
 console.log(JSON.stringify({...requests,changed,olderVersionCacheHit:true,isolatedRealApplication:true}));await context.close();
}finally{await browser.close();server.stop(true);app.db.close();rmSync(dataDir,{recursive:true,force:true});}
