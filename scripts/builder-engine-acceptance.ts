import {chromium,expect} from '@playwright/test';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {application} from '../src/application.ts';
/** Disposable real-app fixture; no managed runtime/provider is contacted. */
const dir=mkdtempSync('/tmp/builder-settings-browser-'),key=generateSecretKey(),app=application({dataDir:dir,hostPubkey:getPublicKey(key),origin:null,version:'builder-settings-fixture'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>app.handle(request)}),origin=server.url.origin,browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const challenge=await (await fetch(origin+'/api/v1/challenge',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).json();
 const response=await fetch(origin+'/api/v1/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension',name:'Fixture administrator'})});expect(response.ok).toBe(true);const account=await response.json();
 const cookie=response.headers.get('set-cookie')!.split(';')[0]!,split=cookie.indexOf('=');await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
 const open=async()=>{await page.goto(origin);await page.getByRole('button',{name:'Open identity menu'}).click();await page.getByRole('button',{name:'Site Admin',exact:true}).click();await expect(page.getByRole('heading',{name:'Builder engine',exact:true})).toBeVisible()};
 await open();await expect(page.getByLabel('Agent used for new Napplet messages')).toHaveValue('codex');
 await page.getByLabel('Agent used for new Napplet messages').selectOption('goose');await page.getByRole('button',{name:'Save builder engine',exact:true}).click();await expect(page.getByText('Builder engine saved for new messages',{exact:true})).toBeVisible();
 await expect(page.locator('#builder-engine-form')).toContainText('awaits compatible managed pipeline');
 await open();await expect(page.getByLabel('Agent used for new Napplet messages')).toHaveValue('goose');
 const saved=await (await context.request.get(origin+'/api/v1/site/builder-engine')).json();
 const raced=await context.request.post(origin+'/api/v1/site/builder-engine',{headers:{origin,'x-csrf-token':account.csrf},data:{agent:'codex',expectedRevision:saved.builderEngine.revision}});expect(raced.ok()).toBe(true);
 await page.getByLabel('Agent used for new Napplet messages').selectOption('claude');await page.getByRole('button',{name:'Save builder engine',exact:true}).click();await expect(page.getByText('Builder engine changed; reload before saving',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Reload saved settings',exact:true}).click();await expect(page.getByLabel('Agent used for new Napplet messages')).toHaveValue('codex');
 await page.getByLabel('Agent used for new Napplet messages').selectOption('claude');await page.getByRole('button',{name:'Save builder engine',exact:true}).click();await expect(page.getByText('Builder engine saved for new messages',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(page.getByLabel('Agent used for new Napplet messages')).toHaveValue('claude');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const evidence='tmp/docs/handoffs/builder-settings-browser';mkdirSync(evidence,{recursive:true});await page.screenshot({path:evidence+'/mobile.png',fullPage:true});expect(errors).toEqual([]);
 console.log(JSON.stringify({passed:true,mode:'Disposable real application/browser; no live managed engine execution',checks:['all choices visible','save Goose','persist across page reload','concurrent revision conflict','reload saved selection','save Claude','mobile fit','no browser errors']}));
}finally{await browser.close();server.stop(true);app.db.close();rmSync(dir,{recursive:true,force:true})}
