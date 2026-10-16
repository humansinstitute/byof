import {afterEach,beforeEach,expect,test} from 'bun:test';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {builderEpoch} from '../src/builder-lifecycle.ts';

const origin='https://workshop.test';
type Account={cookie:string;csrf:string;member:any;secret:Uint8Array};
let app:ReturnType<typeof application>,directory:string,adminSecret:Uint8Array;

async function call(path:string,body?:any,account?:Account){
  const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};
}
async function login(secret=generateSecretKey()):Promise<Account>{
  const challenge=(await call('challenge',{})).data,event=finalizeEvent(challenge.event,secret);
  const response=await app.handle(new Request(origin+'/api/v1/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challengeId:challenge.id,event,identityType:'extension',name:'Tester'})}));
  const data=await response.json();return {cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:data.csrf,member:data.member,secret};
}

beforeEach(async()=>{
  directory=mkdtempSync('/tmp/napplet-owner-actions-');adminSecret=generateSecretKey();app=application({dataDir:directory,hostPubkey:getPublicKey(adminSecret),origin,version:'test'});
  const admin=await login(adminSecret);await call('host/settings',{title:'Fork Canvas',introduction:'Test',lightning:'',paused:false,admission:'open'},admin);
});
afterEach(()=>{app.db.close();rmSync(directory,{recursive:true,force:true});});

test('rename and edit allow the owner and Canvas administrator with bounded, unique names and metadata-only updates',async()=>{
  const admin=await login(adminSecret),owner=await login(),other=await login();
  const source=(await call('projects',{starterId:'game'},owner)).data;
  const foreign=(await call('projects',{starterId:'todo'},other)).data;
  const path=`projects/${source.project.id}/rename`,before=await call(`projects/${source.project.id}`,undefined,owner);
  expect((await call(path,{title:'Not yours'},other)).status).toBe(404);
  expect((await call(path,{title:'Admin managed name'},admin)).status).toBe(200);
  expect((await call(`projects/${source.project.id}/edit`,undefined,other)).status).toBe(404);
  expect((await call(`projects/${source.project.id}/edit`,undefined,admin)).status).toBe(200);
  expect((await call(`projects/${source.project.id}/edit`,undefined,owner)).status).toBe(200);
  for(const title of ['', '   ', 'x'.repeat(121), 'two\nlines'])expect((await call(path,{title},owner)).status).toBe(400);
  expect((await call(path,{title:foreign.project.title.toUpperCase()},owner)).status).toBe(409);
  expect((await call(path,{title:'Only this Napplet changes'},owner)).status).toBe(200);
  const after=(await call(`projects/${source.project.id}`,undefined,owner)).data;
  expect((await call(`projects/${foreign.project.id}`,undefined,other)).data.project.title).toBe(foreign.project.title);
  for(const key of ['revisions','requests','consent','artifacts','builder'])expect(after[key]).toEqual(before.data[key]);
});

test('fork pins the latest saved revision, is idempotent, isolated and excludes private runtime and draft state',async()=>{
  const owner=await login(),forker=await login();
  const source=(await call('projects',{starterId:'game'},owner)).data.project;
  const firstRevision=source.current_revision,newHash=app.workshop.assets.put('<!doctype html><html><body>Latest saved</body></html>');
  const latest=app.workshop.addRevision(source,newHash,owner.member.pubkey);
  const requestId='private-source-request';app.workshop.request(app.auth.member(owner.member.pubkey),source.id,{requestId,prompt:'Unpublished private draft',expectedRevisionId:latest},false);
  const epoch=builderEpoch(app.workshop,app.workshop.project(app.auth.member(owner.member.pubkey),source.id,true));
  app.db.run('UPDATE builder_epochs SET native_id=?,sequence=? WHERE project_id=? AND generation=?',['private-native-session',7,source.id,epoch.generation]);
  app.db.run('INSERT INTO local_builds(request_id,project_id,directory,version,artifact_path,status,source_hash) VALUES(?,?,?,?,?,?,?)',[requestId,source.id,'/private/source',99,'/private/draft.html','draft','draft-secret-hash']);
  app.db.run('INSERT INTO napplet_user_data VALUES(?,?,?,?,?,?)',[app.workshop.id,source.id,owner.member.pubkey,'secret-setting',JSON.stringify('private'),9]);
  const sourceBefore={project:app.db.query('SELECT * FROM projects WHERE id=?').get(source.id),revisions:app.db.query('SELECT * FROM revisions WHERE project_id=? ORDER BY number').all(source.id),requests:app.db.query('SELECT * FROM requests WHERE project_id=?').all(source.id)};
  const body={forkProjectId:source.id,idempotencyKey:'same-click'};
  const [one,two]=await Promise.all([call('projects',body,forker),call('projects',body,forker)]);
  expect([one.status,two.status].sort()).toEqual([200,201]);
  expect(one.data.project.id).toBe(two.data.project.id);
  const fork=one.data,revision=fork.revisions[0];
  expect(fork.project).toMatchObject({owner:forker.member.pubkey,origin_project:source.id,origin_revision:latest,title:'Small game — fork'});
  expect(fork.project.id).not.toBe(source.id);expect(fork.project.conversation_id).not.toBe(source.conversation_id);
  expect(revision.source_hash).toBe(newHash);expect(revision.id).not.toBe(latest);expect(revision.source_hash).not.toBe((app.db.query('SELECT source_hash FROM revisions WHERE id=?').get(firstRevision) as any).source_hash);
  expect(fork.requests).toEqual([]);expect(fork.consent).toEqual([]);expect(fork.artifacts).toEqual([]);expect(fork.project.appVersionUrl).toBeNull();
  for(const table of ['requests','local_builds','napplet_user_data'])expect((app.db.query(`SELECT count(*) n FROM ${table} WHERE project_id=?`).get(fork.project.id) as any).n).toBe(0);
  expect(app.db.query('SELECT generation,state,native_id,sequence,conversation_key FROM builder_epochs WHERE project_id=?').get(fork.project.id)).toEqual({generation:0,state:'active',native_id:null,sequence:0,conversation_key:fork.project.conversation_id});
  expect({project:app.db.query('SELECT * FROM projects WHERE id=?').get(source.id),revisions:app.db.query('SELECT * FROM revisions WHERE project_id=? ORDER BY number').all(source.id),requests:app.db.query('SELECT * FROM requests WHERE project_id=?').all(source.id)}).toEqual(sourceBefore);
  const editable=await call(`projects/${fork.project.id}/edit`,undefined,forker);expect(editable.status).toBe(200);
  expect((await call(`projects/${fork.project.id}/rename`,{title:'Independent copy'},forker)).status).toBe(200);
  expect((await call(`projects/${source.id}`,undefined,owner)).data.project.title).toBe('Small game');
});

test('fork rejects missing or hidden sources without residue and a retry can recover cleanly',async()=>{
  const admin=await login(adminSecret),owner=await login(),forker=await login(),missing=crypto.randomUUID();
  expect((await call('projects',{forkProjectId:missing,idempotencyKey:'missing'},forker)).status).toBe(404);
  const source=(await call('projects',{starterId:'todo'},owner)).data.project;
  await call(`host/projects/${source.id}`,{hidden:true},admin);
  expect((await call('projects',{forkProjectId:source.id,idempotencyKey:'retryable'},forker)).status).toBe(404);
  expect((app.db.query('SELECT count(*) n FROM project_forks WHERE actor=?').get(forker.member.pubkey) as any).n).toBe(0);
  await call(`host/projects/${source.id}`,{hidden:false},admin);
  const recovered=await call('projects',{forkProjectId:source.id,idempotencyKey:'retryable'},forker);
  expect(recovered.status).toBe(201);expect(recovered.data.project.origin_revision).toBe(source.current_revision);
});
