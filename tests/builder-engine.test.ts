import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {application} from '../src/application.ts';
import {requestBuilderEngine,loadBuilderEngine,runtimeForAgent,builderAgents} from '../src/builder-engine.ts';
import {builderEpoch} from '../src/builder-lifecycle.ts';
import {dispatchReplacement} from '../src/pipeline/replacement-dispatch.ts';
import {prepareConfigurableBuilder} from '../src/pipeline/configurable-prepare.ts';
import {sha256} from '../src/assets.ts';
function fixture(initial?:any){const dir=mkdtempSync('/tmp/engine-'),owner='a'.repeat(64),app=application({dataDir:dir,hostPubkey:owner,origin:'https://test',version:'test',...(initial?{followup:initial}:{})});app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Admin','extension','admitted',20,1]);const member=app.auth.member(owner),project=app.workshop.create(member,'spinner').project;const config:any={projectId:project.id,ownerPubkey:owner,conversationKey:project.conversation_id,directory:'/exact/project',replacementEnabled:true,initialContext:true,selectableBuilder:true};const save=(id:string)=>app.workshop.request(member,project.id,{requestId:id,prompt:id,mode:'answer',expectedRevisionId:project.current_revision},true);const choose=(agent:string)=>app.workshop.builderEngine(member,{agent,expectedRevision:loadBuilderEngine(app.db,app.workshop.id).revision});return {app,member,project,config,save,choose,dir,close(){app.db.close();rmSync(dir,{recursive:true,force:true})}}}

test('all engine transitions preserve files/source/history and same-runtime conversation resumes without rotating',async()=>{
 for(const from of builderAgents)for(const to of builderAgents){const f=fixture();try{
  f.choose(from);f.save('first');let input:any;const transport={poll:async()=>{throw Error('no poll')},submit:async(x:any)=>{input=x;return {runId:x.requestId+'-run',receipt:{}}}};
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'first',f.config,transport);expect(input.builderRuntime).toEqual(runtimeForAgent(from));
  f.app.db.run("UPDATE requests SET status='succeeded',response='Saved first answer'");f.app.db.run('UPDATE builder_epochs SET native_id=?',[from+'-native']);
  f.choose(to);f.save('second');await dispatchReplacement(f.app.workshop,f.member,f.project.id,'second',f.config,transport);
  expect(input.builderRuntime).toEqual(runtimeForAgent(to));expect(input.generation).toBe(from===to?0:1);expect(input.replacementContext.workingDirectory).toBe('/exact/project');expect(input.replacementContext.messages.map((m:any)=>m.content)).toEqual(['first','Saved first answer','second']);expect(input.replacementContext.historyPolicy).toContain('Execute ONLY');expect(f.app.workshop.detail(f.member,f.project.id).revisions).toHaveLength(1);
  const prepared=prepareConfigurableBuilder(input,{prompt:'ordinary instructions'},f.dir);expect(prepared.agent).toBe(to);expect(prepared.model).toBe(runtimeForAgent(to).model);
  expect(()=>prepareConfigurableBuilder({...input,builderRuntime:runtimeForAgent(to==='goose'?'codex':'goose')},{},f.dir)).toThrow('snapshot_denied');
  expect(()=>prepareConfigurableBuilder({...input,builderEngineRevision:input.builderEngineRevision+1},{},f.dir)).toThrow('snapshot_denied');
 }finally{f.close()}}
});

test('queued and uncertain requests retain their saved runtime after admin changes; old legacy work keeps original grant',async()=>{
 const f=fixture();try{
  f.choose('claude');f.save('queued');const snapshot=requestBuilderEngine(f.app.db,'queued');f.choose('goose');let original:any,recovered:any;
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'queued',f.config,{poll:async()=>{throw Error()},submit:async(x)=>{original=x;return {runId:'original',receipt:{}}}});
  expect(original.builderRuntime).toEqual(runtimeForAgent('claude'));expect(original.builderEngineRevision).toBe(snapshot!.revision);
  f.app.db.run("UPDATE requests SET status='execution_uncertain'");f.choose('codex');
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'queued',f.config,{poll:async()=>({response:{runId:'original',status:'error',result:{turn:{status:'uncertain',sessionId:'claude-child',receiptId:'receipt',requestId:original.nativeRequestId,projectId:f.project.id,conversationKey:original.conversationKey}}}}),submit:async(x)=>{recovered=x;return {runId:'reconcile',receipt:{}}}});
  expect(recovered).toEqual(original);expect(builderEpoch(f.app.workshop,f.project).generation).toBe(0);
  expect(()=>f.app.db.run("UPDATE request_builder_engines SET runtime_json='{}'")).toThrow('immutable');expect(()=>f.app.db.run('DELETE FROM request_builder_engines')).toThrow('immutable');
  expect(()=>f.app.workshop.request(f.member,f.project.id,{requestId:'foreign',prompt:'q',expectedRevisionId:f.project.current_revision,agent:'goose'},false)).toThrow('administrator');
 }finally{f.close()}
});

test('existing Goose installation seed is preserved across settings reads and fresh requests',()=>{
 const f=fixture({builderRuntime:runtimeForAgent('goose')});try{expect(loadBuilderEngine(f.app.db,f.app.workshop.id).agent).toBe('goose');expect(loadBuilderEngine(f.app.db,f.app.workshop.id,'codex').agent).toBe('goose');f.save('seed');expect(requestBuilderEngine(f.app.db,'seed')!.runtime).toEqual(runtimeForAgent('goose'))}finally{f.close()}
});

test('Canvas selections do not lazily inherit an unrelated primary Canvas choice',async()=>{
 const f=fixture();try{
  f.choose('goose');
  // Site creation is exercised through the public API elsewhere; a scoped row
  // with no selection is the migration case that previously inherited primary.
  const id=crypto.randomUUID();f.app.db.run('INSERT INTO workshops(id,title,introduction,owner,created_at) VALUES(?,?,?,?,?)',[id,'Existing Canvas','Existing',f.member.pubkey,1]);
  expect(loadBuilderEngine(f.app.db,id).agent).toBe('codex');
  expect(loadBuilderEngine(f.app.db,f.app.workshop.id).agent).toBe('goose');
 }finally{f.close()}
});

test('admin can append one immutable correction only while a saved request is proven never dispatched',()=>{
 const f=fixture();try{
  f.save('mistaken');const allowance=f.app.db.query('SELECT allowance FROM members WHERE pubkey=?').get(f.member.pubkey) as any;
  f.choose('goose');const selected=loadBuilderEngine(f.app.db,f.app.workshop.id);
  const corrected=f.app.workshop.correctRequestBuilderEngine(f.member,f.project.id,'mistaken',{reason:'Wrong Canvas was selected',expectedRequestRevision:1,expectedCanvasRevision:selected.revision});
  expect(corrected.runtime).toEqual(runtimeForAgent('goose'));expect(corrected.revision).toBe(selected.revision);
  expect((f.app.db.query('SELECT allowance FROM members WHERE pubkey=?').get(f.member.pubkey) as any).allowance).toBe(allowance.allowance);
  expect(()=>f.app.workshop.correctRequestBuilderEngine(f.member,f.project.id,'mistaken',{reason:'Again',expectedRequestRevision:1,expectedCanvasRevision:selected.revision})).toThrow('already corrected');
  expect(()=>f.app.db.run("UPDATE request_builder_engine_corrections SET reason='changed'")).toThrow('immutable');
  expect(()=>f.app.db.run('DELETE FROM request_builder_engine_corrections')).toThrow('immutable');
  f.app.db.run("UPDATE requests SET status='cancelled' WHERE id='mistaken'");
  f.save('started');f.app.db.run("UPDATE requests SET run_id='run',status='building' WHERE id='started'");
  f.choose('claude');const next=loadBuilderEngine(f.app.db,f.app.workshop.id);
  expect(()=>f.app.workshop.correctRequestBuilderEngine(f.member,f.project.id,'started',{reason:'Too late',expectedRequestRevision:selected.revision,expectedCanvasRevision:next.revision})).toThrow('after dispatch');
 }finally{f.close()}
});

test('settings require site admin, revisions and CSRF; unavailable selection persists independently per workshop',async()=>{
 const dir=mkdtempSync('/tmp/engine-api-'),key=generateSecretKey(),origin='https://test.example',config={dataDir:dir,hostPubkey:getPublicKey(key),origin,version:'test'};let app=application(config);
 const call=async(path:string,body?:any,account?:any,scope?:string,csrf?:string)=>{const r=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,...(account?{cookie:account.cookie,'x-csrf-token':csrf??account.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,data:await r.json()}};
 const login=async(secret:Uint8Array)=>{const challenge=(await call('challenge',{})).data;const r=await app.handle(new Request(origin+'/api/v1/login',{method:'POST',headers:{origin},body:JSON.stringify({challengeId:challenge.id,event:finalizeEvent(challenge.event,secret),identityType:'extension',name:'Fixture user'})}));const data=await r.json();return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf,member:data.member}};
 try{
  const admin=await login(key),participant=await login(generateSecretKey());const scope=app.workshop.id;
  expect((await call('site/builder-engine',undefined,participant)).status).toBe(403);expect((await call('host/builder-engine',{agent:'goose',expectedRevision:1},participant)).status).toBe(403);
  expect((await call('site/builder-engine',{agent:'goose',expectedRevision:1},admin,scope,'wrong')).status).toBe(403);
  for(const body of [{agent:'other',expectedRevision:1},{agent:'goose',expectedRevision:1,provider:'foreign'},{agent:'claude',expectedRevision:1,model:'foreign'}])expect((await call('site/builder-engine',body,admin)).status).toBe(400);
  const saved=await call('site/builder-engine',{agent:'goose',expectedRevision:1},admin);expect(saved.status).toBe(200);expect(saved.data.builderEngine.agent).toBe('goose');expect(saved.data.builderEngine.available).toBe(false);expect(saved.data.builderEngine.reason).toContain('awaits');
  expect((await call('site/builder-engine',{agent:'codex',expectedRevision:1},admin)).status).toBe(409);
  const other=(await call('site/workshops',{title:'Other',introduction:'Other'},admin)).data;expect((await call('site/builder-engine',{agent:'claude',expectedRevision:1},admin,other.id)).status).toBe(200);
  expect((await call('site/builder-engine',undefined,admin,scope)).data.builderEngine.agent).toBe('goose');
  app.db.close();app=application(config);expect((await call('site/builder-engine',undefined,admin,other.id)).data.builderEngine.agent).toBe('claude');expect((await call('site/builder-engine',undefined,admin,scope)).data.builderEngine.agent).toBe('goose');
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('an engine change after a pre-send failed binding rotates safely even before native ID becomes visible',async()=>{
 const f=fixture();try{
  f.save('first');let input:any;const transport={poll:async()=>{throw Error()},submit:async(x:any)=>{input=x;return {runId:x.requestId,receipt:{}}}};
  await dispatchReplacement(f.app.workshop,f.member,f.project.id,'first',f.config,transport);f.app.db.run("UPDATE requests SET status='failed',error='Verified pre-send failure' WHERE id='first'");
  f.choose('claude');f.save('next');await dispatchReplacement(f.app.workshop,f.member,f.project.id,'next',f.config,transport);expect(input.generation).toBe(1);expect(input.builderRuntime.agent).toBe('claude');
 }finally{f.close()}
});

test('legacy requests without engine snapshots retain original grant and unavailable runtimes do not submit',async()=>{
 const f=fixture();try{
  f.app.db.run('INSERT INTO requests(id,project_id,prompt,expected_revision,status,created_at,mode) VALUES(?,?,?,?,?,?,?)',['legacy',f.project.id,'old',f.project.current_revision,'queued',1,'answer']);
  let input:any;const old={...f.config,selectableBuilder:false};await dispatchReplacement(f.app.workshop,f.member,f.project.id,'legacy',{...f.config,receiptRecovery:old},{poll:async()=>{throw Error()},submit:async(x)=>{input=x;return {runId:'legacy',receipt:{}}}});
  expect(input.builderRuntime).toBeUndefined();expect(input.builderEngineRevision).toBeUndefined();expect(requestBuilderEngine(f.app.db,'legacy')).toBeUndefined();
  f.app.db.run("UPDATE requests SET status='succeeded'");f.choose('claude');f.save('new');
  const {runtimeAvailable}=await import('../src/pipeline/builder-runtime.ts');expect(runtimeAvailable({...f.config,selectableBuilder:false},requestBuilderEngine(f.app.db,'new')!.runtime)).toBe(false);
 }finally{f.close()}
});

test('configurable activation requires v70 pins and preserves exact older managed grants',async()=>{
 const {configurableBuilderConfiguration}=await import('../src/pipeline/configurable-configuration.ts'),{nip19}=await import('nostr-tools');
 const current:any={fileVersions:true,replacementEnabled:true,builderRoot:'/napplets',appPubkey:'a'.repeat(64),origin:'https://autopilot.test',callbackUrl:'https://app.test/api/v1/pipeline/message',definitionId:'codex',credentialFile:'/codex',nativeDeletion:{definitionId:'delete'}};
 const receipt={credentialFile:'/all-engines',grant:{expiresAt:Date.now()+3600000,definitionId:'v70',definitionHash:'d'.repeat(64),functionHashes:{'freedomtools.agentPublish.v70':'publish','freedomtools.followupPrepare.v70':'prepare'},appRoot:'/app',installationId:'installation',appNpub:nip19.npubEncode(current.appPubkey),origin:current.origin,callbackUrl:current.callbackUrl}};
 const next=configurableBuilderConfiguration(current,receipt,'/app','installation');expect(next.selectableBuilder).toBe(true);expect(next.builderRuntime).toBeUndefined();expect(next.receiptRecovery?.definitionId).toBe('codex');expect(next.nativeDeletion).toBeUndefined();
 expect(()=>configurableBuilderConfiguration(current,{...receipt,grant:{...receipt.grant,functionHashes:{'freedomtools.agentPublish.v70':'publish'}}},'/app','installation')).toThrow('pinned grant');
 const updated={...receipt,grant:{...receipt.grant,definitionId:'v71',functionHashes:{'freedomtools.agentPublish.v71':'publish','freedomtools.followupPrepare.v71':'prepare'}}};
 expect(configurableBuilderConfiguration(current,updated,'/app','installation',71).definitionId).toBe('v71');
 expect(()=>configurableBuilderConfiguration(current,updated,'/app','installation')).toThrow('pinned grant');
 expect(()=>configurableBuilderConfiguration(current,updated,'/app','installation',69)).toThrow('pinned grant');
 expect(()=>configurableBuilderConfiguration(current,{...updated,grant:{...updated.grant,definitionHash:''}},'/app','installation',71)).toThrow('pinned grant');
});

test('signed remote preparation rechecks live project and immutable runtime, rejects replay and forged installation',async()=>{
 const dir=mkdtempSync('/tmp/remote-prepare-'),owner='a'.repeat(64),appKey=generateSecretKey(),wrongKey=generateSecretKey();
 const config:any={dataDir:dir,hostPubkey:owner,origin:'https://test.example',version:'test'};
 const app=application(config);
 try{
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Admin','extension','admitted',40,1]);
  const member=app.auth.member(owner),project=app.workshop.create(member,'spinner').project,requestId=crypto.randomUUID();
  const builderRoot=dir+'/napplets';
  config.followup={projectId:project.id,ownerPubkey:owner,conversationKey:project.conversation_id,directory:builderRoot+'/'+app.workshop.id+'/'+project.id,builderRoot,workshopId:app.workshop.id,fileVersions:true,replacementEnabled:true,selectableBuilder:true,agentPublication:true};
  config.storage={installationId:crypto.randomUUID(),appPubkey:getPublicKey(appKey),appNpub:'npub',towerOrigin:'https://tower.example',workshopId:app.workshop.id,localRoot:'/data/napplets',pipeline:{}};
  app.db.run('INSERT INTO storage_binding(id,installation_id,workshop_id,target_json,local_root,status,connected_actor,namespace_json) VALUES(1,?,?,?,?,?,?,?)',[config.storage.installationId,app.workshop.id,'{}',config.storage.localRoot,'ready',owner,'{}']);
  app.workshop.request(member,project.id,{requestId,prompt:'Build a compact timer',mode:'build',expectedRevisionId:project.current_revision},true);
  const choice=requestBuilderEngine(app.db,requestId)!;
  const input:any={requestId,projectId:project.id,workshopId:app.workshop.id,ownerPubkey:owner,conversationKey:project.conversation_id,prompt:'Build a compact timer',mode:'build',source:'<!doctype html><title>Blank</title>',generation:0,nativeRequestId:requestId+':generation:0',contextHash:'b'.repeat(64),builderEngineRevision:choice.revision,builderRuntime:choice.runtime,replacementContext:{builderEngine:choice,fileBuild:{workshopId:app.workshop.id}}};
  app.db.run("UPDATE requests SET status='building' WHERE id=?",[requestId]);
  app.db.run('INSERT INTO request_recoveries(request_id,previous_run,execution_key,input_json) VALUES(?,?,?,?)',[requestId,'',input.nativeRequestId,JSON.stringify(input)]);
  const send=async(body:any,key:Uint8Array)=>{const raw=JSON.stringify(body),url=config.origin+'/api/v1/internal/builder/prepare';const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',sha256(raw)],['nonce',crypto.randomUUID()]]},key);return app.handle(new Request(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:raw}))};
  const accepted=await send(input,appKey);expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({scope:{projectId:project.id,ownerPubkey:owner,directory:builderRoot+'/'+app.workshop.id+'/'+project.id},runtime:{agent:'codex',revision:1},storageReady:true});
  const replacement={...input,generation:1,nativeRequestId:requestId+':generation:1',conversationKey:project.conversation_id+':generation:1'};app.db.run('UPDATE request_recoveries SET input_json=? WHERE request_id=?',[JSON.stringify(replacement),requestId]);const replacementAccepted=await send(replacement,appKey);expect(replacementAccepted.status).toBe(200);expect(await replacementAccepted.json()).toMatchObject({scope:{conversationKey:replacement.conversationKey}});
  // A new signature cannot make changed immutable request state authoritative.
  expect((await send({...input,prompt:'changed'},appKey)).status).not.toBe(200);
  expect((await send(input,wrongKey)).status).toBe(401);
  app.db.run('UPDATE members SET allowance=0 WHERE pubkey=?',[owner]);
  expect((await send(input,appKey)).status).not.toBe(200);
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});appKey.fill(0);wrongKey.fill(0)}
});
