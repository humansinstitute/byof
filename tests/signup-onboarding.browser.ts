// Real Chromium + isolated application coverage for first-run Nostr signup.
import {chromium,expect,type BrowserContext,type Page} from '@playwright/test';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';

const dataDir=mkdtempSync('/tmp/freedom-signup-browser-');
const app=application({dataDir,hostPubkey:null,origin:null,version:'signup-browser'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const evidence='tmp/docs/handoffs/signup-onboarding';mkdirSync(evidence,{recursive:true});
const checks:any[]=[];

async function openSignup(context:BrowserContext){
 const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(server.url.href);await page.getByRole('button',{name:'Create a New Profile',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Create a Nostr profile',exact:true})).toBeVisible();
 return {page,errors};
}
async function expectSignupLayout(page:Page,width:number){
 const primary=page.getByRole('button',{name:'Generate local key and continue',exact:true}),fallback=page.locator('.signup-fallback');
 await expect(page.getByRole('heading',{name:'Generate a throwaway key',exact:true})).toBeVisible();
 await expect(page.getByText(/save it only in this browser session/)).toBeVisible();
 await expect(page.getByText('Local and not recoverable.',{exact:false})).toBeVisible();
 expect(await primary.evaluate(element=>element.classList.contains('primary'))).toBe(true);
 expect(await page.evaluate(()=>{const a=document.querySelector('[data-a="temporary"]'),b=document.querySelector('.signup-fallback');return !!a&&!!b&&!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING);})).toBe(true);
 expect((await primary.boundingBox())!.y).toBeLessThan((await fallback.boundingBox())!.y);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 checks.push({width,localThrowawayPrimary:true,responsive:true});
}

try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:844},hasTouch:width===390,isMobile:width===390}),{page,errors}=await openSignup(context);
  await expectSignupLayout(page,width);await page.getByLabel('Display name',{exact:true}).fill('Local throwaway user');
  const warning=page.getByText('Local and not recoverable.',{exact:false}),temporary=page.getByRole('button',{name:'Generate local key and continue',exact:true});
  await expect(warning).toBeVisible();await expect(temporary).toBeVisible();
  expect((await warning.boundingBox())!.y).toBeLessThan((await temporary.boundingBox())!.y);
  expect(await temporary.evaluate(element=>element.classList.contains('primary'))).toBe(true);
  await page.screenshot({path:`${evidence}/${width}-signup.png`,fullPage:true});
  await temporary.click();await expect(page.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
  expect((await page.evaluate(async()=>await(await fetch('/api/v1/me')).json())).member.identity_type).toBe('temporary');
  await page.reload();await expect(page.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
  expect(errors).toEqual([]);checks.push({width,throwawayWarningBeforeUse:true,temporarySessionRestore:true});await context.close();
 }

 const signerSecret=generateSecretKey(),signatures:any[]=[],externalContext=await browser.newContext({viewport:{width:1440,height:900}});
 const external=await externalContext.newPage(),errors:string[]=[];external.on('pageerror',error=>errors.push(error.message));
 await external.exposeFunction('testSign',(event:any)=>{const signed=finalizeEvent(event,signerSecret);signatures.push(signed);return signed;});
 await external.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).testSign(event)};});
 await external.goto(server.url.href);await external.getByRole('button',{name:'Create a New Profile',exact:true}).click();await external.getByLabel('Display name',{exact:true}).fill('External signer user');
 await external.getByText('Use a browser extension signer instead',{exact:true}).click();
 await external.getByRole('button',{name:'Continue with browser signer',exact:true}).click();await expect(external.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
 let member=(await external.evaluate(async()=>await(await fetch('/api/v1/me')).json())).member;expect(member.identity_type).toBe('extension');expect(member.pubkey).toBe(getPublicKey(signerSecret));expect(signatures).toHaveLength(1);
 const externalSecretHex=Buffer.from(signerSecret).toString('hex');
 const delivery=await external.evaluate(()=>({body:document.body.innerText,local:Object.values(localStorage),session:Object.values(sessionStorage)}));
 expect(JSON.stringify(delivery)).not.toContain(externalSecretHex);expect(JSON.stringify(delivery)).not.toContain('nsec1');
 await external.reload();await expect(external.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
 await external.getByRole('button',{name:'Open identity menu'}).click();await external.getByRole('button',{name:'My Profile',exact:true}).click();await external.getByRole('button',{name:'Sign out',exact:true}).click();
 await expect(external.getByRole('heading',{name:'Join the BYOF Canvas.',exact:true})).toBeVisible();await external.getByRole('button',{name:'Log in with browser extension',exact:true}).click();await expect(external.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
 member=(await external.evaluate(async()=>await(await fetch('/api/v1/me')).json())).member;expect(member.pubkey).toBe(getPublicKey(signerSecret));expect(signatures).toHaveLength(2);expect(errors).toEqual([]);
 checks.push({externalSignedChallenge:true,externalSecretAbsentFromApp:true,sessionRestore:true,signOutAndExistingLogin:true});
 await Bun.write(`${evidence}/results.json`,JSON.stringify({isolatedRealApplication:true,checks},null,2));
 signerSecret.fill(0);await externalContext.close();console.log(JSON.stringify({isolatedRealApplication:true,checks,evidence}));
}finally{for(const context of browser.contexts())await context.close();await browser.close();server.stop(true);app.db.close();rmSync(dataDir,{recursive:true,force:true});}
