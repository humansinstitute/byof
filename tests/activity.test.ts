import {dispatchReplacement} from '../src/pipeline/replacement-dispatch.ts';
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {application} from '../src/application.ts';
import {verifyActivity,type ActivityEnvelope} from '../src/pipeline/activity-receiver.ts';
import {bindActivityAuthority,bindActivityRecovery,installActivityTables,storeActivity,requestActivity} from '../src/activity-store.ts';
import {bindRun,storeDelivery} from '../src/delivery-store.ts';
import {followupCandidate} from '../src/pipeline/followup.ts';
import type {OperatorBuildConfig} from '../src/config.ts';
const signer=generateSecretKey(),url='https://test.example/api/v1/pipeline/activity',clock=Math.floor(Date.now()/1000);
export function activityFixture() {
 const directory=mkdtempSync('/tmp/freedom-activity-');
 const app=application({dataDir:directory,origin:'https://test.example',hostPubkey:null,version:'test',callbackSignerPubkey:getPublicKey(signer)});
 const owner=getPublicKey(generateSecretKey());app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
 const member=app.auth.member(owner),project=app.workshop.create(member,'game').project;
 const config={activityWebhookUrl:url,definitionId:'definition'} as OperatorBuildConfig;
 function save(id='request',run='run',mode='auto') {
  const projectNow=app.workshop.project(member,project.id);
  app.workshop.request(member,project.id,{requestId:id,prompt:'Help or build',expectedRevisionId:projectNow.current_revision,mode},true);
  bindRun(app.db,id,run);app.db.run("UPDATE requests SET status='building' WHERE id=?",[id]);
  bindActivityAuthority(app.db,id,run,{requestId:id,projectId:project.id,workshopId:app.workshop.id,nativeRequestId:id},config);
 }
 save();
 function event(sequence=1,type:ActivityEnvelope['type']='commentary',extra:Partial<ActivityEnvelope>={}) {
  return {version:1,eventId:createHash('sha256').update('event'+sequence+JSON.stringify(extra)).digest('hex'),sequence,runId:'run',stepId:'step',turnId:'receipt',sessionId:'session',correlation:{requestId:'request',projectId:project.id,workshopId:app.workshop.id,nativeRequestId:'request',generation:'0'},timestamp:new Date(clock*1000).toISOString(),type,content:type==='commentary'?'Public update':({tools:'Using tools',completed:'Completed',failed:'Failed'} as any)[type],...extra} as ActivityEnvelope;
 }
 function signed(e:ActivityEnvelope,createdAt=clock,key=signer,alterTags?:string[][]) {
  const body=JSON.stringify(e);const auth=finalizeEvent({kind:27235,content:'',created_at:createdAt,tags:alterTags??[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['event',e.eventId],['run',e.runId]]},key);
  return {body,authorization:'Nostr '+Buffer.from(JSON.stringify(auth)).toString('base64'),publicUrl:url,signerPubkey:getPublicKey(signer),eventHeader:e.eventId,runHeader:e.runId};
 }
 function final(id='request',run='run',sequence=1,response='Complete final answer',build=false,valid=true) {
  return {eventId:'final-'+id,attempt:1,bodyHash:'hash-'+id,envelope:{runId:run,deliveryId:'delivery-'+id,status:'ok',terminal:true as const,error:null,result:{action:build?'build_completed':'answer_completed',requestId:id,projectId:project.id,banRequired:false,response,...(build?{source:valid?'<!doctype html><html><body>Updated</body></html>':'<html><iframe></iframe></html>'}:{}),nativeReceipt:{requestId:id,projectId:project.id,invocationRunId:run,invocationStepId:'step',stepId:'step',runId:run,receiptId:id==='request'?'receipt':'receipt2',nativeSessionId:'native',sessionId:'session',executionId:'execution-'+id,sequence,conversationKey:project.conversation_id}}}};
 }
 return {app,member,project,event,signed,save,final,close(){app.db.close();rmSync(directory,{recursive:true,force:true});}};
}
test('activity verifies exact URL/method/raw bytes, signer, tags and headers before accepting duplicates',()=>{
 const f=activityFixture();try{
  const e=f.event(),s=f.signed(e);expect(storeActivity(f.app.db,verifyActivity(s),clock)).toBe('applied');
  expect(storeActivity(f.app.db,verifyActivity(f.signed(e,clock-1000)),clock)).toBe('duplicate');
  for(const change of [{publicUrl:url+'?extra=1'},{body:s.body+' '},{runHeader:'foreign'},{eventHeader:'foreign'},{authorization:f.signed(e,clock,generateSecretKey()).authorization}])expect(()=>verifyActivity({...s,...change})).toThrow();
  const tags=[['u',url],['method','GET'],['payload',createHash('sha256').update(s.body).digest('hex')],['event',e.eventId],['run',e.runId]];
  expect(()=>verifyActivity(f.signed(e,clock,signer,tags))).toThrow();
  expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(f.event(2),clock-1000)),clock)).toThrow('stale_signature');
  expect(requestActivity(f.app.db,'request')).toHaveLength(1);
 }finally{f.close();}
});
test('ordered durable source events dedup, reject changed payload/sequence/turn and never complete or promote',()=>{
 const f=activityFixture();try{
  for(const seq of [3,1,2])expect(storeActivity(f.app.db,verifyActivity(f.signed(f.event(seq,seq===2?'tools':'commentary'))),clock)).toBe('applied');
  const replay=requestActivity(f.app.db,'request');expect(replay.map(e=>e.sequence)).toEqual([1,2,3]);
  expect(replay.every(e=>e.receivedAt===new Date(clock*1000).toISOString())).toBe(true);
  expect(storeActivity(f.app.db,verifyActivity(f.signed(f.event(2,'tools'))))).toBe('duplicate');
  for(const e of [f.event(2,'commentary',{content:'Changed'}),f.event(4,'commentary',{turnId:'foreign'}),f.event(4,'commentary',{sessionId:'other'}),f.event(4,'commentary',{stepId:'other'}),f.event(4,'commentary',{runId:'foreign'}),f.event(4,'commentary',{correlation:{...f.event().correlation,nativeRequestId:'foreign'}})])expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(e)))).toThrow();
  const changed={...f.event(1),content:'Payload changed'};expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(changed)))).toThrow('payload_conflict');
  storeActivity(f.app.db,verifyActivity(f.signed(f.event(4,'completed'))));
  expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('building');
  expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
  expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(f.event(5))))).toThrow('after_terminal');
  storeDelivery(f.app.db,f.final(),f.app.workshop);
  expect(storeActivity(f.app.db,verifyActivity(f.signed(f.event(5))))).toBe('terminal_ignored');
  expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('succeeded');
 }finally{f.close();}
});
test('foreign participant/workshop mappings and unaccepted run IDs never enter private activity',async()=>{
 const f=activityFixture();try{
  for(const e of [f.event(1,'commentary',{runId:'unaccepted'}),f.event(1,'commentary',{correlation:{...f.event().correlation,projectId:'foreign'}}),f.event(1,'commentary',{correlation:{...f.event().correlation,workshopId:'foreign'}}),f.event(1,'commentary',{correlation:{...f.event().correlation,requestId:'foreign'}})])expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(e)))).toThrow('mapping');
  const other=getPublicKey(generateSecretKey());f.app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[other,'Other','temporary','admitted',20,1]);
  expect(()=>f.app.workshop.detail(f.app.auth.member(other),f.project.id)).toThrow('Project not found');
  const s=f.signed(f.event());const response=await f.app.handle(new Request(url,{method:'POST',headers:{authorization:s.authorization,'x-wingman-run-id':s.runHeader,'x-wingman-event-id':s.eventHeader},body:s.body}));
  expect(response.status).toBe(200);expect((await response.json()).handling).toBe('applied');
 }finally{f.close();}
});
test('full long final answer survives answer/app-changing/failed-validation turns and two native receipts',()=>{
 for(const build of [false,true])for(const valid of [false,true]){
  const f=activityFixture();try{
   const response='Full response\n'+('Useful detail. '.repeat(4000))+'\nEND';
   storeActivity(f.app.db,verifyActivity(f.signed(f.event())));
   const final=f.final('request','run',1,response,build,valid);storeDelivery(f.app.db,final,f.app.workshop);
   const detail=f.app.workshop.detail(f.member,f.project.id);expect((detail.requests[0] as any).response).toBe(response);
   expect((detail.requests[0] as any).status).toBe(build&&!valid?'failed':'succeeded');expect(detail.revisions.length).toBe(build&&valid?2:1);
   f.save('second','run2','answer');storeDelivery(f.app.db,f.final('second','run2',2,'Second native answer'),f.app.workshop);
   expect((f.app.db.query('SELECT native_id,sequence FROM conversation_receipts').get() as any)).toEqual({native_id:'native',sequence:2});
   expect(f.app.workshop.detail(f.member,f.project.id).requests).toHaveLength(2);
  }finally{f.close();}
 }
 const turn={status:'completed',requestId:'r',projectId:'p',conversationKey:'c',nativeSessionId:'n',sessionId:'s',executionId:'exec',receiptId:'receipt',sequence:1,invocationRunId:'run',reply:JSON.stringify({kind:'answer',response:'x'.repeat(60000)})};
 expect((followupCandidate({requestId:'r',projectId:'p',conversationKey:'c',turn}) as any).response).toHaveLength(60000);
});
test('authoritative final must agree with sender-attested receipt/session and cannot silently switch turn',()=>{
 const f=activityFixture();try{
  storeActivity(f.app.db,verifyActivity(f.signed(f.event())));
  const final=f.final();final.envelope.result.nativeReceipt.receiptId='foreign';expect(()=>storeDelivery(f.app.db,final,f.app.workshop)).toThrow('lineage');
  expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('building');expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);
 }finally{f.close();}
});

test('total progress outage and final-before-progress accept full authoritative reply, tombstone late retries and reject mismatched receipt',()=>{
 const f=activityFixture();try{
  storeDelivery(f.app.db,f.final(),f.app.workshop);
  const late=f.event();expect(storeActivity(f.app.db,verifyActivity(f.signed(late)))).toBe('terminal_ignored');
  expect(storeActivity(f.app.db,verifyActivity(f.signed(late,clock-1000)))).toBe('duplicate');
  expect(requestActivity(f.app.db,'request')).toEqual([]);expect((f.app.db.query('SELECT response FROM requests').get() as any).response).toBe('Complete final answer');
  expect(()=>storeActivity(f.app.db,verifyActivity(f.signed(f.event(2,'commentary',{turnId:'unrelated'}))))).toThrow('lineage');
 }finally{f.close();}
});
test('immutable replacement generation and native request must both match even when original request is unchanged',()=>{
 const f=activityFixture();try{
  f.app.db.run("UPDATE activity_authority SET native_request_id='request:generation:2',activity_generation='2'");
  const e=f.event(1,'commentary',{correlation:{...f.event().correlation,nativeRequestId:'request:generation:2',generation:'2'}});
  for(const correlation of [{...e.correlation,generation:'1'},{...e.correlation,nativeRequestId:'request'}])expect(()=>storeActivity(f.app.db,verifyActivity(f.signed({...e,correlation})))).toThrow('mapping');
  expect(storeActivity(f.app.db,verifyActivity(f.signed(e)))).toBe('applied');
 }finally{f.close();}
});
test('source sequence gaps are explicit, fill on late lower events, and revoked participant progress is receipted without public content',()=>{
 const f=activityFixture();try{
  storeActivity(f.app.db,verifyActivity(f.signed(f.event(3))));expect(requestActivity(f.app.db,'request')[0]!.gapBefore).toBe(2);
  storeActivity(f.app.db,verifyActivity(f.signed(f.event(1))));storeActivity(f.app.db,verifyActivity(f.signed(f.event(2))));expect(requestActivity(f.app.db,'request').some(e=>e.gapBefore)).toBe(false);
  f.app.db.run("UPDATE members SET state='banned' WHERE pubkey=?",[f.member.pubkey]);
  expect(storeActivity(f.app.db,verifyActivity(f.signed(f.event(4))))).toBe('access_ignored');expect(requestActivity(f.app.db,'request')).toHaveLength(3);
 }finally{f.close();}
});
test('failed completedTurn candidate retains full public final and rejects foreign signed activity lineage',()=>{
 const f=activityFixture();try{
  storeActivity(f.app.db,verifyActivity(f.signed(f.event())));
  const turn={status:'completed',requestId:'request',projectId:f.project.id,receiptId:'receipt',sessionId:'session',executionId:'exec',reply:JSON.stringify({response:'Complete failed-validation answer '+('long '.repeat(5000))}),invocationStepId:'step',stepId:'step',runId:'run'};
  const delivery={eventId:'failure',bodyHash:'hash',attempt:1,envelope:{runId:'run',deliveryId:'failed-final',status:'error',terminal:true as const,error:'candidate_parse_failed',result:{turn}}};
  expect(()=>storeDelivery(f.app.db,{...delivery,envelope:{...delivery.envelope,result:{turn:{...turn,receiptId:'foreign'}}}},f.app.workshop)).toThrow('lineage');
  storeDelivery(f.app.db,delivery,f.app.workshop);
  expect((f.app.db.query('SELECT status,response FROM requests').get() as any)).toEqual({status:'failed',response:JSON.parse(turn.reply).response});expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);
 }finally{f.close();}
});
test('registered original recovery receipt accepts a distinct invocation step and missing progress, but unknown lineage cannot promote',()=>{
 for(const progress of [false,true]){
  const f=activityFixture();try{
   if(progress)storeActivity(f.app.db,verifyActivity(f.signed(f.event())));
   const input={requestId:'request',nativeRequestId:'request',projectId:f.project.id,workshopId:f.app.workshop.id,conversationKey:f.project.conversation_id,activityGeneration:'0'};
   f.app.db.run("UPDATE requests SET run_id='recovery-run'");bindActivityAuthority(f.app.db,'request','recovery-run',input,{activityWebhookUrl:url,definitionId:'recovery-definition'} as OperatorBuildConfig);
   const final=f.final('request','recovery-run',1,'Recovered complete answer');final.envelope.result.nativeReceipt.runId='run';final.envelope.result.nativeReceipt.invocationStepId='new-invocation-step';
   expect(()=>storeDelivery(f.app.db,final,f.app.workshop)).toThrow('unregistered_original');
   expect(()=>bindActivityRecovery(f.app.db,'recovery-run','request',input,{runId:'run',stepId:'step',receiptId:'receipt',sessionId:'session',requestId:'foreign',projectId:f.project.id,conversationKey:f.project.conversation_id})).toThrow('recovery_activity_lineage');
   bindActivityRecovery(f.app.db,'recovery-run','request',input,{runId:'run',stepId:'step',receiptId:'receipt',sessionId:'session',requestId:'request',projectId:f.project.id,conversationKey:f.project.conversation_id});
   expect(storeDelivery(f.app.db,final,f.app.workshop)).toBe('applied');expect((f.app.db.query('SELECT response,status FROM requests').get() as any)).toEqual({response:'Recovered complete answer',status:'succeeded'});
   expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);
  }finally{f.close();}
 }
});
test('existing interim authority schema gains generation without losing accepted mapping',()=>{
 const f=activityFixture();try{
  f.app.db.exec('DROP TABLE activity_authority; CREATE TABLE activity_authority(run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,project_id TEXT NOT NULL,workshop_id TEXT NOT NULL,native_request_id TEXT NOT NULL,definition_id TEXT NOT NULL,receiver_url TEXT NOT NULL)');
  f.app.db.run('INSERT INTO activity_authority VALUES(?,?,?,?,?,?,?)',['run','request',f.project.id,f.app.workshop.id,'request','definition',url]);installActivityTables(f.app.db);
  expect((f.app.db.query('SELECT activity_generation,request_id FROM activity_authority').get() as any)).toEqual({activity_generation:'0',request_id:'request'});
  expect(storeActivity(f.app.db,verifyActivity(f.signed(f.event())))).toBe('applied');
 }finally{f.close();}
});
test('existing activity rows gain a nullable received time without inventing one',()=>{
 const f=activityFixture();try{
  f.app.db.exec('DROP TABLE request_activity; CREATE TABLE request_activity(event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),run_id TEXT NOT NULL,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,body_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(turn_id,sequence))');
  const historical=f.event();f.app.db.run('INSERT INTO request_activity VALUES(?,?,?,?,?,?,?)',[historical.eventId,'request','run','receipt',1,'hash',JSON.stringify(historical)]);
  installActivityTables(f.app.db);
  expect(requestActivity(f.app.db,'request')[0]!.receivedAt).toBeNull();
  const next=f.event(2,'tools');expect(storeActivity(f.app.db,verifyActivity(f.signed(next)),clock)).toBe('applied');
  expect(requestActivity(f.app.db,'request')[1]!.receivedAt).toBe(new Date(clock*1000).toISOString());
 }finally{f.close();}
});
test('fresh recovery generation binds the newly accepted run without borrowing the old native receipt',async()=>{
 const f=activityFixture();try{
  f.app.db.run("UPDATE requests SET status='failed'");
  const config:any={projectId:f.project.id,ownerPubkey:f.member.pubkey,conversationKey:f.project.conversation_id,replacementEnabled:true,initialContext:true,directory:'/exact/project',activityWebhookUrl:url,definitionId:'new-definition'};
  const turn={status:'preparing',error:'Completed-turn bound session unavailable',receiptId:'old-receipt',runId:'run',stepId:'old-step',requestId:'request',projectId:f.project.id,conversationKey:f.project.conversation_id,sessionId:null,executionId:null,nativeSessionId:null,reply:null};
  let submitted:any;
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'request',config,{poll:async()=>({response:{runId:'run',status:'error',error:turn.error,result:{turn}}}),submit:async input=>{submitted=input;return {runId:'new-run',receipt:{}}}});
  expect(submitted.nativeRequestId).toBe('request:generation:1');expect(submitted.workshopId).toBe(f.app.workshop.id);expect(submitted.activityGeneration).toBe('1');
  expect((f.app.db.query('SELECT run_id,status FROM requests').get() as any)).toEqual({run_id:'new-run',status:'building'});
  expect(f.app.db.query('SELECT * FROM activity_recovery_lineage').all()).toHaveLength(0);
  expect((f.app.db.query("SELECT native_request_id,activity_generation FROM activity_authority WHERE run_id='new-run'").get() as any)).toEqual({native_request_id:'request:generation:1',activity_generation:'1'});
 }finally{f.close();}
});
