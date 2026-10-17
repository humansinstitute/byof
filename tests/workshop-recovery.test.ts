import {test,expect} from 'bun:test';
import {Workshop} from '../src/workshop.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {dispatchReplacement} from '../src/pipeline/replacement-dispatch.ts';
import {builderEpoch} from '../src/builder-lifecycle.ts';
import {confirmedPreSend} from '../src/pre-send-recovery.ts';
import {storeDelivery} from '../src/delivery-store.ts';
function fixture(){
  const dir=mkdtempSync('/tmp/recovery-'),app=application({dataDir:dir,hostPubkey:null,origin:'https://test',version:'test'});
  for(const owner of ['a','b'])app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,owner,'temporary','admitted',20,1]);
  const member=app.auth.member('a'),project=app.workshop.create(member,'game').project;
  app.workshop.request(member,project.id,{requestId:'q',prompt:'Latest exact\n',mode:'answer',expectedRevisionId:project.current_revision},true);
  const config:any={projectId:project.id,ownerPubkey:'a',conversationKey:project.conversation_id,directory:'/exact/project',replacementEnabled:true,initialContext:true};
  let input:any,run='initial',sends=0,error='Completed-turn session has unrelated queued prompts',status='preparing';
  const envelope=()=>({runId:run,status:'error',terminal:true,error,result:{turn:{receiptId:'receipt',requestId:input.nativeRequestId,projectId:project.id,conversationKey:input.conversationKey,status,error,sessionId:'child',executionId:'child',nativeSessionId:null,reply:null}}});
  const transport={poll:async()=>({response:envelope()}),submit:async(x:any)=>{input=x;run='run-'+(++sends);return {runId:run,receipt:{}}}};
  const fail=()=>storeDelivery(app.db,{eventId:'event-'+run,bodyHash:'hash-'+run,attempt:1,envelope:{...envelope(),deliveryId:'delivery-'+run} as any},app.workshop);
  return {app,member,project,config,transport,fail,input:()=>input,sends:()=>sends,setError:(value:string)=>{error=value},setStatus:(value:string)=>{status=value},close(){app.db.close();rmSync(dir,{recursive:true,force:true})}};
}
test('pre-send collision retries exact saved request, then idle transcript failure gets fresh immutable context; late old run is denied',async()=>{
 const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  const original=f.input(),revision=f.project.current_revision;
  f.fail();expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('failed');
  // Reproduce the old installation's incident classification.
  f.app.db.run("UPDATE requests SET status='execution_uncertain'");
  await Promise.all([dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport),dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport)]);
  expect(f.sends()).toBe(2);expect(f.input()).toEqual(original);expect(builderEpoch(f.app.workshop,f.project).generation).toBe(0);
  f.setError('Bound native conversation transcript unavailable');f.fail();
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  expect(f.sends()).toBe(3);expect(f.input().generation).toBe(1);expect(f.input().replacementContext.currentSource).toBe(original.source);
  expect(f.input().replacementContext.latestPrompt.content).toBe('Latest exact\n');expect(f.input().replacementContext.historyPolicy).toContain('ONLY latestPrompt');
  expect(()=>storeDelivery(f.app.db,{eventId:'late',bodyHash:'late',attempt:1,envelope:{runId:'run-1',deliveryId:'late',status:'error',terminal:true,error:'late',result:null}},f.app.workshop)).toThrow('unknown_run');
  expect(f.app.workshop.project(f.member,f.project.id).current_revision).toBe(revision);expect(f.app.auth.member('a').allowance).toBe(20);
 }finally{f.close()}
});
test('unknown send reconciliation keeps immutable native identity and never creates a fresh writer; foreign owner denied',async()=>{
 const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);const original=f.input();
  f.setStatus('uncertain');f.setError('Lost response');f.fail();
  await expect(dispatchReplacement(f.app.workshop,f.app.auth.member('b'),f.project.id,'q',f.config,f.transport)).rejects.toThrow('not found');
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  expect(f.input()).toEqual(original);expect(builderEpoch(f.app.workshop,f.project).generation).toBe(0);expect(f.app.auth.member('a').allowance).toBe(20);
 }finally{f.close()}
});
test('ambiguous execution is not advertised as manually recoverable without verified evidence',async()=>{
 const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  f.setStatus('uncertain');f.setError('Lost response');f.fail();
  const request=f.app.workshop.detail(f.member,f.project.id).requests.find((row:any)=>row.id==='q');
  expect(request.status).toBe('execution_uncertain');
  expect(request.recoverable).toBe(false);
 }finally{f.close()}
});
test('timeouts, active ordinary claims, ambiguous launches and mismatched correlation are never fresh-safe evidence',()=>{
 const e:any={status:'error',result:{turn:{status:'preparing',receiptId:'r',error:'Completed-turn session has unrelated queued prompts'}}};
 expect(confirmedPreSend(e)).toBe(true);
 const capacity:any={status:'error',result:{turn:{status:'preparing',receiptId:'capacity',error:'No available agent ports. Increase AGENT_MAX or free sessions.',requestId:'q',projectId:'p',conversationKey:'key',sessionId:null,executionId:null,nativeSessionId:null,reply:null}}};
 expect(confirmedPreSend(capacity,{requestId:'q',projectId:'p',conversationKey:'key'})).toBe(true);
 for(const change of [{sessionId:'child'},{executionId:'execution'},{nativeSessionId:'native'},{status:'uncertain'},{status:'sending'},{error:'No available agent ports'}])expect(confirmedPreSend({status:'error',result:{turn:{...capacity.result.turn,...change}}})).toBe(false);
 for(const error of ['Timed out waiting for session child to become prompt-ready. busy','Completed-turn session has unresolved ordinary delivery','Completed-turn resume launch outcome uncertain; requires session binding recovery'])expect(confirmedPreSend({status:'error',result:{turn:{...e.result.turn,error}}})).toBe(false);
 expect(confirmedPreSend(e,{requestId:'q',projectId:'p',conversationKey:'key'})).toBe(false);
});

test('bounded reconciliation then signed stopped-builder proof permits fresh generation; stale completion cannot promote or charge',async()=>{
 const f=fixture();try{
  f.config.abandonmentEnabled=true;
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  const original=f.input();f.setStatus('uncertain');f.setError('Lost response');f.fail();
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  expect(f.input().abandonUncertain).toBeUndefined();f.fail();
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  const stopping=f.input();expect(stopping.abandonUncertain).toBe(true);expect(stopping.nativeRequestId).toBe(original.nativeRequestId);expect(stopping.contextHash).toBe(original.contextHash);
  const run=(f.app.db.query('SELECT run_id FROM requests').get() as any).run_id;
  const receipt={status:'abandoned',receiptId:'stopped',sessionId:'old-builder',invocationRunId:run,requestId:'q',projectId:f.project.id,nativeRequestId:stopping.nativeRequestId,conversationKey:stopping.conversationKey,generation:stopping.generation,contextHash:stopping.contextHash,output:{writerStopped:true,abandonedReceiptId:'stopped'}};
  const proof:any={runId:run,deliveryId:'abandoned',status:'ok',terminal:true,error:null,result:{action:'builder_abandoned',banRequired:false,requestId:'q',projectId:f.project.id,nativeReceipt:receipt}};
  expect(()=>storeDelivery(f.app.db,{eventId:'bad-stop',bodyHash:'bad-stop',attempt:1,envelope:{...proof,result:{...proof.result,nativeReceipt:{...receipt,output:{writerStopped:false}}}}},f.app.workshop)).toThrow('abandonment_correlation_denied');
  storeDelivery(f.app.db,{eventId:'stopped-event',bodyHash:'stopped-hash',attempt:1,envelope:proof},f.app.workshop);
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,{...f.transport,poll:async()=>({response:proof})});
  expect(f.input().generation).toBe(1);expect(f.input().abandonUncertain).toBeUndefined();expect(f.input().source).toBe(original.source);expect(f.input().replacementContext.currentRevision).toBe(f.project.current_revision);
  expect(()=>storeDelivery(f.app.db,{eventId:'late-stop',bodyHash:'late-stop',attempt:1,envelope:{...proof,deliveryId:'late-stop'}},f.app.workshop)).toThrow('unknown_run');
  expect(f.app.auth.member('a').allowance).toBe(20);
 }finally{f.close()}
});

test('automatic outage recovery is bounded and restart-safe; newer instructions supersede old automatic retries',async()=>{
 const {recoverWorkshopBuilders}=await import('../src/workshop-recovery.ts');const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);f.fail();let attempts=0;
  const unavailable:any=async()=>{attempts++;throw Error('outage')};
  for(let i=0;i<8;i++){f.app.db.run('UPDATE automatic_recovery SET next_at=0');await recoverWorkshopBuilders(f.app.workshop,f.app.auth,f.config,unavailable)}
  expect(attempts).toBe(4);expect(f.app.auth.member('a').allowance).toBe(20);expect(f.app.workshop.project(f.member,f.project.id).current_revision).toBe(f.project.current_revision);
  // Deliberate retry still works after automatic retry budget is exhausted.
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);expect(f.sends()).toBe(2);f.fail();
  f.app.workshop.request(f.member,f.project.id,{requestId:'newer',prompt:'Use the saved app',mode:'answer',expectedRevisionId:f.project.current_revision},false);
  await recoverWorkshopBuilders(f.app.workshop,f.app.auth,f.config,unavailable);expect(attempts).toBe(4);
  await expect(dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport,{automatic:true})).rejects.toThrow('newer saved instruction');
 }finally{f.close()}
});

test('background recovery reuses saved private-storage requirement instead of last browser scope configuration',async()=>{
 const {recoverWorkshopBuilders}=await import('../src/workshop-recovery.ts');const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);f.fail();
  f.app.db.run('INSERT INTO local_builds(request_id,project_id,directory,version,artifact_path,storage_required) VALUES(?,?,?,?,?,1)',['q',f.project.id,'/exact/project',1,'.drafts/old/v1/index.html']);
  let observed=false;
  await recoverWorkshopBuilders(f.app.workshop,f.app.auth,f.config,(async(scope:any)=>{observed=scope.storageRequired;return {}}) as any,{storageRequired:()=>false});
  expect(observed).toBe(true);
 }finally{f.close()}
});

test('interrupted save before dispatch is durably bounded, then resumes exactly once',async()=>{
 const {recoverWorkshopBuilders}=await import('../src/workshop-recovery.ts');const {neverDispatched}=await import('../src/queued-recovery.ts');const f=fixture();try{
  f.app.db.run('UPDATE requests SET created_at=created_at-60');
  expect(neverDispatched(f.app.db,f.app.db.query('SELECT * FROM requests').get())).toBe(true);
  let attempts=0;const outage:any=async()=>{attempts++;throw Error('prepare failed')};
  for(let i=0;i<6;i++){f.app.db.run('UPDATE automatic_recovery SET next_at=0');await recoverWorkshopBuilders(f.app.workshop,f.app.auth,f.config,outage)}
  expect(attempts).toBe(4);expect(f.sends()).toBe(0);
  await Promise.all([dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport),dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport)]);
  expect(f.sends()).toBe(1);expect(f.input().prompt).toBe('Latest exact\n');expect(f.input().replacementContext.currentRevision).toBe(f.project.current_revision);expect(f.app.auth.member('a').allowance).toBe(20);
 }finally{f.close()}
});

test('pre-dispatch preparation throw returns actionable saved request, not lost submission',async()=>{
 const {dispatchFollowup}=await import('../src/pipeline/followup-dispatch.ts');const {neverDispatched}=await import('../src/queued-recovery.ts');const f=fixture();try{
  Workshop.datasetProviders.set(f.app.db,async()=>{throw Error('discovery offline')});
  const result:any=await dispatchFollowup(f.app.workshop,f.member,f.project.id,'q',f.config);
  expect(result.status).toBe('queued');expect(result.error).toContain('dispatch has not started');expect(neverDispatched(f.app.db,result)).toBe(true);expect(f.sends()).toBe(0);
 }finally{f.close()}
});

test('cancel wins during async preparation; duplicate retries and old callbacks cannot revive it',async()=>{
 const {cancelUnsentRequest}=await import('../src/queued-recovery.ts');const f=fixture();try{
  let release:any;Workshop.datasetProviders.set(f.app.db,()=>new Promise(resolve=>{release=resolve}));
  const pending=dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  await Promise.resolve();
  expect(()=>cancelUnsentRequest(f.app.workshop,f.app.auth.member('b'),f.project.id,'q')).toThrow('not found');
  expect((cancelUnsentRequest(f.app.workshop,f.member,f.project.id,'q') as any).status).toBe('cancelled');
  expect((cancelUnsentRequest(f.app.workshop,f.member,f.project.id,'q') as any).status).toBe('cancelled');
  f.app.workshop.request(f.member,f.project.id,{requestId:'newer',prompt:'Newer',mode:'answer',expectedRevisionId:f.project.current_revision},true);
  release({datasets:[]});await pending;
  Workshop.datasetProviders.delete(f.app.db);
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  expect(f.sends()).toBe(0);expect(f.app.db.query('SELECT * FROM request_epochs WHERE request_id=?').get('q')).toBeNull();
  expect(()=>storeDelivery(f.app.db,{eventId:'late',bodyHash:'late',attempt:1,envelope:{runId:'old',deliveryId:'late',status:'error',terminal:true,error:'late',result:null}},f.app.workshop)).toThrow('unknown_run');
 }finally{f.close()}
});

test('dispatch wins cancel race; ambiguous acceptance retains execution identity for retry',async()=>{
 const {cancelUnsentRequest,neverDispatched}=await import('../src/queued-recovery.ts');const f=fixture();try{
  let finish:any,keys:string[]=[];const t={poll:f.transport.poll,submit:async(input:any,key:string)=>{keys.push(key);await new Promise(resolve=>{finish=resolve});throw Error('acceptance lost')}};
  const pending=dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,t);
  await Promise.resolve();expect(()=>cancelUnsentRequest(f.app.workshop,f.member,f.project.id,'q')).toThrow('Dispatch may have started');finish();await pending;
  expect(neverDispatched(f.app.db,f.app.db.query('SELECT * FROM requests').get())).toBe(false);
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,{poll:t.poll,submit:async(input,key)=>{keys.push(key);return {runId:'accepted',receipt:{}}}});
  expect(keys[0]).toBe(keys[1]);expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('building');
 }finally{f.close()}
});

test('expired durable dispatch claim resumes same execution key after restart',async()=>{
 const {recoverWorkshopBuilders}=await import('../src/workshop-recovery.ts');const f=fixture();try{
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,{poll:f.transport.poll,submit:async()=>{throw Error('offline')}});
  const key=(f.app.db.query('SELECT execution_key FROM request_recoveries').get() as any).execution_key;
  f.app.db.run("UPDATE requests SET status='dispatching'");f.app.db.run('UPDATE request_recoveries SET claimed_at=0');
  let used='';await recoverWorkshopBuilders(f.app.workshop,f.app.auth,f.config,((scope:any,member:any,projectId:string,requestId:string,config:any,_unused:any,options:any)=>dispatchReplacement(scope,member,projectId,requestId,config,{poll:f.transport.poll,submit:async(_input,k)=>{used=k;return {runId:'recovered',receipt:{}}}},options)) as any);
  expect(used).toBe(key);expect((f.app.db.query('SELECT status FROM requests').get() as any).status).toBe('building');
 }finally{f.close()}
});

test('public readiness failure remains saved with its exact blocker; admission and pause still reject',async()=>{
 const {HttpError}=await import('../src/errors.ts');const f=fixture();try{
  Workshop.datasetProviders.set(f.app.db,async()=>{throw new HttpError(503,'Canvas destination differs from the managed app Tower binding')});
  const request:any=await dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport);
  expect(request.status).toBe('queued');expect(request.error).toContain('Canvas destination differs');expect(request.run_id).toBeNull();expect(f.sends()).toBe(0);
  f.app.db.run('UPDATE room SET paused=1');Workshop.datasetProviders.delete(f.app.db);
  await expect(dispatchReplacement(f.app.workshop,f.member,f.project.id,'q',f.config,f.transport)).rejects.toThrow('paused');
 }finally{f.close()}
});
