import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {application} from '../src/application.ts';
import {projectRoute,projectConversation,trustedCreation} from '../src/project-routing.ts';
import {prepareTrustedFollowup} from '../src/pipeline/followup.ts';
import {dispatchFollowup} from '../src/pipeline/followup-dispatch.ts';
import {ensureBuilderDirectory,seedBuilderSource} from '../src/pipeline/project-directory.ts';
import {storeDelivery} from '../src/delivery-store.ts';
import {sha256} from '../src/assets.ts';
import type {FollowupConfig} from '../src/config.ts';
test('successive trusted projects bootstrap generation0 independently; immutable duplicate and owner routing',async()=>{
 const dir=mkdtempSync('/private/tmp/byo-projects-'),owner='a'.repeat(64);
 const app=application({dataDir:dir,hostPubkey:null,origin:null,version:'test'});
 try {
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Pete','temporary','admitted',20,1]);
  const member=app.auth.member(owner),original=app.workshop.create(member,'dice').project;
  const config={ownerPubkey:owner,projectId:original.id,conversationKey:original.conversation_id,directory:dir+'/original',builderRoot:dir+'/builders',replacementEnabled:true} as FollowupConfig;
  expect(projectRoute(original,config)).toBe(config);
  const scope={ownerPubkey:owner,builderRoot:config.builderRoot!,legacy:{ownerPubkey:owner,projectId:original.id,conversationKey:original.conversation_id,directory:config.directory!}};
  expect(()=>app.workshop.create(member,'spinner')).toThrow('existing');
  const projects=[app.workshop.create(member,'spinner',undefined,trustedCreation(owner,config)).project,app.workshop.create(member,'dice',undefined,trustedCreation(owner,config)).project];
  const inputs:any[]=[];
  for(const p of projects){
   const id=crypto.randomUUID();app.workshop.request(member,p.id,{requestId:id,prompt:'Build a game\n',expectedRevisionId:p.current_revision,mode:'build'},true);
   const submit=async(input:any)=>{inputs.push(input);return {runId:'run-'+id,receipt:{}};};
   await dispatchFollowup(app.workshop,member,p.id,id,config,submit);
   await dispatchFollowup(app.workshop,member,p.id,id,config,submit);
   const input=inputs.at(-1),route=projectRoute(p,config)!;
   expect(input.generation).toBe(0);expect(input.conversationKey).toBe(projectConversation(owner,p.id));
   expect(input.replacementContext.latestPrompt.content).toBe('Build a game\n');
   expect(input.replacementContext.messages).toHaveLength(1);expect(input.replacementContext.workingDirectory).toBe(dir+'/builders/'+owner+'/'+p.id);
   expect(prepareTrustedFollowup(input,scope).directory).toBe(route.directory!);
   for(const changed of [{ownerPubkey:'b'.repeat(64)},{projectId:original.id},{conversationKey:original.conversation_id},{projectId:'../escape'}])expect(()=>prepareTrustedFollowup({...input,...changed},scope)).toThrow();
   const changed={...input.replacementContext,workingDirectory:dir+'/foreign'};
   expect(()=>prepareTrustedFollowup({...input,replacementContext:changed,contextHash:sha256(JSON.stringify(changed))},scope)).toThrow();
  }
  const p=projects[0],first=inputs[0];
  const receipt={generation:0,nativeRequestId:first.nativeRequestId,contextHash:first.contextHash,requestId:first.requestId,projectId:p.id,conversationKey:first.conversationKey,receiptId:'native-receipt',nativeSessionId:'native-first',sessionId:'session-first',sequence:1,invocationRunId:'run-'+first.requestId};
  const delivery={eventId:'event',attempt:1,bodyHash:'hash',envelope:{runId:'run-'+first.requestId,deliveryId:'delivery',status:'ok',terminal:true as const,error:null,result:{requestId:first.requestId,projectId:p.id,action:'build_completed',banRequired:false,response:'Ready',source:'<!doctype html><html><body>Game</body></html>',nativeReceipt:receipt}}};
  expect(storeDelivery(app.db,delivery,app.workshop)).toBe('applied');expect(storeDelivery(app.db,{...delivery,eventId:'retry'},app.workshop)).toBe('duplicate');
  expect(app.auth.member(owner).allowance).toBe(19);
  const after=app.workshop.detail(member,p.id);expect(after.revisions).toHaveLength(2);expect(after.builder.generation).toBe(0);expect(after.builder.native_id).toBe('native-first');
  const nextId=crypto.randomUUID();app.workshop.request(app.auth.member(owner),p.id,{requestId:nextId,prompt:'Change color\n',expectedRevisionId:after.project.current_revision,mode:'build'},true);
  let next:any;await dispatchFollowup(app.workshop,member,p.id,nextId,config,async input=>{next=input;return {runId:'next-run',receipt:{}};});
  expect(next.generation).toBe(0);expect(next.conversationKey).toBe(first.conversationKey);expect(next.replacementContext.messages.map((m:any)=>m.role)).toEqual(['user','assistant','user']);expect(next.replacementContext.currentSource).toContain('Game');
  const nextDelivery={...delivery,eventId:'next-event',bodyHash:'next-hash',envelope:{...delivery.envelope,runId:'next-run',deliveryId:'next-delivery',result:{...delivery.envelope.result,requestId:nextId,nativeReceipt:{...receipt,requestId:nextId,nativeRequestId:next.nativeRequestId,contextHash:next.contextHash,invocationRunId:'next-run',receiptId:'next-native',sequence:2}}}};
  expect(()=>storeDelivery(app.db,{...nextDelivery,envelope:{...nextDelivery.envelope,result:{...nextDelivery.envelope.result,nativeReceipt:{...nextDelivery.envelope.result.nativeReceipt,nativeSessionId:'foreign'}}}},app.workshop)).toThrow();
  expect(storeDelivery(app.db,nextDelivery,app.workshop)).toBe('applied');expect(app.workshop.detail(member,p.id).builder.sequence).toBe(2);expect(app.auth.member(owner).allowance).toBe(18);
  expect(inputs).toHaveLength(2);expect(inputs[0].conversationKey).not.toBe(inputs[1].conversationKey);
  expect(trustedCreation('b'.repeat(64),config)).toBe(false);
  expect(projectRoute({...projects[0],conversation_id:projects[1].conversation_id},config)).toBeUndefined();
  expect(projectRoute({...projects[0],owner:'b'.repeat(64)},config)).toBeUndefined();
  expect(app.workshop.detail(member,original.id).revisions).toHaveLength(1);
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('derived cwd refuses symlink and noncanonical paths',()=>{
 const dir=mkdtempSync('/private/tmp/byo-cwd-');try{ensureBuilderDirectory(dir+'/owner/project');symlinkSync(dir+'/owner',dir+'/alias');expect(()=>ensureBuilderDirectory(dir+'/alias/project')).toThrow('denied');expect(()=>ensureBuilderDirectory(dir+'/../escape')).toThrow('denied');}finally{rmSync(dir,{recursive:true,force:true});}
});

test('explicit additional verified owner scope routes separately without granting foreign ownership',()=>{
 const first='a'.repeat(64),second='b'.repeat(64),id='12345678-1234-1234-1234-123456789abc';
 const legacy={ownerPubkey:second,projectId:id,conversationKey:'original-second',directory:'/fixed/second',builderRoot:'/fixed/new'} as any;
 const config={ownerPubkey:first,projectId:'original',conversationKey:'first',additionalScopes:[legacy]} as any;
 expect(trustedCreation(second,config)).toBe(true);
 expect(projectRoute({id,owner:second,conversation_id:'original-second'},config)?.directory).toBe('/fixed/second');
 expect(projectRoute({id,owner:first,conversation_id:'original-second'},config)).toBeUndefined();
 expect(projectRoute({id,owner:'c'.repeat(64),conversation_id:'original-second'},config)).toBeUndefined();
 expect(projectRoute({id,owner:second,conversation_id:projectConversation(second,id)},config)?.initialContext).toBe(true);
 expect(projectRoute({id,owner:second,conversation_id:'first'},config)).toBeUndefined();
});

test('authoritative page refresh preserves supporting builder data and refuses symlink writes',()=>{
 const dir=mkdtempSync('/private/tmp/byo-source-');try{
  seedBuilderSource(dir+'/project','<html>Original</html>');
  writeFileSync(dir+'/project/data.json','public data');
  seedBuilderSource(dir+'/project','<html>Revision 2</html>');
  expect(readFileSync(dir+'/project/index.html','utf8')).toContain('Revision 2');
  expect(readFileSync(dir+'/project/data.json','utf8')).toBe('public data');
  writeFileSync(dir+'/foreign','untouched');rmSync(dir+'/project/index.html');symlinkSync(dir+'/foreign',dir+'/project/index.html');
  expect(()=>seedBuilderSource(dir+'/project','overwrite')).toThrow('denied');
  expect(readFileSync(dir+'/foreign','utf8')).toBe('untouched');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
