import { chromium, expect, type Page } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { application } from '../src/application.ts';

// Real Chrome and API, isolated data, synthetic NIP-07 signer; no registered app.
const evidence = 'tmp/docs/handoffs/napplet-window-evidence';
mkdirSync(evidence, {recursive:true});
const secret = generateSecretKey();
const app = application({dataDir:mkdtempSync(evidence+'/data-'),hostPubkey:getPublicKey(secret),origin:null,version:'embeds-acceptance'});
const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser = await chromium.launch({executablePath:process.env.FREEDOM_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const checks:any[]=[];
async function openCanvas(page:Page){await page.waitForFunction(()=>document.querySelector('.board-viewport')||Array.from(document.querySelectorAll<HTMLButtonElement>('button')).some(button=>button.textContent?.trim()==='Open Canvas'));if(await page.locator('.board-viewport').count())return;await page.getByRole('button',{name:'Open Canvas',exact:true}).first().click();await expect(page.locator('.board-viewport')).toBeVisible();}
async function signIn(page:Page, key:Uint8Array) {
  page.setDefaultTimeout(10000);
  await page.exposeFunction('syntheticSign',(event:any)=>finalizeEvent(event,key));
  await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).syntheticSign(event)};});
  await page.goto(server.url.href);
  await page.getByRole('button',{name:'Log in with browser extension',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open identity menu'})).toBeVisible();
  await openCanvas(page);
}
try {
 for (const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await signIn(page,secret);
  await expect(page.locator('body')).not.toHaveAttribute('aria-busy','true');
  if(width===1440) await page.evaluate(async()=>{
    const account=await (await fetch('/api/v1/me')).json();
    const response=await fetch('/api/v1/projects',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':account.csrf},body:JSON.stringify({starterId:'dice'})});
    if(!response.ok)throw Error('Fixture project creation failed');
  });
  await page.reload();await openCanvas(page);await expect(page.locator('.napplet-card[data-project-id]')).toHaveCount(1);
  console.log('Checking window',width);
  const title=`<Game ${width}> & "friends"`;
  const card=page.locator('.napplet-card[data-project-id]').first(),frame=card.frameLocator('iframe');
  await expect(page.getByRole('heading',{name:'Napplet gallery',exact:true})).toHaveCount(0);
  await expect(card.locator('.eyebrow,.muted,.preview-controls')).toHaveCount(0);
  expect(await card.locator('.window-bar').evaluate(el=>el.getBoundingClientRect().height)).toBeLessThanOrEqual(45);
  expect(await card.locator('iframe').evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(width===390?140:380);
  await expect.poll(()=>frame.locator('body').evaluate(()=>document.readyState)).toBe('complete');await card.locator('iframe').click({position:{x:5,y:5}});await frame.getByRole('button',{name:'Go'}).press('Enter');await expect(frame.locator('#rolls span')).toHaveCount(100);
  const sources=await page.locator('iframe').evaluateAll(frames=>frames.map(f=>f.getAttribute('src')));expect(new Set(sources).size).toBe(sources.length);
  console.log('Settings',width);await card.getByRole('button',{name:/Settings for/}).click();await expect(page.getByRole('button',{name:'Rename',exact:true})).toBeFocused();await expect(page.getByRole('button',{name:'Edit your Napplet!',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Fork this Napplet and make it your own!',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Window options',exact:true})).toHaveCount(0);expect(await page.locator('#dialog').evaluate(el=>el.getBoundingClientRect().width<=innerWidth)).toBe(true);await page.keyboard.press('Escape');await expect(card.getByRole('button',{name:/Settings for/})).toBeFocused();
  let loads=0;page.on('request',r=>{if(r.url().includes('/preview?')){loads++;}});
  console.log('Settings',width);await card.getByRole('button',{name:/Settings for/}).click();await page.getByRole('button',{name:'Rename',exact:true}).click();
  await page.getByLabel('Napplet title').fill(title+' renamed');await page.getByRole('button',{name:'Save name'}).click();
  await expect(card.locator('.window-bar h2')).toHaveText(title+' renamed');await expect(frame.locator('#rolls span')).toHaveCount(100);
  await page.getByRole('button',{name:'Open identity menu'}).click();await page.getByRole('button',{name:'Open identity menu'}).click();
  await expect(frame.locator('#rolls span')).toHaveCount(100);
  console.log('Minimize',width);await card.getByRole('button',{name:/Minimize /}).click();
  await expect(card.locator('iframe')).toBeHidden();
  await page.getByRole('button',{name:'Open identity menu'}).click();await page.getByRole('button',{name:'Open identity menu'}).click();
  await expect(card.getByRole('button',{name:/Restore /})).toHaveAttribute('aria-expanded','false');
  await card.getByRole('button',{name:/Restore /}).focus();await page.keyboard.press('Enter');
  await expect(frame.locator('#rolls span')).toHaveCount(100);
  const opener=card.getByRole('button',{name:'Open '+title+' renamed in larger viewer',exact:true});
  console.log('Minimize',width);await card.getByRole('button',{name:/Minimize /}).click();
  for(const mode of ['native','denied','unsupported']) {
   console.log('Expand',width,mode);await opener.click();const viewer=page.locator('.expanded-viewer');
   expect(await viewer.evaluate(el=>el.matches(':modal'))).toBe(true);
   await expect(viewer.locator('iframe')).toHaveAttribute('sandbox','allow-scripts allow-forms');
   await expect(frame.locator('#rolls span')).toHaveCount(100);
   if(mode!=='native')await page.evaluate(mode=>Object.defineProperty(document.documentElement,'requestFullscreen',{configurable:true,value:mode==='denied'?()=>Promise.reject(Error('denied')):undefined}),mode);
   await viewer.getByRole('button',{name:'Full screen',exact:true}).click();
   if(mode==='native')await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
   else await expect(viewer).toHaveClass(/viewport-fullscreen/);
   await frame.getByRole('button',{name:'Go'}).focus();await page.keyboard.press('Enter');await expect(frame.locator('#rolls span')).toHaveCount(100);
   await viewer.getByRole('button',{name:'Exit full screen'}).click();
   await viewer.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Tab');
   await expect.poll(()=>page.evaluate(()=>!!document.activeElement?.closest('.expanded-viewer'))).toBe(true);
   if(mode==='native')await viewer.getByRole('button',{name:'Close',exact:true}).click();
   else {await frame.getByRole('button',{name:'Go'}).focus();await page.keyboard.press('Escape');}
   await expect(page.locator('.expanded-viewer')).toHaveCount(0);await expect(opener).toBeFocused();await expect(frame.locator('#rolls span')).toHaveCount(100);
   // Reset only by interacting with the game, to repeat identical assertions.
   await frame.getByRole('button',{name:'Reset',exact:true}).focus();await page.keyboard.press('Enter');
   await expect(frame.locator('#rolls span')).toHaveCount(100);
   await frame.getByRole('button',{name:'Go'}).focus();await page.keyboard.press('Enter');
   await expect(frame.locator('#rolls span')).toHaveCount(100);
  }
  await page.evaluate(()=>{delete (document.documentElement as any).requestFullscreen;});
  expect(loads).toBe(0);
  await page.screenshot({path:`${evidence}/${width}-inline.png`,fullPage:true});
  await opener.click();await page.screenshot({path:`${evidence}/${width}-modal.png`});await page.keyboard.press('Escape');
  await page.reload();await openCanvas(page);await expect(page.locator('.napplet-card[data-project-id]').first().locator('.window-bar h2')).toHaveText(title+' renamed');
  if(width===1440){console.log('Settings',width);await card.getByRole('button',{name:/Settings for/}).click();await page.getByRole('button',{name:'Edit your Napplet!'}).click();await page.getByRole('button',{name:/Select (?:version|v\d+) for publication →/}).click();await page.getByRole('button',{name:/Select v\d+ →/}).click();}
  expect(errors).toEqual([]);checks.push({width,own:'380px viewport, 44px title-only bar, settings/Escape/focus return, rename, minimize/rerender/keyboard restore, expand minimized, native/denied/unsupported fullscreen, focus/Escape, zero reloads',errors});await context.close();
 }
 // A different admitted participant plays only the pinned shared revision.
 const room:any=app.workshop.room(app.workshop.scoped({pubkey:getPublicKey(secret),admin:true} as any));
 app.db.run("UPDATE room SET admission='open' WHERE id=1");
 const context=await browser.newContext(),page=await context.newPage();await signIn(page,generateSecretKey());
 const shared=page.locator('.napplet-card[data-project-id]').first(),frame=shared.frameLocator('iframe');
 await expect(shared.getByRole('button',{name:/Options for/})).toBeVisible();
 await expect.poll(()=>frame.locator('body').evaluate(()=>document.readyState)).toBe('complete');await frame.getByRole('button',{name:'Go'}).click();await expect(frame.locator('#rolls span')).toHaveCount(100);
 const src=await shared.locator('iframe').getAttribute('src');expect(src).toContain(room.gallery[0].shared_revision);
 await shared.getByRole('button',{name:/in larger viewer/}).click();await expect(frame.locator('#rolls span')).toHaveCount(100);await page.keyboard.press('Escape');await expect(frame.locator('#rolls span')).toHaveCount(100);
 await expect(shared.getByRole('button',{name:/Settings for/})).toHaveCount(0);
 await shared.getByRole('button',{name:/Options for/}).click();await expect(page.getByRole('button',{name:'Fork this Napplet and make it your own!',exact:true})).toBeFocused();await expect(page.getByRole('button',{name:'Rename',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Edit your Napplet!',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Window options',exact:true})).toHaveCount(0);await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>document.activeElement?.closest('#dialog')?.id)).toBe('dialog');await page.getByRole('button',{name:'Close Napplet actions'}).click();await expect(shared.getByRole('button',{name:/Options for/})).toBeFocused();
 await shared.getByRole('button',{name:/Options for/}).click();await page.mouse.click(5,5);await expect(page.locator('#dialog')).not.toBeVisible();await expect(shared.getByRole('button',{name:/Options for/})).toBeFocused();
 await shared.getByRole('button',{name:/Options for/}).click();await page.getByRole('button',{name:'Fork this Napplet and make it your own!',exact:true}).click();await expect(page.getByText(/Your project · Canvas v1/)).toBeVisible();await expect(page.getByRole('heading',{name:/— fork$/})).toBeVisible();await page.reload();await openCanvas(page);await expect(page.getByRole('heading',{name:/— fork$/})).toBeVisible();
 checks.push({gallery:'different participant sees Fork only, creates a persistent independent builder copy, and modal close returns focus'});await context.close();
 await Bun.write(evidence+'/results.json',JSON.stringify({proof:'Synthetic signer, isolated real API and Chrome',checks},null,2));console.log(JSON.stringify({checks,evidence}));
}catch(error){for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:evidence+'/failure.png',fullPage:true});await Bun.write(evidence+'/failure.txt',await page.locator('body').innerText());}throw error;}finally{await browser.close();server.stop(true);app.db.close();}
