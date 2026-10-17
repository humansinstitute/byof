import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {application} from '../src/application.ts';
import {dispatchFollowup} from '../src/pipeline/followup-dispatch.ts';
import {prepareTrustedFollowup,followupCandidate} from '../src/pipeline/followup.ts';
import {beginAgentPublication,beginRemoteAgentPublication,registerAgentPublication} from '../src/agent-publication.ts';
import {candidateStorageJob,updateStorageJob,storeStorageDelivery} from '../src/storage.ts';
import {storeDelivery} from '../src/delivery-store.ts';
import {sha256} from '../src/assets.ts';
import {nip19,generateSecretKey,finalizeEvent,getPublicKey} from 'nostr-tools';
import {validateGeneratedHtml} from '../src/pipeline/artifact.ts';
import {publishNativeNapplet} from '../src/pipeline/agent-publication.ts';

function fixture(){
 const root=mkdtempSync('/private/tmp/napplet-tool-'),owner='a'.repeat(64),runtimeConfig:any={dataDir:root,origin:'https://app.test',hostPubkey:null,version:'test'},app=application(runtimeConfig);
 app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
 const member=app.auth.member(owner),project=app.workshop.create(member,'blank').project;
 const cfg:any={ownerPubkey:owner,projectId:project.id,conversationKey:project.conversation_id,builderRoot:root+'/napplets',workshopId:project.workshop_id,fileVersions:true,replacementEnabled:true,agentPublication:true};
 const target={towerUrl:'https://tower.test',workspaceId:crypto.randomUUID(),workspaceOwnerNpub:nip19.npubEncode('b'.repeat(64)),appNpub:nip19.npubEncode(owner)};
 const storage:any={installationId:crypto.randomUUID(),appPubkey:owner,appNpub:target.appNpub,towerOrigin:target.towerUrl,workshopId:project.workshop_id,localRoot:cfg.builderRoot,pipeline:{}};
 app.db.run('INSERT INTO storage_binding(id,installation_id,workshop_id,target_json,local_root,status,connected_actor) VALUES(1,?,?,?,?,?,?)',[storage.installationId,project.workshop_id,JSON.stringify(target),cfg.builderRoot,'ready',owner]);app.workshop.storageRequired=true;
 let sequence=0;
 async function prepare(mode='build'){
  const id=crypto.randomUUID(),p=app.workshop.project(member,project.id);
  app.workshop.request(member,p.id,{requestId:id,prompt:'Latest instruction',expectedRevisionId:p.current_revision,mode},true);
  let input:any;await dispatchFollowup(app.workshop,member,p.id,id,cfg,async v=>{input=v;return {runId:id,receipt:{}};});
  const prepared=prepareTrustedFollowup(input,{ownerPubkey:owner,builderRoot:cfg.builderRoot,workshopId:p.workshop_id,fileVersions:true,legacy:{ownerPubkey:owner,projectId:p.id,conversationKey:p.conversation_id,directory:'/old'}});
  const build=input.replacementContext.fileBuild;
  const n={requestId:id,projectId:p.id,nativeRequestId:input.nativeRequestId,conversationKey:input.conversationKey,generation:input.generation,contextHash:input.contextHash,receiptId:'turn-'+id,sessionId:'session',nativeSessionId:'native',sequence:++sequence,runId:id,stepId:'step-'+id,invocationRunId:id};
  const candidate={action:'build_completed',banRequired:false,requestId:id,projectId:p.id,artifactPath:build.artifactPath,version:build.version,validation:['Exercised counter; increment passed'],response:'App published through the native publication tool.',nativeReceipt:n};
  const source='<html><body><button onclick="this.textContent=Number(this.textContent)+1">0</button><a href="https://example.org/source">Source</a></body></html>';
  writeFileSync(prepared.directory+'/'+build.artifactPath,source);
  const body={requestId:id,projectId:p.id,candidate};
  const final=(reply:string)=>{
   const turn={...n,status:'completed',requestId:input.nativeRequestId,reply};
   const result=followupCandidate({...input,fileBuild:build,turn});
   const d={eventId:crypto.randomUUID(),attempt:1,bodyHash:sha256(JSON.stringify(result)),envelope:{runId:id,deliveryId:'final-'+id,status:'ok',terminal:true as const,error:null,result}};
   storeDelivery(app.db,d,app.workshop);expect(storeDelivery(app.db,{...d,eventId:crypto.randomUUID()},app.workshop)).toBe('duplicate');return result;
  };
  function verified(){
   const {jobId}=candidateStorageJob(app.workshop,storage,body),objectId=crypto.randomUUID();
   updateStorageJob(app.workshop,storage,jobId,{step:'preparing'});updateStorageJob(app.workshop,storage,jobId,{step:'prepared',objectId});
   const artifact={objectId,workspaceId:target.workspaceId,towerUrl:target.towerUrl,contentUrl:target.towerUrl+'/api/v4/storage/'+objectId+'/content',sha256:sha256(source),sizeBytes:Buffer.byteLength(source),isPublic:false};
   updateStorageJob(app.workshop,storage,jobId,{step:'verified',artifact,base64:Buffer.from(source).toString('base64')});
   return {...body,candidate:{...candidate,jobId,remoteStorage:artifact}};
  }
  return {id,input,body,final,verified,build,prepared,source};
 }
 return {app,member,project,prepare,runtimeConfig,storage,cfg,close(){app.db.close();rmSync(root,{recursive:true,force:true});}};
}

test('tool publishes verified bytes before final; prose and answer-only turns are independent; versions and charges occur once',async()=>{
 const f=fixture();try{
  const t=await f.prepare();expect(beginAgentPublication(f.app.workshop,t.body).status).toBe('pending');
  expect(()=>registerAgentPublication(f.app.workshop,t.body)).toThrow();expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
  const verified=t.verified(),published=registerAgentPublication(f.app.workshop,verified);
  expect(registerAgentPublication(f.app.workshop,verified)).toEqual(published);
  expect(beginAgentPublication(f.app.workshop,t.body).receipt).toEqual(published);
  expect(f.app.workshop.detail(f.member,f.project.id).artifacts[0].url).toContain(published.revisionId);
  expect((f.app.db.query('SELECT status,response FROM requests WHERE id=?').get(t.id) as any)).toEqual({status:'building',response:null});
  expect(f.app.auth.member(f.member.pubkey).allowance).toBe(19);
  const prose='Your counter is ready. I tested Add one and it increments correctly. {This is ordinary prose, not a receipt.}';
  expect(t.final(prose).response).toBe(prose);
  expect((f.app.db.query('SELECT response FROM final_message_receipts WHERE request_id=?').get(t.id) as any).response).toBe(prose);
  const answer=await f.prepare('answer');answer.final('You could add a reset button. Shall we discuss the design?');
  expect(()=>beginAgentPublication(f.app.workshop,answer.body)).toThrow();
  expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(2);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(19);
  const update=await f.prepare();beginAgentPublication(f.app.workshop,update.body);const next=registerAgentPublication(f.app.workshop,update.verified());update.final('I updated the app and published it.');
  expect(next.version).toBe(2);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(18);
 }finally{f.close();}
});
test('remote publication stages only exact validated bytes into app custody before creating intent',async()=>{
 const f=fixture();try{
  const t=await f.prepare(),path=t.prepared.directory+'/'+t.build.artifactPath;unlinkSync(path);
  const staged={...t.body,sourceBase64:Buffer.from(t.source).toString('base64'),sourceSha256:sha256(t.source)};
  expect(beginRemoteAgentPublication(f.app.workshop,staged).status).toBe('pending');await expect(Bun.file(path).text()).resolves.toBe(t.source);
  const saved=f.app.db.query('SELECT candidate_json FROM agent_publications WHERE request_id=?').get(t.id) as any;
  expect(saved.candidate_json).toBe(JSON.stringify(t.body.candidate));expect(saved.candidate_json).not.toContain('sourceBase64');
  expect(beginRemoteAgentPublication(f.app.workshop,staged).status).toBe('pending');
  const changed='<html><body>Changed</body></html>';
  expect(()=>beginRemoteAgentPublication(f.app.workshop,{...staged,sourceBase64:Buffer.from(changed).toString('base64'),sourceSha256:sha256(changed)})).toThrow('conflict');
 }finally{f.close();}
});
test('remote builders keep their working directory remote while publication bytes stage under app-owned data',async()=>{
 const f=fixture();try{
  f.cfg.remotePreparation=true;f.cfg.localBuilderRoot=f.runtimeConfig.dataDir+'/remote-builds';
  const t=await f.prepare(),row=f.app.db.query('SELECT directory FROM local_builds WHERE request_id=?').get(t.id) as any;
  expect(t.prepared.directory).toBe(f.cfg.builderRoot+'/'+t.input.workshopId+'/'+t.input.projectId);
  expect(row.directory).toBe(f.cfg.localBuilderRoot+'/'+t.input.workshopId+'/'+t.input.projectId);
  expect(existsSync(row.directory+'/'+t.build.artifactPath)).toBe(false);
  const staged={...t.body,sourceBase64:Buffer.from(t.source).toString('base64'),sourceSha256:sha256(t.source)};
  expect(beginRemoteAgentPublication(f.app.workshop,staged).status).toBe('pending');
  await expect(Bun.file(row.directory+'/'+t.build.artifactPath).text()).resolves.toBe(t.source);
 }finally{f.close();}
});
test('activating an ancestor makes the next successful publication branch from its source without renumbering or losing the abandoned branch',async()=>{
 const f=fixture();try{
  const v1=f.app.workshop.project(f.member,f.project.id).current_revision;
  const second=await f.prepare();beginAgentPublication(f.app.workshop,second.body);const v2=registerAgentPublication(f.app.workshop,second.verified()).revisionId;second.final('Saved v2.');
  const third=await f.prepare();beginAgentPublication(f.app.workshop,third.body);const v3=registerAgentPublication(f.app.workshop,third.verified()).revisionId;third.final('Saved v3.');
  f.app.workshop.activate(f.member,f.project.id,{revisionId:v2,expectedRevisionId:v3});
  const fourth=await f.prepare();expect(fourth.input.replacementContext.currentRevision).toBe(v2);expect(fourth.input.replacementContext.currentSource).toContain('<button');
  beginAgentPublication(f.app.workshop,fourth.body);const v4=registerAgentPublication(f.app.workshop,fourth.verified()).revisionId;fourth.final('Saved v4 from v2.');
  let detail=f.app.workshop.detail(f.member,f.project.id),byId=new Map(detail.revisions.map((revision:any)=>[revision.id,revision]));
  expect((byId.get(v4) as any).number).toBe(4);expect((byId.get(v4) as any).parent_id).toBe(v2);expect((byId.get(v3) as any).lineage_status).toBe('abandoned');expect((byId.get(v3) as any).parent_id).toBe(v2);expect((byId.get(v1) as any).lineage_status).toBe('ancestor');
  f.app.workshop.activate(f.member,f.project.id,{revisionId:v3,expectedRevisionId:v4});
  const fifth=await f.prepare();expect(fifth.input.replacementContext.currentRevision).toBe(v3);beginAgentPublication(f.app.workshop,fifth.body);const v5=registerAgentPublication(f.app.workshop,fifth.verified()).revisionId;fifth.final('Saved v5 from v3.');
  detail=f.app.workshop.detail(f.member,f.project.id);byId=new Map(detail.revisions.map((revision:any)=>[revision.id,revision]));expect((byId.get(v5) as any).number).toBe(5);expect((byId.get(v5) as any).parent_id).toBe(v3);expect((byId.get(v4) as any).lineage_status).toBe('abandoned');
 }finally{f.close();}
});
test('stale, foreign, changed and answer-mode tool deliveries cannot publish; failed publication remains distinct from final message',async()=>{
 const f=fixture();try{
  const t=await f.prepare();
  for(const changed of [{...t.body,projectId:crypto.randomUUID()},{...t.body,candidate:{...t.body.candidate,nativeReceipt:{...t.body.candidate.nativeReceipt,generation:999}}},{...t.body,candidate:{...t.body.candidate,nativeReceipt:{...t.body.candidate.nativeReceipt,invocationRunId:'foreign'}}}])expect(()=>beginAgentPublication(f.app.workshop,changed)).toThrow();
  beginAgentPublication(f.app.workshop,t.body);
  expect(()=>beginAgentPublication(f.app.workshop,{...t.body,candidate:{...t.body.candidate,validation:['different']}})).toThrow('changed');
  candidateStorageJob(f.app.workshop,f.storage,t.body);
  t.final('The upload failed. Your saved app is unchanged; retry publication.');
  expect((f.app.db.query('SELECT status FROM requests WHERE id=?').get(t.id) as any).status).toBe('storage_pending');expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
  expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);
  const verified=t.verified(),retryRun=crypto.randomUUID();f.app.db.run('UPDATE storage_jobs SET run_id=? WHERE id=?',[retryRun,verified.candidate.jobId]);
  const delivery={eventId:crypto.randomUUID(),attempt:1,bodyHash:'retry',envelope:{runId:retryRun,deliveryId:crypto.randomUUID(),terminal:true as const,status:'ok',result:verified.candidate,error:null}};
  expect(storeStorageDelivery(f.app.workshop,f.storage,delivery)).toBe('applied');
  expect(storeStorageDelivery(f.app.workshop,f.storage,{...delivery,eventId:crypto.randomUUID()})).toBe('duplicate');
  expect((f.app.db.query('SELECT status,response FROM requests WHERE id=?').get(t.id) as any)).toEqual({status:'succeeded',response:'The upload failed. Your saved app is unchanged; retry publication.'});
  expect(f.app.auth.member(f.member.pubkey).allowance).toBe(19);
  expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(2);
 }finally{f.close();}
});
test('tool callable contract accepts only validation, uses correlated managed upload and independent version webhook',async()=>{
 const f=fixture();try{
  const t=await f.prepare(),calls:string[]=[];
  const call={input:t.input,args:{validation:t.body.candidate.validation},nativeReceipt:{...t.body.candidate.nativeReceipt,requestId:t.input.nativeRequestId,nativeRequestId:undefined,generation:undefined,contextHash:undefined}};
  const transport=async()=>async(url:string,_method:string,body:any)=>{calls.push(url);if(url.endsWith('/intent'))return Response.json(beginAgentPublication(f.app.workshop,body));if(url.endsWith('/version'))return Response.json(registerAgentPublication(f.app.workshop,body));return Response.json({status:'pending'});};
  const store=async(body:any)=>{expect(body.candidate.nativeReceipt.requestId).toBe(t.id);expect(body.candidate.artifactPath).toBe(t.build.artifactPath);return t.verified().candidate;};
  const scope:any={appOrigin:'https://app.test'};
  const receipt=await publishNativeNapplet(call,scope,transport as any,store as any);expect(receipt.status).toBe('published');expect(calls).toEqual(['https://app.test/api/v1/internal/publication/intent','https://app.test/api/v1/publication/version']);
  await expect(publishNativeNapplet({...call,args:{validation:['pass'],artifactPath:'/other'}},scope,transport as any,store as any)).rejects.toThrow('input_denied');
 }finally{f.close();}
});
test('remote tool hands exact builder bytes to the app-authenticated candidate endpoint without exposing them to storage records',async()=>{
 const f=fixture(),remote=mkdtempSync('/private/tmp/napplet-remote-');try{
  const t=await f.prepare(),calls:string[]=[],artifact=remote+'/'+t.input.workshopId+'/'+t.input.projectId+'/'+t.build.artifactPath;
  mkdirSync(dirname(artifact),{recursive:true});writeFileSync(artifact,t.source);
  const call={input:t.input,args:{validation:t.body.candidate.validation},nativeReceipt:{...t.body.candidate.nativeReceipt,requestId:t.input.nativeRequestId,nativeRequestId:undefined,generation:undefined,contextHash:undefined}};
  const transport=async()=>async(url:string,_method:string,body:any)=>{calls.push(url);if(url.endsWith('/candidate'))return Response.json(beginRemoteAgentPublication(f.app.workshop,body));if(url.endsWith('/version'))return Response.json(registerAgentPublication(f.app.workshop,body));throw Error('unexpected route');};
  const store=async()=>t.verified().candidate,scope:any={appOrigin:'https://app.test',remoteBuilderRoot:remote};
  const receipt=await publishNativeNapplet(call,scope,transport as any,store as any);expect(receipt.status).toBe('published');
  expect(calls).toEqual(['https://app.test/api/v1/internal/publication/candidate','https://app.test/api/v1/publication/version']);
  expect((f.app.db.query('SELECT candidate_json FROM agent_publications WHERE request_id=?').get(t.id) as any).candidate_json).not.toContain('sourceBase64');
 }finally{f.close();rmSync(remote,{recursive:true,force:true});}
});
test('citation anchors and direct service code are allowed; external active resources remain rejected',()=>{
 expect(validateGeneratedHtml('<html><body><a href="https://example.org/report">Source</a></body></html>')).toContain('Source');
 expect(validateGeneratedHtml('<html><body><script>fetch("https://api.example/data");new WebSocket("wss://socket.example")</script></body></html>')).toContain('fetch');
 for(const tag of ['<script src="https://evil.test/x.js"></script>','<link rel="stylesheet" href=https://evil.test/x.css>','<img src="https://evil.test/x">','<iframe src="local"></iframe>','<video poster="https://evil.test/x"></video>'])expect(()=>validateGeneratedHtml('<html><body>'+tag+'</body></html>')).toThrow('self-contained');
});

test('signed app-version and independent message URLs reject wrong signer/body/method; duplicates acknowledge one version',async()=>{
 const f=fixture(),appKey=generateSecretKey(),pipelineKey=generateSecretKey();try{
  const pubkey=getPublicKey(appKey);f.storage.appPubkey=pubkey;f.storage.appNpub=nip19.npubEncode(pubkey);
  const target=JSON.parse((f.app.db.query('SELECT target_json FROM storage_binding').get() as any).target_json);target.appNpub=f.storage.appNpub;f.app.db.run('UPDATE storage_binding SET target_json=?',[JSON.stringify(target)]);
  // The target remains an independently verified storage binding; signed webhook
  // authority is the installation signer, not the participant or pipeline signer.
  f.runtimeConfig.storage=f.storage;f.runtimeConfig.followup={agentPublication:true};f.runtimeConfig.callbackSignerPubkey=getPublicKey(pipelineKey);
  const t=await f.prepare();
  async function post(path:string,body:any,key:Uint8Array=appKey,mutate=false){
   const raw=JSON.stringify(body),url='https://app.test'+path;
   const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',sha256(raw)],...(path.endsWith('/message')?[['run',body.runId],['delivery',body.deliveryId],['attempt','1']]:[]),['nonce',crypto.randomUUID()]]},key);
   return f.app.handle(new Request(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),...(body.runId?{'x-wingman-run-id':body.runId,'x-wingman-delivery-id':body.deliveryId}:{})},body:mutate?raw+' ':raw}));
  }
  unlinkSync(t.prepared.directory+'/'+t.build.artifactPath);
  const candidate={...t.body,sourceBase64:Buffer.from(t.source).toString('base64'),sourceSha256:sha256(t.source)};
  expect((await post('/api/v1/internal/publication/candidate',candidate,pipelineKey)).status).toBe(401);
  expect((await post('/api/v1/internal/publication/candidate',candidate,appKey,true)).status).toBe(401);
  expect((await post('/api/v1/internal/publication/candidate',candidate)).status).toBe(200);
  const b=t.verified();const simultaneous=await Promise.all([post('/api/v1/publication/version',b),post('/api/v1/publication/version',b)]);expect(simultaneous.map(r=>r.status)).toEqual([200,200]);expect(await simultaneous[0]!.json()).toEqual(await simultaneous[1]!.json());expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(2);expect((await post('/api/v1/publication/version',b)).status).toBe(200);
  const n=t.body.candidate.nativeReceipt,prose='Published and tested. Here is my ordinary final answer.';
  const result=followupCandidate({...t.input,fileBuild:t.build,turn:{...n,status:'completed',requestId:t.input.nativeRequestId,reply:prose}});
  const envelope={runId:t.id,deliveryId:crypto.randomUUID(),terminal:true,status:'ok',result,error:null};
  expect((await post('/api/v1/pipeline/message',envelope,appKey)).status).toBe(401);
  const completed=await post('/api/v1/pipeline/message',envelope,pipelineKey);expect(completed.status).toBe(200);
  expect((f.app.db.query('SELECT response FROM final_message_receipts WHERE request_id=?').get(t.id) as any).response).toBe(prose);
  expect(f.app.auth.member(f.member.pubkey).allowance).toBe(19);
 }finally{f.close();appKey.fill(0);pipelineKey.fill(0);}
});

test('new admin board inherits verified default storage immediately without changing admission or ACLs',()=>{
 const f=fixture();try{
  f.runtimeConfig.storage=f.storage;f.runtimeConfig.followup={agentPublication:true};
  const created=f.app.site.create({...f.member,admin:true},{title:'New board',introduction:'Ready to build'});
  const selected=f.app.site.storage(created!.id);
  expect(selected?.installationId).toBe(f.storage.installationId);expect(selected?.workshopId).toBe(created!.id);
  expect(f.app.site.storage(created!.id)).toEqual(selected);
  const binding=f.app.db.query('SELECT status,target_json FROM workshop_storage_bindings WHERE workshop_id=?').get(created!.id) as any;
  expect(binding.status).toBe('ready');expect(binding.target_json).toBe((f.app.db.query('SELECT target_json FROM storage_binding').get() as any).target_json);
  expect((f.app.db.query('SELECT tower_id FROM workshops WHERE id=?').get(created!.id) as any).tower_id).toBeNull();
  expect((f.app.db.query('SELECT COUNT(*) n FROM workshop_members WHERE workshop_id=?').get(created!.id) as any).n).toBe(0);
 }finally{f.close();}
});

const chromePath=process.env.FREEDOM_BROWSER||(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':Bun.which('chromium')||Bun.which('google-chrome')||undefined);
test.skipIf(!chromePath)('browser loads the webhook-registered URL and exercises published controls before final completion',async()=>{
 const {chromium}=await import('@playwright/test'),f=fixture();
 const browser=await chromium.launch({executablePath:chromePath,headless:true});
 try{
  const t=await f.prepare();beginAgentPublication(f.app.workshop,t.body);const verified=t.verified(),receipt=registerAgentPublication(f.app.workshop,verified);
  const token=crypto.randomUUID();f.app.db.run('INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)',[sha256(token),f.member.pubkey,'test-csrf',Math.floor(Date.now()/1000)+3600,'temporary']);
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),loaded:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.context().addCookies([{name:'lf_session',value:token,url:'https://app.test',secure:true}]);
  await page.route('**/*',async route=>{
   const req=route.request();if(new URL(req.url()).origin!=='https://app.test'){await route.abort();return;}
   if(req.url()==='https://app.test'+receipt.url){
    // Only Tower transport is simulated. The actual app API, JS, board and
    // published artifact are exercised; bytes come from verified job readback.
    const job=f.app.db.query('SELECT read_base64 FROM storage_jobs WHERE id=?').get(receipt.jobId) as any;
    const bytes=Buffer.from(job.read_base64,'base64');expect(sha256(bytes)).toBe(receipt.sha256);loaded.push(req.url());
    await route.fulfill({contentType:'text/html',body:bytes});return;
   }
   const response=await f.app.handle(new Request(req.url(),{method:req.method(),headers:await req.allHeaders(),...(req.postData()?{body:req.postData()!}:{})}));
   const headers:Record<string,string>={};response.headers.forEach((value,key)=>headers[key]=value);
   await route.fulfill({status:response.status,headers,body:await response.text()});
  });
  await page.goto('https://app.test/?workshop='+f.app.workshop.id);
  const iframe=page.locator(`[data-project-id="${f.project.id}"] iframe`);await iframe.waitFor();
  await page.waitForFunction(({projectId,url})=>document.querySelector(`[data-project-id="${projectId}"] iframe`)?.getAttribute('src')===url,{projectId:f.project.id,url:receipt.url});
  expect(await iframe.getAttribute('src')).toBe(receipt.url);
  const frame=page.frameLocator(`[data-project-id="${f.project.id}"] iframe`);
  const button=frame.getByRole('button',{name:'0',exact:true});await button.evaluate((el:HTMLElement)=>el.click());expect(await frame.getByRole('button',{name:'1',exact:true}).textContent()).toBe('1');
  expect(await frame.getByRole('link',{name:'Source'}).getAttribute('href')).toBe('https://example.org/source');
  expect(loaded).toContain('https://app.test'+receipt.url);expect(errors).toEqual([]);
  expect((f.app.db.query('SELECT status FROM requests WHERE id=?').get(t.id) as any).status).toBe('building');
 }finally{await browser.close();f.close();}
},15000);

test('reserved-version mismatch and a changed base revision cannot publish or charge; conflicting duplicate artifact receipts are rejected',async()=>{
 const f=fixture();try{
  const t=await f.prepare();
  expect(()=>beginAgentPublication(f.app.workshop,{...t.body,candidate:{...t.body.candidate,version:t.build.version+1}})).toThrow('receipt_denied');
  expect((f.app.db.query('SELECT COUNT(*) n FROM agent_publications').get() as any).n).toBe(0);
  beginAgentPublication(f.app.workshop,t.body);const verified=t.verified();
  const p=f.app.workshop.project(f.member,f.project.id);const changed=f.app.workshop.addRevision(p,f.app.workshop.assets.put('<html><body>Concurrent restored version</body></html>'),f.member.pubkey);
  expect(()=>registerAgentPublication(f.app.workshop,verified)).toThrow('revision or allowance changed');
  expect(f.app.workshop.project(f.member,f.project.id).current_revision).toBe(changed);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
  expect((f.app.db.query('SELECT COUNT(*) n FROM remote_versions').get() as any).n).toBe(0);
 }finally{f.close();}
 const g=fixture();try{
  const t=await g.prepare();beginAgentPublication(g.app.workshop,t.body);const verified=t.verified();const first=registerAgentPublication(g.app.workshop,verified);
  expect(()=>registerAgentPublication(g.app.workshop,{...verified,candidate:{...verified.candidate,remoteStorage:{...verified.candidate.remoteStorage,contentUrl:'https://other.test/file'}}})).toThrow('receipt conflict');
  expect(registerAgentPublication(g.app.workshop,verified)).toEqual(first);expect(g.app.workshop.detail(g.member,g.project.id).revisions).toHaveLength(2);expect(g.app.auth.member(g.member.pubkey).allowance).toBe(19);
 }finally{g.close();}
});
