import {expect,test} from 'bun:test';
import {generateSecretKey,getPublicKey} from 'nostr-tools';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {dispatchReplacement} from '../src/pipeline/replacement-dispatch.ts';

function fixture(mode:'answer'|'build',agentPublication=true){
  const dir=mkdtempSync('/tmp/publication-preflight-'),app=application({dataDir:dir,hostPubkey:null,origin:'https://test',version:'test'}),owner=getPublicKey(generateSecretKey());
  app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[owner,'Owner','temporary','admitted',20,1]);
  const member=app.auth.member(owner),project=app.workshop.create(member,'dice').project;
  app.workshop.request(member,project.id,{requestId:'request',prompt:'Change the app',mode,expectedRevisionId:project.current_revision},true);
  const config:any={projectId:project.id,ownerPubkey:owner,conversationKey:project.conversation_id,directory:dir+'/projects/'+app.workshop.id+'/'+project.id,
    builderRoot:dir+'/projects',workshopId:app.workshop.id,fileVersions:true,replacementEnabled:true,initialContext:true,agentPublication,
    definitionId:'definition',callbackUrl:'https://test/api/v1/pipeline/message'};
  mkdirSync(config.directory,{recursive:true});
  return {app,member,project,config,close(){app.db.close();rmSync(dir,{recursive:true,force:true})}};
}

test('a fresh implementation does not run when scoped publication preflight is unavailable',async()=>{
  for(const response of [{protocol:'native-project-tools-v1',publicationTool:'napplet.publish',ready:false},new Error('preflight offline')]){
    const f=fixture('build');let submits=0,preflights=0;
    try{
      const transport:any={poll:async()=>({}),submit:async()=>{submits++;return {runId:'forbidden',receipt:{}}},publicationPreflight:async()=>{preflights++;if(response instanceof Error)throw response;return {response}}};
      const result:any=await dispatchReplacement(f.app.workshop,f.member,f.project.id,'request',f.config,transport);
      expect(result.status).toBe('unavailable');expect(result.run_id).toBeNull();expect(result.error).toContain('publication authority');expect(preflights).toBe(1);expect(submits).toBe(0);
    }finally{f.close()}
  }
});

test('answer-only turns skip publication preflight and missing publication installation blocks builds before any agent runs',async()=>{
  const answer=fixture('answer');let answerPreflights=0;
  try{
    const transport:any={poll:async()=>({}),publicationPreflight:async()=>{answerPreflights++;throw Error('must not run')},submit:async()=>({runId:'answer-run',receipt:{}})};
    const result:any=await dispatchReplacement(answer.app.workshop,answer.member,answer.project.id,'request',answer.config,transport);
    expect(answerPreflights).toBe(0);expect(result.error||'').not.toContain('publication authority');
  }finally{answer.close()}
  const build=fixture('build',false);let buildSubmits=0;
  try{
    const result:any=await dispatchReplacement(build.app.workshop,build.member,build.project.id,'request',build.config,{poll:async()=>({}),publicationPreflight:async()=>{throw Error('must not run without configured publication')},submit:async()=>{buildSubmits++;return {runId:'forbidden',receipt:{}}}} as any);
    expect(result.status).toBe('unavailable');expect(result.error).toContain('not installed');expect(buildSubmits).toBe(0);
  }finally{build.close()}
});
