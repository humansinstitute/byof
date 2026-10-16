import {chromium,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {application} from '../src/application.ts';
import {bindActivityAuthority} from '../src/activity-store.ts';
import {bindRun} from '../src/delivery-store.ts';
import {perthEventTime} from '../public/activity-time.js';
import type {OperatorBuildConfig} from '../src/config.ts';

const evidence='tmp/docs/handoffs/activity-timestamps-browser';
mkdirSync(evidence,{recursive:true});
const dataDir=mkdtempSync(evidence+'/fixture-'),signer=generateSecretKey(),ownerKey=generateSecretKey();
const config:any={dataDir,hostPubkey:getPublicKey(ownerKey),origin:null,version:'activity-timestamps-acceptance',callbackSignerPubkey:getPublicKey(signer)};
const app=application(config);
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:app.handle});
config.origin=server.url.origin;
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

try{
 const page=await browser.newPage(),errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,ownerKey));
 await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)};});
 await page.goto(server.url.href);await page.getByRole('button',{name:'Create a New Profile'}).click();
 await page.getByLabel('Display name').fill('Timestamp fixture host');await page.getByRole('button',{name:'Create profile with browser extension'}).click();
 await expect(page.getByRole('heading',{name:'Canvases',exact:true})).toBeVisible();
 const member=app.auth.member(getPublicKey(ownerKey)),project:any=app.workshop.create(member,'game').project,requestId=crypto.randomUUID(),runId='timestamp-run';
 await page.goto(new URL(`/?workshop=${app.workshop.id}&project=${project.id}`,server.url).toString());await expect(page.getByRole('heading',{name:'Talk with Agent 21'})).toBeVisible();
 app.workshop.request(member,project.id,{requestId,prompt:'Show durable activity timestamps',expectedRevisionId:project.current_revision},true);
 bindRun(app.db,requestId,runId);app.db.run("UPDATE requests SET status='building' WHERE id=?",[requestId]);
 const activityUrl=new URL('/api/v1/pipeline/activity',server.url).toString();
 bindActivityAuthority(app.db,requestId,runId,{requestId,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:requestId,activityGeneration:'0'},{definitionId:'fixture',activityWebhookUrl:activityUrl} as OperatorBuildConfig);
 await page.reload();await expect(page.getByRole('heading',{name:'Talk with Agent 21'})).toBeVisible();
 const base=new Date(),turnId='timestamp-turn',correlation={requestId,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:requestId,generation:'0'};
 const event=(sequence:number,type:'commentary'|'tools',timestamp:string,content=type==='tools'?'Using tools':'Inspecting the saved request')=>({version:1,eventId:hash(`${sequence}:${type}:${timestamp}`),sequence,runId,stepId:'timestamp-step',sessionId:'timestamp-session',turnId,correlation,timestamp,type,content});
 async function post(body:any){const raw=JSON.stringify(body),auth=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',activityUrl],['method','POST'],['payload',hash(raw)],['event',body.eventId],['run',runId]]},signer);const response=await fetch(activityUrl,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(auth)).toString('base64'),'x-wingman-run-id':runId,'x-wingman-event-id':body.eventId},body:raw});expect(response.status).toBe(200);return response.json();}
 const commentary=event(1,'commentary',new Date(base.getTime()-12*60_000).toISOString());await post(commentary);
 await expect(page.locator('.message.activity').filter({hasText:'Inspecting the saved request'}).locator('time')).toContainText(/^Received .+ AWST$/);
 const newestTool=event(3,'tools',new Date(base.getTime()-2*60_000).toISOString()),olderTool=event(2,'tools',new Date(base.getTime()-7*60_000).toISOString());
 await post(newestTool);const expectedTool=perthEventTime(newestTool.timestamp,'Last tool',base)!.text;
 await expect(page.locator('.message.tools time')).toHaveText(expectedTool);await post(olderTool);await expect(page.locator('.message.tools time')).toHaveText(expectedTool);
 expect((await post(newestTool)).handling).toBe('duplicate');await page.reload();await expect(page.locator('.message.tools time')).toHaveText(expectedTool);
 const prior=new Date(base.getTime()-36*60*60_000),historical=event(4,'commentary',prior.toISOString(),'Crossed the Perth date boundary'),raw=JSON.stringify(historical),auth=finalizeEvent({kind:27235,created_at:Math.floor(prior.getTime()/1000),content:'',tags:[['u',activityUrl],['method','POST'],['payload',hash(raw)],['event',historical.eventId],['run',runId]]},signer);
 const {verifyActivity}=await import('../src/pipeline/activity-receiver.ts'),{storeActivity}=await import('../src/activity-store.ts');storeActivity(app.db,verifyActivity({body:raw,authorization:'Nostr '+Buffer.from(JSON.stringify(auth)).toString('base64'),publicUrl:activityUrl,signerPubkey:getPublicKey(signer),eventHeader:historical.eventId,runHeader:runId}),Math.floor(prior.getTime()/1000));
 await page.reload();await expect(page.locator('.message.activity').filter({hasText:'Crossed the Perth date boundary'}).locator('time')).toHaveText(perthEventTime(prior.toISOString(),'Received',base)!.text);
 expect(await page.locator('.conversation-pane').getAttribute('aria-busy')).toBeNull();
 for(const width of [1440,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${evidence}/${width}.png`,fullPage:true});}
 expect(errors).toEqual([]);
 console.log(JSON.stringify({fixture:true,checks:['live received time','actual tool-event time','late older replay stays monotonic','duplicate delivery','reload replay','Perth date disclosure','desktop','mobile','accessible time labels','no browser errors'],expectedTool}));
}finally{await browser.close();server.stop(true);app.db.close();rmSync(dataDir,{recursive:true,force:true});ownerKey.fill(0);signer.fill(0);}
