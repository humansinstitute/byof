import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {reconcileAcceptedRun,reconcileStaleBuildingRequests,type DeliveryRecoveryTransport} from '../src/stale-building-recovery.ts';
import {storeDelivery} from '../src/delivery-store.ts';

function fixture(mode:'answer'|'build'='answer'){
  const dir=mkdtempSync('/tmp/stale-building-'),app=application({dataDir:dir,hostPubkey:null,origin:'https://test',version:'test'});
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',['a','Owner','temporary','admitted',20,1]);
  const member=app.auth.member('a'),project=app.workshop.create(member,'dice').project;
  app.workshop.request(member,project.id,{requestId:'request',prompt:'Keep this exact request',mode,expectedRevisionId:project.current_revision},true);
  app.db.run("UPDATE requests SET status='building',run_id='accepted-run',created_at=1 WHERE id='request'");
  const config:any={projectId:project.id,ownerPubkey:'a',conversationKey:project.conversation_id,directory:'/exact/project',replacementEnabled:true,initialContext:true};
  const close=()=>{app.db.close();rmSync(dir,{recursive:true,force:true})};
  return {app,member,project,config,close};
}
function transport(run:any,delivery:any,retry?:any){
  retry??={outcome:'requeued',delivery:{id:delivery?.delivery?.id,runId:'accepted-run',status:'pending'}};
  const calls:string[]=[];
  const value:DeliveryRecoveryTransport={
    poll:async id=>{calls.push('poll:'+id);return {response:run}},
    delivery:async id=>{calls.push('delivery:'+id);return {response:delivery}},
    retryDelivery:async id=>{calls.push('retry:'+id);if(retry instanceof Error)throw retry;return {response:retry}},
  };
  return {value,calls};
}

test('terminal failed delivery requests one same-run retry and repeated recovery is locally bounded',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:true,status:'ok'},{runId:'accepted-run',terminal:true,status:'ok',delivery:{id:'delivery',runId:'accepted-run',status:'failed',attempts:5}});
  try{
    const first=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);
    const repeated=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);
    expect(first.state).toBe('retrying_delivery');expect(repeated.state).toBe('retrying_delivery');
    expect(t.calls).toEqual(['poll:accepted-run','delivery:accepted-run','retry:accepted-run']);
    expect(f.app.db.query("SELECT status,run_id FROM requests WHERE id='request'").get()).toEqual({status:'building',run_id:'accepted-run'});
    expect((f.app.db.query('SELECT retry_requests FROM request_delivery_reconciliation').get() as any).retry_requests).toBe(1);
  }finally{f.close()}
});

test('nonterminal run reports useful state and never asks for delivery retry',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:false,status:'running'},null);
  try{const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);expect(result).toMatchObject({state:'still_running',remoteStatus:'running'});expect(t.calls).toEqual(['poll:accepted-run']);}
  finally{f.close()}
});

test('mismatched run and delivery correlation never retries',async()=>{
  for(const [run,delivery] of [
    [{runId:'foreign',terminal:true,status:'ok'},null],
    [{runId:'accepted-run',terminal:true,status:'ok'},{runId:'foreign',terminal:true,status:'ok',delivery:{runId:'foreign',status:'failed'}}],
  ] as any[]){
    const f=fixture(),t=transport(run,delivery);try{expect((await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value)).state).toBe('correlation_failed');expect(t.calls.some(call=>call.startsWith('retry:'))).toBe(false);}finally{f.close()}
  }
});

test('remote delivered state without a matching local receipt is surfaced for review, never claimed recovered',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:true,status:'ok'},{runId:'accepted-run',delivery:{id:'delivery',runId:'accepted-run',status:'delivered'}},{outcome:'delivered',delivery:{id:'delivery',runId:'accepted-run',status:'delivered'}});
  try{const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);expect(result).toMatchObject({state:'unsupported',deliveryStatus:'delivered'});expect(result.message).toContain('no matching receipt');expect(t.calls).toEqual(['poll:accepted-run','delivery:accepted-run']);expect((f.app.db.query("SELECT status FROM requests WHERE id='request'").get() as any).status).toBe('building');}
  finally{f.close()}
});

test('answer-only delivered callback is complete without publication and duplicate recovery does no remote work',async()=>{
  const f=fixture(),t=transport(null,null);try{
    f.app.db.run("UPDATE requests SET status='succeeded',response='Retained answer' WHERE id='request'");
    f.app.db.run('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)',['delivery','accepted-run','request','hash','succeeded','{}',2]);
    f.app.db.run('INSERT INTO request_delivery_reconciliation(request_id,run_id,state,message) VALUES(?,?,?,?)',['request','accepted-run','retrying_delivery','Retrying']);
    const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);
    expect(result).toMatchObject({state:'recovered',available:false,deliveryStatus:'delivered'});expect(t.calls).toEqual([]);
  }finally{f.close()}
});

test('retried signed result applies once and duplicate callbacks preserve recovered state',()=>{
  const f=fixture(),receipt={requestId:'request',projectId:f.project.id,invocationRunId:'accepted-run',stepId:'step',runId:'accepted-run',receiptId:'receipt',nativeSessionId:'native',sessionId:'session',executionId:'execution',sequence:1,conversationKey:f.project.conversation_id};
  const delivery:any={eventId:'event-1',bodyHash:'same-body',attempt:6,envelope:{runId:'accepted-run',deliveryId:'retained-delivery',terminal:true,status:'ok',error:null,result:{action:'answer_completed',requestId:'request',projectId:f.project.id,banRequired:false,response:'Recovered answer',nativeReceipt:receipt}}};
  try{
    f.app.db.run('INSERT INTO request_delivery_reconciliation(request_id,run_id,state,message,retry_requests) VALUES(?,?,?,?,1)',['request','accepted-run','retrying_delivery','Retrying']);
    expect(storeDelivery(f.app.db,delivery,f.app.workshop)).toBe('applied');
    expect(storeDelivery(f.app.db,{...delivery,eventId:'event-2',attempt:7},f.app.workshop)).toBe('duplicate');
    expect(f.app.db.query("SELECT status,response FROM requests WHERE id='request'").get()).toEqual({status:'succeeded',response:'Recovered answer'});
    expect((f.app.db.query('SELECT state FROM request_delivery_reconciliation').get() as any).state).toBe('recovered');
  }finally{f.close()}
});

test('implementation reply recovery independently reports publication still required',async()=>{
  const f=fixture('build'),t=transport(null,null);try{
    f.app.db.run("UPDATE requests SET status='storage_pending',response='The implementation is complete.' WHERE id='request'");
    f.app.db.run('INSERT INTO request_recoveries(request_id,previous_run,execution_key,input_json) VALUES(?,?,?,?)',['request','accepted-run','key',JSON.stringify({replacementContext:{fileBuild:{publication:'agent-tool-v1'}}})]);
    f.app.db.run('INSERT INTO agent_publications(request_id,run_id,candidate_json,status,error) VALUES(?,?,?,?,?)',['request','accepted-run','{}','pending','Publication authority unavailable']);
    f.app.db.run('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)',['delivery','accepted-run','request','hash','storage_pending','{}',2]);
    f.app.db.run('INSERT INTO request_delivery_reconciliation(request_id,run_id,state,message) VALUES(?,?,?,?)',['request','accepted-run','retrying_delivery','Retrying']);
    const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);
    expect(result).toMatchObject({state:'publication_failed',available:false});expect(t.calls).toEqual([]);
  }finally{f.close()}
});

test('unavailable retry support remains recoverable and never changes the accepted run',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:true,status:'ok'},{runId:'accepted-run',delivery:{id:'delivery',runId:'accepted-run',status:'failed'}},new Error('managed_pipeline_http_405'));
  try{const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value);expect(result.state).toBe('unsupported');expect(result.message).toContain('does not yet support');expect((f.app.db.query("SELECT run_id FROM requests WHERE id='request'").get() as any).run_id).toBe('accepted-run');}
  finally{f.close()}
});

test('missing project recovery authority is an actionable state, not permission to resubmit',async()=>{
  const f=fixture();try{const result=await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',undefined);expect(result.state).toBe('unauthorized');expect((f.app.db.query("SELECT status,run_id FROM requests WHERE id='request'").get() as any)).toEqual({status:'building',run_id:'accepted-run'});}finally{f.close()}
});

test('pending retained delivery is observed without requesting another retry',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:true,status:'ok'},{runId:'accepted-run',delivery:{id:'delivery',runId:'accepted-run',status:'pending'}});
  try{expect(await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value)).toMatchObject({state:'retrying_delivery',deliveryStatus:'pending'});expect(t.calls).toEqual(['poll:accepted-run','delivery:accepted-run']);}finally{f.close()}
});

test('mismatched retained delivery identity blocks retry correlation',async()=>{
  const f=fixture(),t=transport({runId:'accepted-run',terminal:true,status:'ok'},{runId:'accepted-run',delivery:{id:'delivery',runId:'accepted-run',status:'failed'}},{outcome:'requeued',delivery:{id:'other',runId:'accepted-run',status:'pending'}});
  try{expect((await reconcileAcceptedRun(f.app.workshop,f.member,f.project.id,'request',f.config,t.value)).state).toBe('correlation_failed');expect(t.calls).toEqual(['poll:accepted-run','delivery:accepted-run','retry:accepted-run']);}finally{f.close()}
});

test('automatic stale reconciliation is restart-safe, delayed and bounded',async()=>{
  const f=fixture();let calls=0;const reconcile:any=async()=>{calls++;return {state:'still_running'}};
  try{
    for(let i=0;i<9;i++){f.app.db.run('UPDATE request_delivery_reconciliation SET next_check_at=0');await reconcileStaleBuildingRequests(f.app.workshop,f.app.auth,f.config,reconcile);}
    expect(calls).toBe(6);expect((f.app.db.query('SELECT automatic_attempts FROM request_delivery_reconciliation').get() as any).automatic_attempts).toBe(6);
  }finally{f.close()}
});
