/** Local browser acceptance against the production receiver and WebSocket server.
 * Synthetic signed activity/final callbacks exercise UI delivery; no live/native claim. */
import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {createFreedomServer} from '../src/server.ts';
import {bindRun} from '../src/delivery-store.ts';
import {bindActivityAuthority} from '../src/activity-store.ts';
import type {Config,FollowupConfig} from '../src/config.ts';
const evidence='tmp/docs/handoffs/chat-browser';mkdirSync(evidence,{recursive:true});
const dataDir=mkdtempSync(evidence+'/fixture-'),key=generateSecretKey(),owner=getPublicKey(key),signer=generateSecretKey();
const config:Config={dataDir,hostPubkey:owner,origin:null,version:'chat-local-acceptance',callbackSignerPubkey:getPublicKey(signer)};
const runtime=createFreedomServer(config,0),{app,server}=runtime;config.origin=`http://127.0.0.1:${server.port}`;
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const errors:string[]=[],checks:string[]=[];
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function callback(path:string,value:any,activity=false){const body=JSON.stringify(value),url=config.origin+path,tags=[['u',url],['method','POST'],['payload',hash(body)],['run',value.runId]];tags.push(activity?['event',value.eventId]:['delivery',value.deliveryId]);if(!activity)tags.push(['attempt','1']);const e=finalizeEvent({kind:27235,content:'',created_at:Math.floor(Date.now()/1000),tags},signer);const response=await fetch(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(e)).toString('base64'),'x-wingman-run-id':value.runId,[activity?'x-wingman-event-id':'x-wingman-delivery-id']:activity?value.eventId:value.deliveryId},body});if(!response.ok)throw Error(await response.text());}
try{
 const page=await browser.newPage({viewport:{width:1300,height:900}});page.on('pageerror',e=>errors.push(e.message));
 let requestPosts=0;page.on('request',r=>{if(r.method()==='POST'&&/\/projects\/[^/]+\/requests(?:\?|$)/.test(r.url()))requestPosts++;});
 await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,key));await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)}});
 app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Chat acceptance','extension','admitted',20,1]);
 const project=app.workshop.create(app.auth.member(owner),'game').project;
 const token=crypto.randomUUID();app.db.run('INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)',[hash(token),owner,'csrf',Math.floor(Date.now()/1000)+3600,'extension']);
 await page.context().addCookies([{name:'lf_session',value:token,url:config.origin,httpOnly:true,sameSite:'Strict'}]);
 await page.goto(config.origin+'/?workshop='+app.workshop.id+'&project='+project.id);
 await expect(page.getByRole('heading',{name:'Talk with Agent 21',exact:true})).toBeVisible();
 await page.getByLabel('Your next question or change').fill('Please explain the project.');await page.getByRole('button',{name:'Save request',exact:true}).click();const request:any=app.db.query('SELECT * FROM requests').get();
 // This test never dispatches native work. Install a trusted synthetic acceptance
 // after the already-saved browser request, then drive the real signed endpoints.
 config.followup={projectId:project.id,ownerPubkey:owner,conversationKey:project.conversation_id,definitionId:'fixture',origin:'https://autopilot.example',activityWebhookUrl:config.origin+'/api/v1/pipeline/activity'} as FollowupConfig;
 bindRun(app.db,request.id,'run');app.db.run("UPDATE requests SET status='building',error=NULL WHERE id=?",[request.id]);
 bindActivityAuthority(app.db,request.id,'run',{requestId:request.id,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:request.id,activityGeneration:'0'},config.followup);
 const projectUrl=config.origin+'/?workshop='+app.workshop.id+'&project='+project.id;await page.goto(projectUrl);
 const send=page.getByRole('button',{name:'Send',exact:true});await expect(send).toBeDisabled();
 await page.getByLabel('Your next question or change').fill('Draft for the next turn');
 async function progress(sequence:number,type:string,content:string){await callback('/api/v1/pipeline/activity',{version:1,eventId:hash('event-'+sequence),sequence,runId:'run',stepId:'step',sessionId:'session',turnId:'receipt',correlation:{requestId:request.id,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:request.id,generation:'0'},timestamp:'2026-10-14T00:00:00.000Z',type,content},true);}
 await progress(1,'commentary','First public update');await expect(page.locator('.activity').filter({hasText:'First public update'})).toBeVisible();
 await progress(2,'tools','Using tools');await progress(3,'tools','Using tools');await expect(page.locator('.activity.tools')).toHaveCount(1);
 await progress(4,'commentary','Second public update');await progress(5,'tools','Using tools');await expect(page.locator('.activity.tools')).toHaveCount(2);await expect(page.getByLabel('Your next question or change')).toHaveValue('Draft for the next turn');
 await progress(6,'completed','Completed');await expect(page.getByText('Agent turn finished; checking the final result.',{exact:true})).toBeVisible();await expect(send).toBeDisabled();
 await page.screenshot({path:evidence+'/progress.png',fullPage:true});
 // Reload and reconnect both restore durable progress without any POST replay.
 await page.reload();await expect(page.locator('.activity').filter({hasText:'Second public update'})).toBeVisible();await expect(page.locator('.activity.tools')).toHaveCount(2);await expect(send).toBeDisabled();
 const before=requestPosts;await page.context().setOffline(true);await page.waitForTimeout(800);await page.context().setOffline(false);await page.waitForTimeout(1800);expect(requestPosts).toBe(before);
 const response='Detailed answer\n'+('Useful complete answer. '.repeat(2000))+'\nEND OF FULL ANSWER';
 await callback('/api/v1/pipeline/callback',{runId:'run',deliveryId:'delivery',status:'ok',terminal:true,error:null,result:{action:'answer_completed',requestId:request.id,projectId:project.id,banRequired:false,response,nativeReceipt:{requestId:request.id,projectId:project.id,invocationRunId:'run',invocationStepId:'step',stepId:'step',runId:'run',receiptId:'receipt',sessionId:'session',executionId:'execution',nativeSessionId:'native',sequence:1,conversationKey:project.conversation_id}}});
 await expect(send).toBeEnabled();expect(await page.locator('[data-request]').textContent()).toContain(response);await expect(page.getByLabel('Your next question or change')).toHaveValue('Draft for the next turn');expect(requestPosts).toBe(before);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/complete-mobile.png',fullPage:false});
 checks.push('Public commentary and one indicator per consecutive tools group','Terminal hint leaves Send disabled until authoritative final','Full 46000+ character answer, preserved unsent draft, mobile render','Reload/offline reconnect without build resubmission');expect(errors).toEqual([]);
 await Bun.write(evidence+'/evidence.json',JSON.stringify({mode:'local production server with synthetic signed callbacks; no live/native execution claim',checks,errors,requestPosts,answerLength:response.length},null,2));console.log(JSON.stringify({checks,errors,evidence}));
}finally{await browser.close();runtime.stop();rmSync(dataDir,{recursive:true,force:true});}
