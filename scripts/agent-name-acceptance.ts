import { chromium, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { application } from '../src/application.ts';
import { requestBuilderPrompt } from '../src/builder-prompt.ts';

const evidence='tmp/docs/handoffs/agent-name-browser';
mkdirSync(evidence,{recursive:true});
const dataDir=mkdtempSync(evidence+'/fixture-'), secret=generateSecretKey();
const app=application({dataDir,hostPubkey:getPublicKey(secret),origin:null,version:'agent-name-acceptance'});
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage(), errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,secret));
 await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)}});
 await page.goto(server.url.href);
 await page.getByRole('button',{name:'Log in as admin'}).click();
 await page.getByLabel('Display name').fill('Naming fixture host');
 await page.getByRole('button',{name:'Log in with browser extension'}).click();
 await page.getByRole('button',{name:'Make your mark'}).first().click();
 await page.getByRole('button',{name:'Use this starter'}).first().click();
 await expect(page.getByRole('heading',{name:'Talk with Agent 21',exact:true})).toBeVisible();
 const project:any=app.db.query('SELECT * FROM projects').get();
 await page.getByLabel('Your next question or change').fill('Question before rename');
 await page.getByRole('button',{name:'Save request',exact:true}).click();
 const original:any=app.db.query('SELECT * FROM requests').get();
 expect(requestBuilderPrompt(app.db,original.id)?.agentName).toBe('Agent 21');
 // Include both historical prompt snapshots and records predating snapshots.
 app.db.run("UPDATE requests SET status='succeeded',response='Helpful answer' WHERE id=?",[original.id]);
 app.db.run('INSERT INTO requests(id,project_id,prompt,expected_revision,status,created_at,mode) VALUES(?,?,?,?,?,?,?)',['legacy',project.id,'Old question',project.current_revision,'succeeded',1,'answer']);
 await page.getByRole('button',{name:'Open identity menu'}).click();
 await page.getByRole('button',{name:'Manage room',exact:true}).click();
 const guidance=await page.getByLabel('Napplet builder guidance').inputValue();
 await page.getByLabel('Agent name',{exact:true}).fill('Ada Lovelace');
 await page.getByRole('button',{name:'Save builder prompt',exact:true}).click();
 await expect(page.getByLabel('Agent name',{exact:true})).toHaveValue('Ada Lovelace');
 await expect(page.getByLabel('Napplet builder guidance')).toHaveValue(guidance);
 await page.reload();
 await page.getByRole('button',{name:'Small game',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Talk with Ada Lovelace',exact:true})).toBeVisible();
 await expect(page.locator('.message b').filter({hasText:'Ada Lovelace'}).first()).toBeVisible();
 expect(await page.locator('.conversation-pane').innerText()).not.toMatch(/prompt v\d|legacy guidance|saved Builder prompt/i);
 await page.getByLabel('Your next question or change').fill('Question after rename');
 await page.getByRole('button',{name:'Save request',exact:true}).click();
 const latest:any=app.db.query('SELECT * FROM requests ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
 expect(requestBuilderPrompt(app.db,latest.id)?.agentName).toBe('Ada Lovelace');
 expect(requestBuilderPrompt(app.db,original.id)?.agentName).toBe('Agent 21');
 app.db.run("UPDATE requests SET status='building' WHERE id=?",[latest.id]);
 await page.reload();await page.getByRole('button',{name:'Small game',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Ada Lovelace is working'})).toBeVisible();
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});
  await page.screenshot({path:evidence+'/'+width+'.png',fullPage:true});
 }
 expect(errors).toEqual([]);
 console.log('PASS: default/custom name, real host save, reload persistence, preserved guidance, old/new identity snapshots, historical/legacy labels hidden, working status, desktop/mobile, no browser errors');
} finally {await browser.close();server.stop(true);app.db.close();rmSync(dataDir,{recursive:true,force:true});}
