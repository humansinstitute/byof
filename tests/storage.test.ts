import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {nip19,generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {verifyDelivery} from '../src/pipeline/receiver.ts';
import {sha256} from '../src/assets.ts';
import {TowerStorageClient,type StorageTarget} from '../src/tower-storage-client.ts';
import {authorizeStorageHttp,type ManagedStorageScope,type StorageJobAuthority} from '../src/pipeline/managed-storage-transport.ts';
import {application} from '../src/application.ts';
import {dispatchFollowup} from '../src/pipeline/followup-dispatch.ts';
import {prepareTrustedFollowup,followupCandidate} from '../src/pipeline/followup.ts';
import {storeDelivery} from '../src/delivery-store.ts';
import {candidateStorageJob,getStorageJob,updateStorageJob,storeStorageDelivery,type StorageConfig} from '../src/storage.ts';
const npub=nip19.npubEncode('a'.repeat(64)),other=nip19.npubEncode('b'.repeat(64)),objectId=crypto.randomUUID();
const target:StorageTarget={towerUrl:'https://tower.example',workspaceId:crypto.randomUUID(),workspaceOwnerNpub:other,appNpub:npub};
const bytes=Buffer.from('<html><body>Private test</body></html>'),hash=sha256(bytes);
const scope:ManagedStorageScope={appId:crypto.randomUUID(),appRoot:'/app',autopilotRoot:'/autopilot',installationId:crypto.randomUUID(),ownerNpub:other,appPubkey:'a'.repeat(64),appOrigin:'https://byo.example',towerOrigin:target.towerUrl,workshopId:crypto.randomUUID()};
const job:StorageJobAuthority={jobId:crypto.randomUUID(),target,objectId,fileName:'v1.html',contentType:'text/html',sha256:hash,sizeBytes:bytes.length,operation:'build'};
test('managed storage authority denies different origins, workspaces, objects, methods and unselected bytes',()=>{
 const base=target.towerUrl+'/api/v4/storage/'+objectId;
 expect(()=>authorizeStorageHttp(scope,job,base,'GET')).not.toThrow();
 expect(()=>authorizeStorageHttp(scope,job,base,'PUT',{base64_data:bytes.toString('base64')})).not.toThrow();
 for(const [url,method,body] of [[base.replace('tower.example','evil.example'),'GET'],[target.towerUrl+'/api/v4/storage/'+crypto.randomUUID(),'GET'],[base+'/content','PUT',{base64_data:bytes.toString('base64')}],[base,'DELETE'],[base,'PUT',{base64_data:Buffer.from('scratch').toString('base64')}],[base+'/complete','POST',{sha256_hex:'0'.repeat(64)}],[base+'?x=1','GET'],[scope.appOrigin+'/api/v1/internal/storage/jobs/'+crypto.randomUUID(),'GET']])expect(()=>authorizeStorageHttp(scope,job,String(url),String(method),body)).toThrow();
 const preparing={...job,objectId:null},payload={file_name:job.fileName,content_type:'text/html',size_bytes:bytes.length,is_public:false,metadata:{purpose:'byo-napplet/version'}};
 const prepare=`${target.towerUrl}/api/v4/flightdeck-pg/workspaces/${target.workspaceId}/storage/prepare`;
 expect(()=>authorizeStorageHttp(scope,preparing,prepare,'POST',payload)).not.toThrow();
 expect(()=>authorizeStorageHttp(scope,preparing,prepare.replace(target.workspaceId,crypto.randomUUID()),'POST',payload)).toThrow();
 expect(()=>authorizeStorageHttp(scope,preparing,prepare,'POST',{...payload,is_public:true})).toThrow();
 expect(()=>authorizeStorageHttp(scope,{...job,operation:'read'},base,'PUT',{base64_data:bytes.toString('base64')})).toThrow();
});
test('managed publication authority permits only the exact installation-bound remote candidate payload',()=>{
 const candidate={requestId:crypto.randomUUID(),projectId:crypto.randomUUID(),candidate:{artifactPath:'.drafts/example/v1/index.html'},sourceBase64:bytes.toString('base64'),sourceSha256:hash};
 const url=scope.appOrigin+'/api/v1/internal/publication/candidate',authority={body:candidate};
 expect(()=>authorizeStorageHttp(scope,null,url,'POST',candidate,undefined,authority)).not.toThrow();
 for(const [changedUrl,changedMethod,changed] of [[url,'GET',candidate],[url+'?x=1','POST',candidate],[url,'POST',{...candidate,sourceSha256:'0'.repeat(64)}],[url,'POST',{...candidate,sourceBase64:Buffer.from('other').toString('base64')}],[url,'POST',{...candidate,extra:true}]])
  expect(()=>authorizeStorageHttp(scope,null,String(changedUrl),String(changedMethod),changed,undefined,authority)).toThrow();
});
test('Tower adapter verifies actual bytes, immutable completed retries and owner/uploader binding',async()=>{
 let completed=false,writes=0,tampered=false,wrongOwner=false;
 const request=async(url:string,method:string,body?:any)=>{
  if(url.endsWith('/complete')){expect(body.sha256_hex).toBe(hash);completed=true;return Response.json({});}
  if(method==='PUT'){writes++;expect(Buffer.from(body.base64_data,'base64')).toEqual(bytes);return Response.json({});}
  if(url.endsWith('/content'))return new Response(tampered?Buffer.from('mismatch'):bytes);
  return Response.json({object_id:objectId,owner_npub:wrongOwner?npub:other,created_by_npub:npub,owner_group_id:null,access_group_ids:[],file_name:'v1.html',content_type:'text/html',is_public:false,completed_at:completed?'now':null,sha256_hex:hash,size_bytes:bytes.length});
 };
 const client=new TowerStorageClient(target,request);
 const stored=await client.uploadAndVerify(objectId,'v1.html',bytes);expect(stored.artifact.sha256).toBe(hash);expect(stored.bytes).toEqual(new Uint8Array(bytes));expect(writes).toBe(1);
 await client.uploadAndVerify(objectId,'v1.html',bytes);expect(writes).toBe(1);
 tampered=true;await expect(client.uploadAndVerify(objectId,'v1.html',bytes)).rejects.toThrow('readback');
 tampered=false;wrongOwner=true;await expect(client.uploadAndVerify(objectId,'v1.html',bytes)).rejects.toThrow('binding');
});
test('storage failure stays pending, verified signed recovery registers exactly one remote version without another native turn',async()=>{
 const dir=mkdtempSync('/private/tmp/byo-storage-'),owner='a'.repeat(64),app=application({dataDir:dir,hostPubkey:null,origin:null,version:'test'});
 try{
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);const member=app.auth.member(owner),p=app.workshop.create(member,'spinner').project;
  const cfg:any={ownerPubkey:owner,projectId:p.id,conversationKey:p.conversation_id,builderRoot:dir+'/napplets',workshopId:p.workshop_id,fileVersions:true,replacementEnabled:true};
  const storage:StorageConfig={installationId:scope.installationId,appPubkey:owner,appNpub:npub,towerOrigin:target.towerUrl,workshopId:p.workshop_id,localRoot:cfg.builderRoot,pipeline:{} as any};
  app.db.run('INSERT INTO storage_binding(id,installation_id,workshop_id,target_json,local_root,status,probe_job_id,connected_actor) VALUES(1,?,?,?,?,?,?,?)',[storage.installationId,p.workshop_id,JSON.stringify(target),cfg.builderRoot,'ready',null,owner]);app.workshop.storageRequired=true;
  const id=crypto.randomUUID();app.workshop.request(member,p.id,{requestId:id,prompt:'Build test',expectedRevisionId:p.current_revision},true);
  let input:any,nativeCalls=0;await dispatchFollowup(app.workshop,member,p.id,id,cfg,async v=>{input=v;nativeCalls++;return {runId:id,receipt:{}};});
  const prepared=prepareTrustedFollowup(input,{ownerPubkey:owner,builderRoot:cfg.builderRoot,workshopId:p.workshop_id,fileVersions:true,legacy:{ownerPubkey:owner,projectId:p.id,conversationKey:p.conversation_id,directory:'/old'}}),b=input.replacementContext.fileBuild;
  writeFileSync(prepared.directory+'/'+b.artifactPath,bytes);
  const candidate=followupCandidate({...input,fileBuild:b,turn:{status:'completed',requestId:input.nativeRequestId,projectId:p.id,conversationKey:input.conversationKey,nativeSessionId:'native',sessionId:'session',receiptId:id,invocationRunId:id,sequence:1,reply:JSON.stringify({kind:'build',response:'Built',...b,validation:['Browser controls passed']})}});
  const initial={eventId:crypto.randomUUID(),attempt:1,bodyHash:'initial',envelope:{runId:id,deliveryId:crypto.randomUUID(),status:'ok',terminal:true as const,error:null,result:{requestId:id,projectId:p.id,...candidate}}};
  expect(()=>storeDelivery(app.db,initial,app.workshop)).toThrow('Verified Tower');expect(app.workshop.detail(member,p.id).revisions).toHaveLength(1);expect(existsSync(prepared.directory+'/v1/index.html')).toBe(false);
  const {jobId}=candidateStorageJob(app.workshop,storage,{requestId:id,projectId:p.id,candidate});expect(candidateStorageJob(app.workshop,storage,{requestId:id,projectId:p.id,candidate}).jobId).toBe(jobId);
  const pending={...initial,eventId:crypto.randomUUID(),bodyHash:'pending',envelope:{...initial.envelope,result:{...initial.envelope.result,action:'storage_pending',jobId,error:'read failed'}}};
  storeDelivery(app.db,pending,app.workshop);expect((app.db.query('SELECT response FROM requests WHERE id=?').get(id) as any).response).toBe('Built');expect((app.db.query('SELECT status FROM requests WHERE id=?').get(id) as any).status).toBe('storage_pending');expect(app.auth.member(owner).allowance).toBe(20);
  expect(()=>app.workshop.request(member,p.id,{requestId:crypto.randomUUID(),prompt:'Another build',expectedRevisionId:p.current_revision},true)).toThrow('already running');
  updateStorageJob(app.workshop,storage,jobId,{step:'preparing'});expect(()=>updateStorageJob(app.workshop,storage,jobId,{step:'preparing'})).toThrow();
  updateStorageJob(app.workshop,storage,jobId,{step:'prepared',objectId});
  const artifact={objectId,workspaceId:target.workspaceId,towerUrl:target.towerUrl,contentUrl:target.towerUrl+'/api/v4/storage/'+objectId+'/content',sha256:hash,sizeBytes:bytes.length,isPublic:false};
  expect(()=>updateStorageJob(app.workshop,storage,jobId,{step:'verified',artifact,base64:Buffer.from('wrong').toString('base64')})).toThrow('verification');
  updateStorageJob(app.workshop,storage,jobId,{step:'verified',artifact,base64:bytes.toString('base64')});expect(getStorageJob(app.workshop,storage,jobId).status).toBe('verified');
  const retryRun=crypto.randomUUID();app.db.run('UPDATE storage_jobs SET run_id=? WHERE id=?',[retryRun,jobId]);
  const envelope={...initial.envelope,runId:retryRun,deliveryId:crypto.randomUUID(),result:{...initial.envelope.result,jobId,remoteStorage:artifact}},signer=generateSecretKey(),body=JSON.stringify(envelope),callback='https://byo.example/api/v1/storage/callback';
  const signedDelivery=(attempt:number)=>{const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',callback],['method','POST'],['payload',sha256(body)],['run',retryRun],['delivery',envelope.deliveryId],['attempt',String(attempt)]]},signer);return verifyDelivery({body,authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),publicUrl:callback,signerPubkey:getPublicKey(signer),runHeader:retryRun,deliveryHeader:envelope.deliveryId});};
  const delivery=signedDelivery(1);
  expect(storeStorageDelivery(app.workshop,storage,delivery)).toBe('applied');expect(storeStorageDelivery(app.workshop,storage,signedDelivery(2))).toBe('duplicate');expect(app.workshop.detail(member,p.id).revisions).toHaveLength(2);expect(app.workshop.detail(member,p.id).artifacts[0].hosting).toBe('tower-private-s3');expect(app.auth.member(owner).allowance).toBe(19);expect(nativeCalls).toBe(1);signer.fill(0);expect((app.db.query('SELECT COUNT(*) n FROM remote_versions').get() as any).n).toBe(1);
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('setup lists only Tower-authorized workspaces and rejects selection/root/signature tampering before granting authority',async()=>{
 const {generateSecretKey,getPublicKey,finalizeEvent}=await import('nostr-tools'),{towerSetup,verifyStorageAuth}=await import('../src/storage.ts');
 const key=generateSecretKey(),owner=getPublicKey(key),dir=mkdtempSync('/private/tmp/byo-setup-'),app=application({dataDir:dir,hostPubkey:owner,origin:'https://byo.example',version:'test'}),originalFetch=globalThis.fetch;
 try{
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Host','extension','admitted',20,1]);const member=app.auth.member(owner),workshopId=(app.db.query('SELECT workshop_id FROM workshop_identity').get() as any).workshop_id;
  const config:StorageConfig={installationId:scope.installationId,appPubkey:scope.appPubkey,appNpub:npub,towerOrigin:target.towerUrl,workshopId,localRoot:dir+'/napplets',pipeline:{} as any};let calls=0;
  globalThis.fetch=(async(url:any)=>{calls++;expect(String(url)).toBe(target.towerUrl+'/api/v4/flightdeck-pg/workspaces');return Response.json({workspaces:[{identity:{workspace_id:target.workspaceId,workspace_owner_npub:other},label:'Authorized workspace'}]});}) as any;
  const signed=(url:string,method:string,body?:string)=>finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method',method],...(body?[['payload',sha256(body)]]:[])],content:''},key);
  const event=signed(target.towerUrl+'/api/v4/flightdeck-pg/workspaces','GET');
  expect(((await towerSetup(app.workshop,config,member,{operation:'connect',event})) as any).workspaces).toHaveLength(1);
  await expect(towerSetup(app.workshop,config,member,{operation:'bind',workspaceId:crypto.randomUUID(),localRoot:config.localRoot,event})).rejects.toThrow('authorized Tower list');
  await expect(towerSetup(app.workshop,config,member,{operation:'bind',workspaceId:target.workspaceId,localRoot:'/different',event})).rejects.toThrow('installation-configured');
  await expect(towerSetup(app.workshop,config,member,{operation:'bind',workspaceId:target.workspaceId,localRoot:config.localRoot,event})).rejects.toThrow('signature');expect(calls).toBe(1);
  const url='https://byo.example/api/v1/internal/storage/candidates',raw=JSON.stringify({requestId:'selected'}),authEvent=signed(url,'POST',raw),request=new Request(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(authEvent)).toString('base64')}});
  expect(verifyStorageAuth(request,raw,owner,'https://byo.example')).toBe(authEvent.id);expect(()=>verifyStorageAuth(request,'different',owner,'https://byo.example')).toThrow();expect(()=>verifyStorageAuth(request,raw,scope.appPubkey,'https://byo.example')).toThrow();
 }finally{globalThis.fetch=originalFetch;app.db.close();rmSync(dir,{recursive:true,force:true});key.fill(0);}
});
test('BYO namespace denies other app schemas and verifies durable receipts on retry',async()=>{
 const {TowerNamespaceClient,namespaceMigration}=await import('../src/tower-namespace.ts'),receipt={id:job.jobId,workspace_id:target.workspaceId,installation_id:scope.installationId,project_id:crypto.randomUUID(),version:1,object_id:objectId,sha256:hash,size_bytes:bytes.length},authority={...job,receipt};
 const base=target.towerUrl+`/api/v4/workspaces/${target.workspaceOwnerNpub}/apps/${target.appNpub}/db`;
 expect(()=>authorizeStorageHttp(scope,authority,base+'/migrations','POST',namespaceMigration)).not.toThrow();
 expect(()=>authorizeStorageHttp(scope,authority,base.replace(target.appNpub,other)+'/migrations','POST',namespaceMigration)).toThrow();
 expect(()=>authorizeStorageHttp(scope,authority,base+'/migrations','POST',{migrations:[{version:'evil',sql:'DROP TABLE other',checksum:hash}]})).toThrow();
 expect(()=>authorizeStorageHttp(scope,authority,base+'/tables/napplet_storage_receipts/rows','POST',{id:receipt.id,data:receipt})).not.toThrow();
 expect(()=>authorizeStorageHttp(scope,authority,base+'/tables/napplet_storage_receipts/rows','POST',{id:receipt.id,data:{...receipt,project_id:'another'}})).toThrow();
 let saved:any=null,writes=0;
 const request=async(url:string,method:string,body?:any)=>{authorizeStorageHttp(scope,authority,url,method,body);if(url.endsWith('/provision'))return Response.json({workspace_owner_npub:target.workspaceOwnerNpub,app_npub:target.appNpub,schema_name:'wapp_byo_freedom_abcdef123456'});if(url.endsWith('/migrations')){expect(body.migrations[0].checksum).toBe('sha256:'+sha256(body.migrations[0].sql));return Response.json({});}if(method==='POST'){expect(body.id).toBe(body.data.id);writes++;saved=JSON.parse(JSON.stringify(body.data));return Response.json({row:saved});}return Response.json({row:saved});};
 const client=new TowerNamespaceClient(target,request);await client.ensure();await client.receipt(receipt);await client.receipt(receipt);expect(writes).toBe(1);saved.sha256='wrong';await expect(client.receipt(receipt)).rejects.toThrow('mismatch');
});
test('admin workspace creation uses exact direct-user proof and configured signup gateway; inactive site is an explicit blocker',async()=>{
 const {createTowerWorkspace}=await import('../src/storage.ts'),key=generateSecretKey(),owner=getPublicKey(key),dir=mkdtempSync('/private/tmp/byo-create-'),app=application({dataDir:dir,hostPubkey:owner,origin:'https://byo.example',version:'test'}),originalFetch=globalThis.fetch;
 try{
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Host','extension','admitted',20,1]);const member=app.auth.member(owner),config:StorageConfig={installationId:scope.installationId,appPubkey:scope.appPubkey,appNpub:npub,towerOrigin:target.towerUrl,workshopId:crypto.randomUUID(),localRoot:dir,signupGatewayOrigin:'https://signup.example',pipeline:{} as any};
  const name='Private BYO workspace',id=crypto.randomUUID(),payload=JSON.stringify({workspace_name:name,idempotency_key:id,terms_version:'hosted-usd-v1'}),event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:crypto.randomUUID(),tags:[['u',target.towerUrl+'/api/v4/flightdeck-pg/hosted/workspaces'],['method','POST'],['payload',sha256(payload)]]},key),body={workspaceName:name,idempotencyKey:id,event};let ready=false,posts=0;
  globalThis.fetch=(async(url:any,init:any)=>{if(String(url).endsWith('/config'))return Response.json({signup_ready:ready,tower_public_base_url:target.towerUrl+'/'});posts++;expect(String(url)).toBe('https://signup.example/api/hosted/workspaces');expect(init.body).toBe(payload);return Response.json({workspace_id:target.workspaceId,descriptor:{identity:{workspace_owner_npub:nip19.npubEncode(owner)}}});}) as any;
  await expect(createTowerWorkspace(app.workshop,config,member,body)).rejects.toThrow('signup_ready=false');expect(posts).toBe(0);
  await expect(createTowerWorkspace(app.workshop,config,member,{...body,workspaceName:'Tampered'})).rejects.toThrow('signature');ready=true;expect((await createTowerWorkspace(app.workshop,config,member,body)).workspace_id).toBe(target.workspaceId);expect(posts).toBe(1);expect(app.db.query('SELECT * FROM storage_binding').get()).toBeNull();
 }finally{globalThis.fetch=originalFetch;app.db.close();rmSync(dir,{recursive:true,force:true});key.fill(0);}
});
