import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,chmodSync} from 'node:fs';
import {application} from '../src/application.ts';
import {dispatchFollowup} from '../src/pipeline/followup-dispatch.ts';
import {prepareTrustedFollowup,followupCandidate} from '../src/pipeline/followup.ts';
import {storeDelivery} from '../src/delivery-store.ts';
import {refreshProjectGuidance,localTurnPrompt} from '../src/local-builds.ts';
import {copyProjectFiles} from '../src/project-migration.ts';
import {sha256} from '../src/assets.ts';
import {projectRoute} from '../src/project-routing.ts';
import {nappletExecutionContract} from '../src/builder-prompt.ts';
test('Goose GLM turns forbid image-producing tools while other runtimes retain general validation guidance',()=>{
 const base:any={requestId:'request',projectId:'project',contextHash:'hash',mode:'build',prompt:'Build it',builderPrompt:{revision:2,text:'Guidance',agentName:'Agent 21'},replacementContext:{workingDirectory:'/project',currentRevision:'revision',sourceHash:'hash',fileBuild:{currentCompletedVersion:0,version:1,artifactPath:'.drafts/x/v1/index.html'},builderEngine:{runtime:{agent:'goose',provider:'openrouter',model:'z-ai/glm-5.3'}}}};
 const goose=localTurnPrompt(base);expect(goose).toContain('text-only z-ai/glm-5.3');expect(goose).toContain('Never call computer-controller, screenshot, image-capture, vision');
 const codex=localTurnPrompt({...base,replacementContext:{...base.replacementContext,builderEngine:{runtime:{agent:'codex',provider:'configured',model:null}}}});expect(codex).not.toContain('text-only z-ai/glm-5.3');expect(codex).toContain('Use runtime-supported validation tools');
});
test('real files: immutable versions, answers, duplicate completion, failed draft reuse, scoped paths and replacement history',async()=>{
 const dir=mkdtempSync('/private/tmp/byo-files-'),owner='a'.repeat(64),app=application({dataDir:dir,hostPubkey:null,origin:null,version:'test'});
 try{
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Builder','temporary','admitted',20,1]);
  const member=app.auth.member(owner),p=app.workshop.create(member,'blank').project;
  const cfg:any={ownerPubkey:owner,projectId:p.id,conversationKey:p.conversation_id,builderRoot:dir+'/napplets',workshopId:p.workshop_id,fileVersions:true,replacementEnabled:true};
  const scope={ownerPubkey:owner,builderRoot:cfg.builderRoot,workshopId:p.workshop_id,fileVersions:true,legacy:{ownerPubkey:owner,projectId:p.id,conversationKey:p.conversation_id,directory:'/old'}};
  const folder=projectRoute(p,cfg)!.directory!;expect(folder).toBe(`${dir}/napplets/${p.workshop_id}/${p.id}`);
  expect(projectRoute({...p,workshop_id:crypto.randomUUID()},cfg)).toBeUndefined();
  let sequence=0;
  async function turn(kind:'answer'|'build',valid=true){
   const id=crypto.randomUUID(),project=app.workshop.project(member,p.id);
   app.workshop.request(member,p.id,{requestId:id,prompt:kind,expectedRevisionId:project.current_revision,mode:'auto'},true);
   let input:any;await dispatchFollowup(app.workshop,member,p.id,id,cfg,async v=>{input=v;return {runId:id,receipt:{}};});
   const prepared=prepareTrustedFollowup(input,scope);
   expect(prepared.prompt).toContain(nappletExecutionContract);
   // Keep routing compact while allowing the newly documented runtime API.
   expect(prepared.prompt.replace(nappletExecutionContract,'').length).toBeLessThan(2400);
   expect(JSON.parse(readFileSync(folder+'/.context/requests/'+input.contextHash+'.json','utf8')).latestPrompt.requestId).toBe(id);
   const b=input.replacementContext.fileBuild;
   if(kind==='build')writeFileSync(folder+'/'+b.artifactPath,valid?`<html><body>Build ${sequence}</body></html>`:'invalid');
   const reply=kind==='answer'?{kind,response:'Answer only'}:{kind,response:'Built',...b,validation:['Loaded and exercised fixture controls']};
   const candidate=followupCandidate({...input,fileBuild:b,turn:{status:'completed',requestId:input.nativeRequestId,projectId:p.id,conversationKey:input.conversationKey,nativeSessionId:'native',sessionId:'session',receiptId:id,invocationRunId:id,sequence:++sequence,reply:JSON.stringify(reply)}});
   const d={eventId:id,attempt:1,bodyHash:id,envelope:{runId:id,deliveryId:id,status:'ok',terminal:true as const,error:null,result:{requestId:id,projectId:p.id,...candidate}}};
   expect(storeDelivery(app.db,d,app.workshop)).toBe('applied');expect(storeDelivery(app.db,{...d,eventId:id+'retry'},app.workshop)).toBe('duplicate');
   return {input,b,id};
  }
  const one=await turn('build');
  writeFileSync(folder+'/tmp/notes.md','Persistent research notes');writeFileSync(folder+'/tmp/datamodel.md','Persistent data model');writeFileSync(folder+'/tmp/experiment.txt','exploratory design');expect(one.b.version).toBe(1);const first=readFileSync(folder+'/v1/index.html');
  const two=await turn('build');expect(two.b.version).toBe(2);expect(sha256(readFileSync(folder+'/v1/index.html'))).toBe(sha256(first));
  const revisions=app.workshop.detail(member,p.id).revisions.length;const q=await turn('answer');expect(q.b.version).toBe(3);expect(app.workshop.detail(member,p.id).revisions).toHaveLength(revisions);
  const failed=await turn('build',false);expect(failed.b.version).toBe(3);expect((app.db.query('SELECT status FROM requests WHERE id=?').get(failed.id) as any).status).toBe('failed');
  const three=await turn('build');expect(three.b.version).toBe(3);
  expect(three.input.replacementContext.messages.filter((m:any)=>m.role==='assistant').length).toBe(4);
  expect(app.auth.member(owner).allowance).toBe(17);
  expect(readFileSync(folder+'/tmp/notes.md','utf8')).toBe('Persistent research notes');
  expect(readFileSync(folder+'/tmp/datamodel.md','utf8')).toBe('Persistent data model');
  expect(readFileSync(folder+'/tmp/experiment.txt','utf8')).toBe('exploratory design');
  expect(readFileSync(folder+'/.agents/skills/napplet-build/SKILL.md','utf8')).toBe(readFileSync(new URL('../templates/napplet-build/SKILL.md',import.meta.url),'utf8'));
  const receipt=JSON.parse((app.db.query('SELECT receipt_json FROM build_receipts WHERE request_id=?').get(two.id) as any).receipt_json);
  expect(receipt.artifact.sha256).toBe(sha256(readFileSync(folder+'/v2/index.html')));expect(receipt.artifact.url).toContain('/preview?revision=');
  chmodSync(folder+'/v1/index.html',0o600);writeFileSync(folder+'/v1/index.html','<html>tampered</html>');
  const tampered=await turn('build');expect((app.db.query('SELECT status FROM requests WHERE id=?').get(tampered.id) as any).status).toBe('failed');
  writeFileSync(folder+'/v1/index.html',first);chmodSync(folder+'/v1/index.html',0o400);
  writeFileSync(folder+'/notes.txt','keep');writeFileSync(folder+'/AGENTS.md',readFileSync(folder+'/AGENTS.md','utf8')+'\nLocal notes');
  refreshProjectGuidance(folder,{revision:9,text:'Updated saved prompt'});expect(readFileSync(folder+'/AGENTS.md','utf8')).toContain('revision 9');expect(readFileSync(folder+'/AGENTS.md','utf8')).toContain('Local notes');expect(readFileSync(folder+'/notes.txt','utf8')).toBe('keep');
  rmSync(folder+'/AGENTS.md');symlinkSync(folder+'/notes.txt',folder+'/AGENTS.md');expect(()=>refreshProjectGuidance(folder,{revision:10,text:'Unsafe'})).toThrow();expect(readFileSync(folder+'/notes.txt','utf8')).toBe('keep');
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('migration copies exact supporting files idempotently and refuses conflicts, preserving old data',()=>{
 const dir=mkdtempSync('/private/tmp/byo-migration-');try{
  writeFileSync(dir+'/old','unused');rmSync(dir+'/old');
  copyProjectFiles(dir+'/source',dir+'/target');writeFileSync(dir+'/source/data.json','public source');
  expect(copyProjectFiles(dir+'/source',dir+'/target')).toHaveLength(1);expect(copyProjectFiles(dir+'/source',dir+'/target')).toHaveLength(1);
  writeFileSync(dir+'/target/data.json','different');expect(()=>copyProjectFiles(dir+'/source',dir+'/target')).toThrow('conflict');expect(readFileSync(dir+'/source/data.json','utf8')).toBe('public source');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
