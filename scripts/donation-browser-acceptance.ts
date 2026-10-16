import decodeQR from 'qr/decode.js';
import {chromium,expect,type Page} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {application} from '../src/application.ts';
// Real isolated application API and synthetic identities; no managed app or payment calls.
const out='tmp/docs/handoffs/donation-browser';mkdirSync(out,{recursive:true});
const key=generateSecretKey(),app=application({dataDir:mkdtempSync(out+'/data-'),hostPubkey:getPublicKey(key),origin:null,version:'donation-acceptance'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
async function signIn(page:Page,secret:Uint8Array){await page.exposeFunction('testSign',(event:any)=>finalizeEvent(event,secret));await page.addInitScript(()=>{(window as any).nostr={signEvent:(e:any)=>(window as any).testSign(e)};});await page.goto(server.url.href);await page.getByRole('button',{name:'Log in with browser extension',exact:true}).click();await expect(page.locator('.board-viewport')).toBeVisible();}
async function api(page:Page,path:string,body?:any){return page.evaluate(async({path,body})=>{const me=await(await fetch('/api/v1/me')).json();const r=await fetch('/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};},{path,body});}
async function decodedDonation(page:Page){const image=page.getByAltText('Lightning donation QR code');const pixels=await image.evaluate(async el=>{const img=el as HTMLImageElement;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);return{width:c.width,height:c.height,data:Array.from(ctx.getImageData(0,0,c.width,c.height).data)};});const payload=decodeQR({...pixels,data:Uint8Array.from(pixels.data)});expect(payload).toBe(await page.getByRole('link',{name:'Open in wallet',exact:true}).getAttribute('href'));return payload;}
const checks:any[]=[];
try{
 app.db.run("UPDATE room SET admission='open' WHERE id=1");
 const hostContext=await browser.newContext(),host=await hostContext.newPage();await signIn(host,key);
 async function configure(lightning:string){const room=(await api(host,'room')).data.room;expect((await api(host,'host/settings',{...room,lightning,paused:!!room.paused})).status).toBe(200);}
 for(const width of [1440,390]){
  await configure('support+workshop@example.com');
  const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await signIn(page,generateSecretKey());
  const card=page.locator('.donation-window'),details=card.locator('.donation-details'),support=card.getByRole('button',{name:'Support this workshop',exact:true}),copy=card.getByRole('button',{name:'Copy address',exact:true}),opener=card.getByRole('button',{name:'Open donation in larger viewer'});
  await page.getByRole('button',{name:'Fit all',exact:true}).click();await expect(details).toBeHidden();const before=(await api(page,'room')).data;
  await support.click();await expect(details).toBeVisible();await expect(card.locator('.donation-address')).toHaveText('support+workshop@example.com');await expect(card.getByRole('link',{name:'Open in wallet'})).toHaveAttribute('href','lightning:support+workshop@example.com');expect(await decodedDonation(page)).toBe('lightning:support+workshop@example.com');
  await copy.click();await expect(card.getByRole('status')).toHaveText('Address copied.');expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('support+workshop@example.com');
  await page.reload();await page.getByRole('button',{name:'Fit all',exact:true}).click();await opener.click();await expect(details).toBeHidden();await support.focus();await page.keyboard.press('Enter');await expect(details).toBeVisible();expect(await details.evaluate(el=>!!el.closest('dialog:modal'))).toBe(true);expect(await decodedDonation(page)).toBe('lightning:support+workshop@example.com');await page.screenshot({path:`${out}/${width}-expanded.png`,fullPage:true});
  await copy.click();await expect(card.getByRole('status')).toHaveText('Address copied.');
  await configure('pending@example.com');
  // Wait for the real application poll while modal rendering remains deferred.
  await expect.poll(async()=> (await api(page,'room')).data.room.lightning).toBe('pending@example.com');
  await page.waitForTimeout(5500);
  await expect(card.locator('.donation-address')).toHaveText('support+workshop@example.com');expect(await decodedDonation(page)).toBe('lightning:support+workshop@example.com');await copy.click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('support+workshop@example.com');
  await page.evaluate(()=>{Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new DOMException('Denied','NotAllowedError');}});});await copy.click();await expect(card.getByRole('status')).toContainText('Could not copy');await expect(copy).toBeEnabled();
  await page.locator('.expanded-viewer').getByRole('button',{name:'Full screen',exact:true}).click();await expect(page.locator('.expanded-viewer').getByRole('button',{name:'Exit full screen'})).toBeVisible();await expect(details).toBeVisible();expect(await decodedDonation(page)).toBe('lightning:support+workshop@example.com');await page.keyboard.press('Escape');await expect(page.locator('.expanded-viewer')).toHaveCount(1);await page.keyboard.press('Escape');await expect(page.locator('.expanded-viewer')).toHaveCount(0);await expect(opener).toBeFocused();
  await expect(card.locator('.donation-address')).toHaveText('pending@example.com',{timeout:15000});expect((await api(page,'room')).data.room).toEqual({...before.room,lightning:'pending@example.com'});expect((await api(page,'room')).data.board).toEqual(before.board);
  // Real host API update arrives through normal polling/events; presentation follows it.
  await configure('updated@example.com');await expect(card.locator('.donation-address')).toHaveText('updated@example.com',{timeout:15000});await expect(details).toBeHidden();await support.click();await expect(details).toBeVisible();await expect(card.getByRole('link',{name:'Open in wallet'})).toHaveAttribute('href','lightning:updated@example.com');expect(await decodedDonation(page)).toBe('lightning:updated@example.com');
  await page.screenshot({path:`${out}/${width}-details.png`,fullPage:true});
  await configure('');await expect(card.getByText('A donation address has not been configured yet.')).toBeVisible({timeout:15000});await expect(support).toHaveCount(0);await expect(copy).toHaveCount(0);await expect(card.locator('.donation-qr')).toHaveCount(0);await opener.click();await expect(page.locator('.expanded-viewer').getByText('A donation address has not been configured yet.')).toBeVisible();await page.keyboard.press('Escape');await expect(opener).toBeFocused();
  expect(errors).toEqual([]);checks.push({width,inlineClick:true,localQRDecode:true,expandedFullscreenQR:true,updatedAndDeferredRecipientQR:true,expandedKeyboardClick:true,clipboardSuccess:true,clipboardDenialFeedback:true,fullscreenEscapeFocus:true,pollingRecipientUpdate:true,missingAddress:true,noClickMutations:true,deferredViewerCopiesDisplayedRecipient:true,errors});await context.close();
 }
 // Save the custom label through the actual host settings form, then reload.
 await host.locator('[data-a="edit"][aria-label="Donation settings"]').click();
 await host.getByLabel('Support button label').fill('Support the Bush Bash!');
 await host.getByLabel('Lightning address', {exact:true}).fill('support@example.com');
 await host.getByRole('button',{name:'Save page →',exact:true}).click();
 await host.reload();await host.getByRole('button',{name:'Fit all',exact:true}).click();
 await expect(host.getByRole('button',{name:'Support the Bush Bash!',exact:true})).toBeVisible();
 await host.getByRole('button',{name:'Open donation in larger viewer'}).click();
 await host.getByRole('button',{name:'Support the Bush Bash!',exact:true}).click();
 await expect(host.getByRole('link',{name:'Open in wallet'})).toHaveAttribute('href','lightning:support@example.com');
 await host.keyboard.press('Escape');
 const configured=(await api(host,'room')).data.room;
 expect(configured.support_label).toBe('Support the Bush Bash!');
 expect((await api(host,'host/settings',{...configured,support_label:'<b>Support & help</b>',paused:!!configured.paused})).status).toBe(200);
 await host.reload();await host.getByRole('button',{name:'Fit all',exact:true}).click();
 await expect(host.locator('[data-donation="reveal"]')).toHaveText('<b>Support & help</b>');
 await expect(host.locator('[data-donation="reveal"] b')).toHaveCount(0);
 expect((await api(host,'host/settings',{...configured,support_label:'',paused:!!configured.paused})).status).toBe(200);
 checks.push({customLabelSettingsSaveReload:true,customLabelExpanded:true,labelEscaping:true,blankLabelDefault:true});
 // Defensive escaping even for a malformed legacy stored address (API rejects this value).
 app.db.run('UPDATE room SET lightning=? WHERE id=1',[`x\"><img src=x onerror="window.donationInjected=true">@example.com`]);await host.reload();await host.getByRole('button',{name:'Fit all',exact:true}).click();await host.getByRole('button',{name:'Support this workshop',exact:true}).click();await expect(host.locator('.donation-address')).toHaveText(`x\"><img src=x onerror="window.donationInjected=true">@example.com`);await expect(host.locator('.donation-content img:not(.donation-qr)')).toHaveCount(0);await expect(host.locator('.donation-qr')).toHaveCount(1);expect(await host.evaluate(()=>(window as any).donationInjected)).toBeUndefined();checks.push({legacyAddressEscaping:true});
 await Bun.write(out+'/results.json',JSON.stringify({proof:'Real isolated API + Chrome, synthetic test identities; no wallet opened or payments sent',checks},null,2));console.log(JSON.stringify({out,checks}));
}catch(error){for(const c of browser.contexts())for(const p of c.pages()){await p.screenshot({path:out+'/failure.png',fullPage:true});await Bun.write(out+'/failure.txt',await p.locator('body').innerText());}throw error;}finally{await browser.close();server.stop(true);app.db.close();}
