import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {finalizeEvent,generateSecretKey,getPublicKey,nip19} from 'nostr-tools';
import {application} from '../src/application.ts';
import {bindRequestAttachments,chatAttachmentStatus,materializeRequestAttachments,prepareChatAttachment,requestAttachments} from '../src/chat-attachments.ts';
import {sha256} from '../src/assets.ts';
import {clipboardImages,imageMarkdown,imageUploadsBlockSend,insertImageMarkers,replaceImageMarker,submittedImageAttachments} from '../public/chat-attachments.js';
import {storeStorageDelivery,updateStorageJob} from '../src/storage.ts';
import {TowerStorageClient} from '../src/tower-storage-client.ts';

test('paste helpers preserve surrounding text, multiple markers, failures and ordinary text paste',()=>{
  const inserted=insertImageMarkers('before AFTER',7,7,['one','two']);
  expect(inserted.value).toBe('before [ Uploading image one... ]\n[ Uploading image two... ]AFTER');
  const first=replaceImageMarker(inserted.value,inserted.tokens[0]!,imageMarkdown('image.png','11111111-1111-4111-8111-111111111111'));
  const second=replaceImageMarker(first.value,inserted.tokens[1]!,'[ Image upload failed: image.jpg ]');
  expect(second.value).toContain('before ![image.png](storage://11111111-1111-4111-8111-111111111111)');
  expect(second.value.endsWith('[ Image upload failed: image.jpg ]AFTER')).toBe(true);
  expect(clipboardImages({items:[{kind:'string',type:'text/plain',getAsFile:()=>null}]} as any)).toEqual([]);
  const ready={status:'ready',attachment:{attachment_id:'a'}},failed={status:'error'};
  expect(submittedImageAttachments([ready,failed])).toEqual([{attachment_id:'a'}]);
  expect(imageUploadsBlockSend([ready,failed])).toBe(true);
});

test('request attachment snapshot is exact, linked in Markdown and materialized for Agent 21',()=>{
  const directory=mkdtempSync('/tmp/freedom-chat-attachment-'),app=application({dataDir:directory,hostPubkey:null,origin:null,version:'test'});
  try{
    const owner='a'.repeat(64);app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
    const member=app.auth.member(owner),project=app.workshop.create(member,'spinner').project,attachmentId=crypto.randomUUID(),objectId=crypto.randomUUID(),jobId=crypto.randomUUID(),bytes=Buffer.alloc(300_001,23),requestId=crypto.randomUUID();
    app.db.run('INSERT INTO storage_jobs(id,operation,candidate_json,target_json,file_name,sha256,size_bytes,base64,status,object_id,workshop_id,content_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[jobId,'chat_attachment','{}','{}','image.png',sha256(bytes),bytes.length,bytes.toString('base64'),'verified',objectId,app.workshop.id,'image/png']);
    app.db.run('INSERT INTO chat_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)',[attachmentId,app.workshop.id,project.id,owner,jobId,objectId,'image.png','image/png',bytes.length,sha256(bytes),1]);
    app.db.run('INSERT INTO requests(id,project_id,prompt,expected_revision,status,error,created_at,mode) VALUES(?,?,?,?,?,?,?,?)',[requestId,project.id,`look ![image.png](storage://${objectId})`,project.current_revision,'unavailable',null,1,'auto']);
    const payload={attachment_id:attachmentId,kind:'image',filename:'image.png',content_type:'image/png',size_bytes:bytes.length,storage_object_id:objectId};
    bindRequestAttachments(app.workshop,member,project.id,requestId,`look ![image.png](storage://${objectId})`,[payload]);
    expect(requestAttachments(app.workshop,requestId)).toEqual([payload]);
    expect(()=>bindRequestAttachments(app.workshop,member,project.id,requestId,'link removed',[payload])).toThrow('missing');
    expect(()=>bindRequestAttachments(app.workshop,member,project.id,requestId,`look ![image.png](storage://${objectId})`,[])).toThrow('changed after save');
    const built=materializeRequestAttachments(app.workshop,requestId,directory+'/project');
    expect(built[0]).toMatchObject({...payload,storage_ref:`storage://${objectId}`});
    expect(readFileSync(built[0].local_path)).toEqual(bytes);
  }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('300 KB PNG follows prepare, private Tower upload/readback, poll and immutable builder request binding',async()=>{
  const directory=mkdtempSync('/tmp/freedom-chat-storage-'),app=application({dataDir:directory,hostPubkey:null,origin:null,version:'test'}),appKey=generateSecretKey();
  try{
    const owner='a'.repeat(64);app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
    const member=app.auth.member(owner),project=app.workshop.create(member,'spinner').project,bytes=Buffer.alloc(300_001,31),attachmentId=crypto.randomUUID(),objectId=crypto.randomUUID(),runId=crypto.randomUUID(),credential=directory+'/pipeline-capability';writeFileSync(credential,'a'.repeat(43),{mode:0o600});
    const target={towerUrl:'https://tower.example',workspaceId:crypto.randomUUID(),workspaceOwnerNpub:nip19.npubEncode(owner),appNpub:nip19.npubEncode(getPublicKey(appKey))};
    const pipeline:any={brokerUrl:'http://127.0.0.1/api/internal/wapps/pipelines',credentialFile:credential,origin:'https://autopilot.example',definitionId:'storage',callbackUrl:'https://byo.example/api/v1/storage/callback',appPubkey:getPublicKey(appKey)};
    const pipelineFetch=async(_url:any,init:any)=>{const broker=JSON.parse(init.body),signedUrl=pipeline.origin+broker.path,bodyHash=broker.serializedBody?sha256(broker.serializedBody):null,tags=[['u',signedUrl],['method',broker.method],...(bodyHash?[['payload',bodyHash]]:[])],event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags},appKey),response=broker.method==='POST'?{runId}:{status:'ok',result:{action:'attachment_completed'}};return Response.json({response,httpStatus:200,receipt:{url:signedUrl,method:broker.method,bodyHash,event}});};
    const config:any={installationId:crypto.randomUUID(),appPubkey:getPublicKey(appKey),appNpub:target.appNpub,towerOrigin:target.towerUrl,workshopId:app.workshop.id,localRoot:directory+'/napplets',pipeline:{...pipeline,fetch:pipelineFetch}};
    const namespace=JSON.stringify({workspace_owner_npub:target.workspaceOwnerNpub,app_npub:target.appNpub,schema_name:'wapp_byo_freedom_test'});
    app.db.run('INSERT INTO storage_binding(id,installation_id,workshop_id,target_json,local_root,status,probe_job_id,connected_actor,namespace_json) VALUES(1,?,?,?,?,?,?,?,?)',[config.installationId,app.workshop.id,JSON.stringify(target),config.localRoot,'ready',null,owner,namespace]);
    const base64=bytes.toString('base64'),prepared:any=await prepareChatAttachment(app.workshop,member,config,project.id,{attachmentId,filename:'screenshot.png',contentType:'image/png',sizeBytes:bytes.length,base64});expect(prepared.status).toBe('uploading');
    const row=app.db.query('SELECT j.* FROM storage_jobs j JOIN chat_attachments a ON a.storage_job_id=j.id WHERE a.id=?').get(attachmentId) as any;expect(row.size_bytes).toBe(bytes.length);expect(row.content_type).toBe('image/png');expect(row.run_id).toBe(runId);
    const pollingFailure={...config,pipeline:{...pipeline,fetch:async()=>{throw Error('broker offline');}}},unavailable=await chatAttachmentStatus(app.workshop,member,pollingFailure,project.id,attachmentId);expect(unavailable).toMatchObject({status:'error',error:'Image upload status is unavailable. Check Canvas storage, then remove this image and paste it again.'});
    let complete=false,stored=Buffer.alloc(0);const towerRequest=async(url:string,method:string,body?:any)=>{if(url.endsWith('/storage/prepare'))return Response.json({object_id:objectId,is_public:false,owner_npub:target.workspaceOwnerNpub,identity:{workspace_id:target.workspaceId}});if(url.endsWith('/complete')){complete=true;return Response.json({});}if(method==='PUT'){stored=Buffer.from(body.base64_data,'base64');return Response.json({});}if(url.endsWith('/content'))return new Response(stored,{headers:{'content-length':String(stored.length)}});return Response.json({object_id:objectId,owner_npub:target.workspaceOwnerNpub,created_by_npub:target.appNpub,owner_group_id:null,access_group_ids:[],file_name:'screenshot.png',content_type:'image/png',is_public:false,completed_at:complete?'now':null,sha256_hex:sha256(bytes),size_bytes:bytes.length});};
    const tower=new TowerStorageClient(target,towerRequest),preparedObject=await tower.prepare('screenshot.png',bytes,'image/png'),storedResult=await tower.uploadAndVerify(preparedObject,'screenshot.png',bytes,'image/png');expect(storedResult.bytes).toEqual(new Uint8Array(bytes));
    updateStorageJob(app.workshop,config,row.id,{step:'preparing'});updateStorageJob(app.workshop,config,row.id,{step:'prepared',objectId});updateStorageJob(app.workshop,config,row.id,{step:'verified',artifact:storedResult.artifact,base64});
    storeStorageDelivery(app.workshop,config,{eventId:crypto.randomUUID(),bodyHash:'attachment-delivery',attempt:1,envelope:{deliveryId:crypto.randomUUID(),runId,terminal:true,status:'ok',error:null,result:{action:'attachment_completed',jobId:row.id,remoteStorage:storedResult.artifact}}});
    const ready:any=await chatAttachmentStatus(app.workshop,member,config,project.id,attachmentId);expect(ready).toMatchObject({status:'ready',storage_object_id:objectId,size_bytes:bytes.length,content_type:'image/png'});
    const prompt=`Use this screenshot ![screenshot.png](storage://${objectId})`,requestId=crypto.randomUUID(),payload={attachment_id:attachmentId,kind:'image',filename:'screenshot.png',content_type:'image/png',size_bytes:bytes.length,storage_object_id:objectId};
    app.workshop.request(member,project.id,{requestId,prompt,expectedRevisionId:project.current_revision,attachments:[payload]},false);const materialized=materializeRequestAttachments(app.workshop,requestId,directory+'/builder-project');expect(materialized[0]).toMatchObject({...payload,storage_ref:`storage://${objectId}`});expect(materialized[0].local_path).toContain(`/.attachments/${objectId}-screenshot.png`);expect(readFileSync(materialized[0].local_path)).toEqual(bytes);
    await expect(prepareChatAttachment(app.workshop,member,config,project.id,{attachmentId:crypto.randomUUID(),filename:'bad.svg',contentType:'image/svg+xml',sizeBytes:1,base64:'AA=='})).rejects.toThrow('PNG, JPEG, WebP or GIF');
    const tooLarge=Buffer.alloc(8_000_001,1);await expect(prepareChatAttachment(app.workshop,member,config,project.id,{attachmentId:crypto.randomUUID(),filename:'large.png',contentType:'image/png',sizeBytes:tooLarge.length,base64:tooLarge.toString('base64')})).rejects.toThrow('too large');
    const dispatchFailure={...config,pipeline:{...pipeline,fetch:async()=>Response.json({error:'offline'},{status:503})}};await expect(prepareChatAttachment(app.workshop,member,dispatchFailure,project.id,{attachmentId:crypto.randomUUID(),filename:'retry.png',contentType:'image/png',sizeBytes:1,base64:'AA=='})).rejects.toThrow('Image upload could not start');
  }finally{appKey.fill(0);app.db.close();rmSync(directory,{recursive:true,force:true});}
});
