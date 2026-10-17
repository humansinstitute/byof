/** Local production app browser coverage; no live builder or activation required. */
import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {createFreedomServer} from '../src/server.ts';
const evidence='tmp/docs/handoffs/mobile-tabs';mkdirSync(evidence,{recursive:true});
const dataDir=mkdtempSync(evidence+'/fixture-'),key=generateSecretKey(),owner=getPublicKey(key);
const config={dataDir,hostPubkey:owner,origin:null as string|null,version:'mobile-tabs-local'};
const runtime=createFreedomServer(config,0),{app,server}=runtime;config.origin=`http://127.0.0.1:${server.port}`;
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,key));await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)}});
 app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Mobile fixture','extension','admitted',20,1]);
 const project=app.workshop.create(app.auth.member(owner),'dice').project;
 const token=crypto.randomUUID(),hash=createHash('sha256').update(token).digest('hex');
 app.db.run('INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)',[hash,owner,'csrf',Math.floor(Date.now()/1000)+3600,'extension']);
 await page.context().addCookies([{name:'lf_session',value:token,url:config.origin,httpOnly:true,sameSite:'Strict'}]);
 await page.goto(config.origin+'/?workshop='+app.workshop.id+'&project='+project.id);
 const preview=page.getByRole('tab',{name:'Preview',exact:true}),chat=page.getByRole('tab',{name:'Chat',exact:true});
 await expect(preview).toHaveAttribute('aria-selected','true');
 const frame=page.locator('#builder-preview iframe');await expect(frame).toBeVisible();
 await page.evaluate(()=>{(window as any).originalFrame=document.querySelector('#builder-preview iframe');(window as any).originalWindow=(window as any).originalFrame.contentWindow;});
 const appFrame=page.frameLocator('#builder-preview iframe');
 await appFrame.locator('#go').evaluate(button=>(button as HTMLButtonElement).click());
 await expect(appFrame.locator('#rolls span')).toHaveCount(100);
 const requests:string[]=[];page.on('request',r=>{if(/\/preview(?:\?|$)/.test(r.url()))requests.push(r.url());});
 await chat.click();await page.getByLabel('Your next question or change').fill('A draft that must survive');
 const history=page.locator('.conversation-history');await history.evaluate(el=>{el.insertAdjacentHTML('beforeend','<p id="history-marker">Saved history marker</p>');});
 for(let i=0;i<3;i++){await preview.click();await expect(frame).toBeVisible();await chat.click();await expect(page.getByLabel('Your next question or change')).toHaveValue('A draft that must survive');await expect(page.locator('#history-marker')).toBeVisible();}
 await history.evaluate(el=>{el.insertAdjacentHTML('beforeend','<div style="height:1800px">Long history</div>');el.scrollTop=200;});
 const scrollTop=await history.evaluate(el=>el.scrollTop);await preview.click();await chat.click();expect(await history.evaluate(el=>el.scrollTop)).toBe(scrollTop);
 await history.evaluate(el=>el.scrollTop=0);
 await expect(appFrame.locator('#rolls span')).toHaveCount(100);
 expect(await page.evaluate(()=>document.querySelector('#builder-preview iframe')===(window as any).originalFrame&&(window as any).originalFrame.contentWindow===(window as any).originalWindow)).toBe(true);expect(requests).toEqual([]);
 await chat.focus();await page.keyboard.press('ArrowLeft');await expect(preview).toBeFocused();await expect(preview).toHaveAttribute('aria-selected','true');
 const options=page.locator('#builder-options>summary');await options.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('navigation',{name:'Napplet options'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Revoke Napplet permissions',exact:true})).toBeVisible();
 for(const name of ['Rename Napplet','Completion sound: on','Select version for publication →','← BYOF Canvas page'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Completion sound: on',exact:true}).click();await expect(page.getByRole('button',{name:'Completion sound: off'})).toHaveAttribute('aria-pressed','false');
 await page.keyboard.press('Escape');await expect(options).toBeFocused();await expect(page.locator('#builder-options')).not.toHaveAttribute('open','');
 for(const width of [320,390,768,900]){
  await page.setViewportSize({width,height:844});
  for(const tab of [preview,chat]){await tab.click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await options.click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.keyboard.press('Escape');
 }
 await page.setViewportSize({width:390,height:844});await preview.click();await page.screenshot({path:evidence+'/preview.png'});await chat.click();await page.screenshot({path:evidence+'/chat.png'});await options.click();await page.screenshot({path:evidence+'/options.png'});
 await page.setViewportSize({width:1440,height:1000});await expect(frame).toBeVisible();await expect(page.getByLabel('Your next question or change')).toBeVisible();await expect(preview).toBeHidden();await expect(page.getByRole('button',{name:'Rename Napplet',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Completion sound: off'})).toBeVisible();
 expect(await frame.evaluate(el=>el.getBoundingClientRect().left)).toBeGreaterThan(await history.evaluate(el=>el.getBoundingClientRect().left));
 expect(await page.evaluate(()=>document.querySelector('#builder-preview iframe')===(window as any).originalFrame&&(window as any).originalFrame.contentWindow===(window as any).originalWindow)).toBe(true);
 await page.screenshot({path:evidence+'/desktop.png'});
 const other=getPublicKey(generateSecretKey());app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[other,'Other participant','extension','admitted',20,1]);
 const inspected=app.workshop.create(app.auth.member(other),'dice').project;
 await page.setViewportSize({width:390,height:844});await page.goto(config.origin+'/?workshop='+app.workshop.id+'&project='+inspected.id);
 await page.locator('#builder-options>summary').click();await expect(page.getByRole('button',{name:'Rename Napplet',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Select version for publication →',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await page.getByRole('tab',{name:'Chat',exact:true}).click();await expect(page.getByText("Host actions are attributed to your account and use the project owner's allowance.",{exact:true})).toBeVisible();
 expect(errors).toEqual([]);
 const result={mode:'Local production server and Chrome, synthetic signed-in owner; no live activation',checks:['mobile tabs and keyboard navigation','same iframe element and contentWindow, no preview reload','running starter score, draft and history scroll retained','keyboard options, Escape focus, existing controls and sound toggle','320/390/768/900 widths without horizontal overflow','desktop side-by-side, controls restored, iframe retained','host inspection omits owner rename and publication controls'],errors};
 await Bun.write(evidence+'/evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();runtime.stop();rmSync(dataDir,{recursive:true,force:true});}
