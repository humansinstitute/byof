import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {createFreedomServer} from '../src/server.ts';
import type {Config} from '../src/config.ts';

const dataDir=mkdtempSync('/tmp/freedom-chat-paste-'),ownerKey=generateSecretKey(),owner=getPublicKey(ownerKey),key=generateSecretKey(),administrator=getPublicKey(key);
const config:Config={dataDir,hostPubkey:administrator,origin:null,version:'chat-paste-acceptance'},runtime=createFreedomServer(config,0),{app,server}=runtime;
config.origin=`http://127.0.0.1:${server.port}`;
const browser=await chromium.launch({executablePath:process.env.FREEDOM_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),uploads=new Map<string,any>(),submissions:any[]=[];
  await page.route('**/api/v1/projects/**/attachments**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(request.method()==='POST'){
      const body=JSON.parse(request.postData()||'{}'),failed=body.filename==='fail.png',objectId=crypto.randomUUID();uploads.set(body.attachmentId,{...body,failed,objectId});
      return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({attachment_id:body.attachmentId,status:'uploading'})});
    }
    const id=url.pathname.split('/').at(-1)!,upload=uploads.get(id);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(upload.failed?{attachment_id:id,status:'error',error:'Tower rejected this fixture'}:{attachment_id:id,kind:'image',filename:upload.filename,content_type:upload.contentType,size_bytes:upload.sizeBytes,storage_object_id:upload.objectId,status:'ready',error:null})});
  });
  await page.route(/\/api\/v1\/(?:host\/)?projects\/[^/]+\/requests$/,async route=>{if(route.request().method()!=='POST')return route.continue();submissions.push({path:new URL(route.request().url()).pathname,...JSON.parse(route.request().postData()||'{}')});return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({generationAvailable:false,request:{status:'unavailable'}})});});
  await page.exposeFunction('fixtureSign',(event:any)=>finalizeEvent(event,key));await page.addInitScript(()=>{(window as any).nostr={signEvent:(event:any)=>(window as any).fixtureSign(event)}});
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Napplet owner','extension','admitted',20,1]);app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[administrator,'Canvas administrator','extension','admitted',20,2]);const project=app.workshop.create(app.auth.member(owner),'spinner').project;
  const token=crypto.randomUUID(),hash=createHash('sha256').update(token).digest('hex');app.db.run('INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)',[hash,administrator,'csrf',Math.floor(Date.now()/1000)+3600,'extension']);
  await page.context().addCookies([{name:'lf_session',value:token,url:config.origin,httpOnly:true,sameSite:'Strict'}]);await page.goto(`${config.origin}/?workshop=${app.workshop.id}&project=${project.id}`);
  await page.getByRole('tab',{name:'Chat',exact:true}).click();
  const prompt=page.getByLabel('Your next question or change');await expect(page.getByLabel('Reason for acting on this project')).toHaveCount(0);await expect(page.getByRole('button',{name:'Send host follow-up'})).toHaveCount(0);
  await prompt.fill('draft survives tabs');await page.getByRole('tab',{name:'Preview',exact:true}).click();await page.getByRole('tab',{name:'Chat',exact:true}).click();await expect(prompt).toHaveValue('draft survives tabs');
  await prompt.fill('before AFTER');await prompt.evaluate((node:any)=>node.setSelectionRange(7,7));
  const ordinaryNotCancelled=await prompt.evaluate((node:any)=>{const data=new DataTransfer();data.setData('text/plain','ordinary');return node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});expect(ordinaryNotCancelled).toBe(true);
  await prompt.evaluate((node:any)=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(300001).fill(1)],'one.png',{type:'image/png'}));data.items.add(new File([new Uint8Array([3,4,5])],'two.jpg',{type:'image/jpeg'}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await expect(prompt).toHaveValue(/^before !\[one\.png\]\(storage:\/\/[a-f0-9-]+\)\n!\[two\.jpg\]\(storage:\/\/[a-f0-9-]+\)AFTER$/);
  await prompt.evaluate((node:any)=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([9])],'fail.png',{type:'image/png'}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await expect(page.locator('#chat-upload-status')).toContainText('Tower rejected this fixture');await expect(page.getByRole('button',{name:'Save request'})).toBeDisabled();
  await page.locator('[data-chat-upload-remove]').click();await expect(page.getByRole('button',{name:'Save request'})).toBeEnabled();
  await page.getByRole('button',{name:'Save request'}).click();expect(submissions).toHaveLength(1);expect(submissions[0].path).toContain('/api/v1/host/projects/');expect(submissions[0]).not.toHaveProperty('operatorReason');expect(submissions[0].attachments).toHaveLength(2);expect(submissions[0].prompt.match(/storage:\/\//g)).toHaveLength(2);expect([...uploads.values()].find(upload=>upload.filename==='one.png')?.sizeBytes).toBe(300001);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  console.log(JSON.stringify({checks:['administrator sees the ordinary composer with no reason field or host ceremony','administrator draft survives tab changes','ordinary text paste not intercepted','300 KB PNG and second image preserve surrounding text','failure blocks send and can be removed','administrator submission carries two storage links and attachment records','mobile width has no overflow'],storage:'Tower endpoints simulated; backend prepare/upload/readback/poll path is covered by the focused integration regression'}));
}finally{await browser.close();runtime.stop();rmSync(dataDir,{recursive:true,force:true});key.fill(0);ownerKey.fill(0);}
