import {executionLinks} from '../src/execution-links.ts';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { application } from '../src/application.ts';
import { dispatchFollowup, resumeFollowup, followupAvailable } from '../src/pipeline/followup-dispatch.ts';
import { prepareFollowup, followupCandidate } from '../src/pipeline/followup.ts';
import { bindRun, storeDelivery } from '../src/delivery-store.ts';
import type { FollowupConfig } from '../src/config.ts';
function fixture() {
  const directory = mkdtempSync('/tmp/byo-followup-');
  const app = application({dataDir:directory,origin:'https://test.example',hostPubkey:null,version:'test'});
  const owner = getPublicKey(generateSecretKey()); app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
  const member = app.auth.member(owner), project = app.workshop.create(member,'dice').project;
  const config = {projectId:project.id,ownerPubkey:owner,conversationKey:project.conversation_id} as FollowupConfig;
  const save = (id:string,mode='auto') => app.workshop.request(member,project.id,{requestId:id,prompt:'Exact instruction\n',expectedRevisionId:project.current_revision,mode},true) as any;
  return {app,member,project,config,save,close(){app.db.close();rmSync(directory,{recursive:true,force:true});}};
}
test('scope is pinned to owner/project/conversation; result mode and native completion are mandatory', () => {
  const scope = {projectId:'project',ownerPubkey:'owner',conversationKey:'conversation',directory:'/fixed'};
  const input = {...scope,requestId:'request',prompt:'What could I improve?\n',mode:'auto',source:'<html></html>'};
  expect(prepareFollowup(input,scope).prompt).toContain(JSON.stringify({mode:input.mode,instruction:input.prompt,attachments:[],currentSource:input.source}));
  for (const changed of [{projectId:'other'},{ownerPubkey:'other'},{conversationKey:'other'},{mode:'invalid'}]) expect(() => prepareFollowup({...input,...changed},scope)).toThrow();
  const turn = {...scope,requestId:'request',status:'completed',sessionId:'session',nativeSessionId:'native',receiptId:'receipt',sequence:2,invocationRunId:'run',reply:JSON.stringify({kind:'answer',response:'Try difficulty levels.'})};
  expect(followupCandidate({...input,turn}).action).toBe('answer_completed');
  for (const changed of [{mode:'build'},{turn:{...turn,status:'sending'}},{turn:{...turn,conversationKey:'foreign'}},{turn:{...turn,reply:JSON.stringify({kind:'answer',response:'Answer',source:'unwanted'})}}]) expect(() => followupCandidate({...input,turn,...changed})).toThrow();
});
test('concurrent dispatches and replay after restart return one run from immutable request snapshot', async () => {
  const f=fixture();try {
    f.save('request'); let calls=0, release!:(value:any)=>void;
    const submit = async () => {calls++;return await new Promise<any>(resolve=>release=resolve);};
    const pending=dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,submit);
    const duplicate:any=await dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,submit);
    expect(duplicate.status).toBe('dispatching');expect(calls).toBe(1);
    expect(()=>f.save('second')).toThrow('already running');
    release({runId:'run',receipt:{accepted:true}});await pending;
    const repeated:any=await dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,submit);
    expect(repeated.run_id).toBe('run');expect(calls).toBe(1);
    expect((f.app.db.query('SELECT prompt FROM requests').get() as any).prompt).toBe('Exact instruction\n');
    expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
    expect(followupAvailable({...f.project,owner:'someone'},f.config)).toBe(false);
    expect(followupAvailable({...f.project,id:'another'},f.config)).toBe(false);
  } finally {f.close();}
});
test('uncertain acceptance retries the same ID and payload, including after process loss', async () => {
  const f=fixture();try {
    f.save('request');const payloads:any[]=[];
    let row:any=await dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,async input=>{payloads.push(input);throw Error('response lost');});
    expect(row.status).toBe('dispatch_pending');
    f.app.db.run("UPDATE requests SET status='dispatching' WHERE id='request'"); f.app.db.run('UPDATE request_dispatch SET claimed_at=0');
    row=await dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,async input=>{payloads.push(input);return {runId:'same-run',receipt:{}};});
    expect(row.run_id).toBe('same-run');expect(payloads[0]).toEqual(payloads[1]);
    expect(()=>f.app.workshop.request(f.member,f.project.id,{requestId:'request',prompt:'Changed',expectedRevisionId:f.project.current_revision},true)).toThrow();
  } finally {f.close();}
});
function delivery(f:ReturnType<typeof fixture>,id:string,sequence:number,action='answer_completed',extra:any={}) {
  bindRun(f.app.db,id,'run-'+id);
  return {eventId:'event-'+id,attempt:1,bodyHash:'hash-'+id,envelope:{runId:'run-'+id,deliveryId:'delivery-'+id,status:'ok',terminal:true as const,error:null,
    result:{requestId:id,projectId:f.project.id,action,banRequired:false,response:'Helpful answer',nativeReceipt:{requestId:id,projectId:f.project.id,invocationRunId:'run-'+id,receiptId:'native-'+id,nativeSessionId:'native',sessionId:'session',sequence,conversationKey:f.project.conversation_id},...extra}}};
}
test('answers persist through reload without revision or charge; signed retry deduplicates; builds promote once in same conversation', () => {
  const f=fixture();try {
    f.save('question','answer');const answer=delivery(f,'question',1);
    expect(storeDelivery(f.app.db,answer,f.app.workshop)).toBe('applied');
    expect(storeDelivery(f.app.db,{...answer,eventId:'fresh-retry'},f.app.workshop)).toBe('duplicate');
    const detail=f.app.workshop.detail(f.member,f.project.id);
    expect((detail.requests[0] as any).response).toBe('Helpful answer');expect(detail.revisions.length).toBe(1);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
    f.save('update','build');const build=delivery(f,'update',2,'build_completed',{source:'<!doctype html><html><body>Updated</body></html>'});
    storeDelivery(f.app.db,build,f.app.workshop);storeDelivery(f.app.db,{...build,eventId:'build-retry'},f.app.workshop);
    expect(f.app.workshop.detail(f.member,f.project.id).revisions.length).toBe(2);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(19);
    expect(f.app.workshop.detail(f.member,f.project.id).project.shared_revision).toBeNull();
    expect((f.app.db.query('SELECT sequence FROM conversation_receipts').get() as any).sequence).toBe(2);
    const links=executionLinks(f.app.workshop,f.member,f.project.id,{...f.config,origin:'https://autopilot.test',definitionId:'user:owner:definition'});
    expect(links?.definition).toBe('https://autopilot.test/pipelines/definitions/user%3Aowner%3Adefinition');
    expect(links?.runs).toHaveLength(2);
    expect(links?.runs.every(r=>r.session?.startsWith('https://autopilot.test/live/'))).toBe(true);
    expect(links?.runs.map(r=>r.requestId)).toEqual(['question','update']);
  } finally {f.close();}
});
test('foreign native receipt, unwanted revision and stale sequence cannot mutate a conversation', () => {
  const f=fixture();try {
    f.save('first','answer');storeDelivery(f.app.db,delivery(f,'first',1),f.app.workshop);
    f.save('second','answer');const second=delivery(f,'second',2);const native=second.envelope.result.nativeReceipt;
    for(const changed of [{nativeReceipt:{...native,nativeSessionId:'foreign'}},{nativeReceipt:{...native,sequence:1}},{action:'build_completed',source:'<html></html>'},{nativeReceipt:{...native,invocationRunId:'another'}}]) {
      expect(()=>storeDelivery(f.app.db,{...second,envelope:{...second.envelope,result:{...second.envelope.result,...changed}}},f.app.workshop)).toThrow();
    }
    expect(f.app.workshop.detail(f.member,f.project.id).revisions.length).toBe(1);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
  } finally {f.close();}
});
test('invalid HTML or stale project becomes a durable failed result preserving source and allowance', () => {
  for(const stale of [false,true]) {
    const f=fixture();try {
      f.save('build','build');if(stale)f.app.workshop.restore(f.member,f.project.id,{expectedRevisionId:f.project.current_revision,revisionId:f.project.current_revision});
      const before=f.app.workshop.detail(f.member,f.project.id).project.current_revision;
      const candidate=delivery(f,'build',1,'build_completed',{source:stale?'<html>Candidate</html>':'<html><iframe></iframe></html>'});
      expect(storeDelivery(f.app.db,candidate,f.app.workshop)).toBe('applied');
      expect(storeDelivery(f.app.db,{...candidate,eventId:'retry'},f.app.workshop)).toBe('duplicate');
      const detail=f.app.workshop.detail(f.member,f.project.id);
      expect((detail.requests[0] as any).status).toBe('failed');expect(detail.project.current_revision).toBe(before);expect(f.app.auth.member(f.member.pubkey).allowance).toBe(20);
    } finally {f.close();}
  }
});
test('saved unavailable question recovery preserves prompt and enforces owner, pause and current revision', async () => {
  const f=fixture();try {
    const saved:any=f.app.workshop.submitUnavailable(f.member,f.project.id,{requestId:'saved',prompt:'  Suggestions?\n',expectedRevisionId:f.project.current_revision});
    expect(saved.status).toBe('unavailable');
    f.app.db.run('UPDATE room SET paused=1');
    await expect(dispatchFollowup(f.app.workshop,f.member,f.project.id,'saved',f.config,async()=>({runId:'run',receipt:{}}))).rejects.toThrow('paused');
    f.app.db.run('UPDATE room SET paused=0');
    await expect(dispatchFollowup(f.app.workshop,{...f.member,pubkey:'foreign'},f.project.id,'saved',f.config)).rejects.toThrow('Project not found');
    let input:any; await dispatchFollowup(f.app.workshop,f.member,f.project.id,'saved',f.config,async value=>{input=value;return {runId:'run',receipt:{}};});
    expect(input.prompt).toBe('  Suggestions?\n');expect(input.mode).toBe('auto');
  } finally {f.close();}
});

test('explicit answer requests work at zero build allowance while auto/build remain blocked', async () => {
  const f=fixture();try {
    f.app.db.run('UPDATE members SET allowance=0');const member=f.app.auth.member(f.member.pubkey);
    expect(()=>f.app.workshop.request(member,f.project.id,{requestId:'build',prompt:'Update',expectedRevisionId:f.project.current_revision,mode:'build'},true)).toThrow('allowance');
    f.app.workshop.request(member,f.project.id,{requestId:'answer',prompt:'Help?',expectedRevisionId:f.project.current_revision,mode:'answer'},true);
    const row:any=await dispatchFollowup(f.app.workshop,member,f.project.id,'answer',f.config,async()=>({runId:'answer-run',receipt:{}}));
    expect(row.run_id).toBe('answer-run');expect(f.app.auth.member(member.pubkey).allowance).toBe(0);
  }finally{f.close();}
});


test('verified pre-send recovery retains original snapshot/ID, old receipt and one new execution key', async () => {
  const f=fixture();try {
    f.save('request');await dispatchFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,async()=>({runId:'original-run',receipt:{original:true}}));
    f.app.db.run("UPDATE requests SET status='failed',error='Native unavailable' WHERE id='request'");
    const turn={receiptId:'receipt',status:'preparing',requestId:'request',projectId:f.project.id,conversationKey:f.project.conversation_id,error:'Completed-turn bound session unavailable',sessionId:null,executionId:null,nativeSessionId:null,reply:null};
    const original={runId:'original-run',status:'error',result:{turn}};
    const submissions:any[]=[];
    const transport={poll:async()=>({response:original}),submit:async(input:any,key:string)=>{submissions.push({input,key});if(submissions.length===1)throw Error('response lost');return {runId:'recovery-run',receipt:{recovered:true}};}};
    let row:any=await resumeFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,transport);
    expect(row.status).toBe('dispatch_pending');expect(row.run_id).toBe('original-run');
    row=await resumeFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,transport);
    expect(row.run_id).toBe('recovery-run');expect(submissions[0]).toEqual(submissions[1]);
    expect(submissions[0].input).toMatchObject({requestId:'request',prompt:'Exact instruction\n',recoverPreparation:true});
    expect(submissions[0].key).toBe('request:preparation-recovery');
    await resumeFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,transport);expect(submissions.length).toBe(2);
    expect((f.app.db.query('SELECT run_id FROM dispatch_receipts').get() as any).run_id).toBe('original-run');
    expect((f.app.db.query('SELECT previous_run,new_run FROM request_recoveries').get() as any)).toMatchObject({previous_run:'original-run',new_run:'recovery-run'});
  } finally {f.close();}
});
test('recovery refuses uncertain sends, wrong project and changed source revision without dispatch', async () => {
  for(const change of [{status:'sending'},{nativeSessionId:'native'},{sessionId:'child'},{executionId:'child'},{projectId:'foreign'},{error:'Uncertain launch'}]) {
    const f=fixture();try {
      f.save('request');bindRun(f.app.db,'request','original-run');f.app.db.run("UPDATE requests SET status='failed'");let sends=0;
      const turn={receiptId:'receipt',status:'preparing',requestId:'request',projectId:f.project.id,conversationKey:f.project.conversation_id,error:'Completed-turn bound session unavailable',...change};
      await expect(resumeFollowup(f.app.workshop,f.member,f.project.id,'request',f.config,{poll:async()=>({response:{runId:'original-run',status:'error',result:{turn}}}),submit:async()=>{sends++;return {runId:'run',receipt:{}};}})).rejects.toThrow('not be replayed');
      expect(sends).toBe(0);
    } finally {f.close();}
  }
});
