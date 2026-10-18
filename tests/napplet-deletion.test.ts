import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {application} from '../src/application.ts';

const origin='https://napplet-delete.test';
let app:ReturnType<typeof application>,dir:string,adminKey:Uint8Array;
type Account={cookie:string;csrf:string;member:any};

async function call(path:string,body:any=undefined,account?:Account,scope='',method?:string){
  const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:method||(body===undefined?'GET':'POST'),headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,data:await response.json() as any};
}
async function login(key=generateSecretKey()):Promise<Account>{
  const challenge=(await call('challenge',{})).data,response=await app.handle(new Request(origin+'/api/v1/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension',name:'Deletion tester'})}));
  const data=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:data.csrf,member:data.member};
}
async function fixture(){
  const admin=await login(adminKey),owner=await login(),participant=await login();
  const canvas=(await call('site/workshops',{title:'Deletion Canvas',introduction:'Deletion tests',owner:owner.member.pubkey},admin)).data;
  await call('host/settings',{title:canvas.title,introduction:canvas.introduction,lightning:'',admission:'open',paused:false},owner,canvas.id);
  await call('workshops/join',{},owner,canvas.id);await call('workshops/join',{},participant,canvas.id);
  const project=(await call('projects',{starterId:'spinner'},owner,canvas.id)).data.project;
  await call('room',undefined,owner,canvas.id);
  return {admin,owner,participant,canvas,project};
}
const confirmation=(project:any)=>({confirmTitle:project.title,confirmPermanent:true,expectedRevisionId:project.current_revision});

beforeEach(()=>{dir=mkdtempSync('/tmp/freedom-napplet-delete-');adminKey=generateSecretKey();app=application({origin,hostPubkey:getPublicKey(adminKey),dataDir:dir,version:'napplet-delete-test'});});
afterEach(()=>{app.db.close();rmSync(dir,{recursive:true,force:true});});

test('Napplet deletion requires site-admin authority, exact Canvas scope, CSRF and exact current confirmation',async()=>{
  const {admin,owner,participant,canvas,project}=await fixture();
  const other=(await call('site/workshops',{title:'Other Canvas',introduction:'Other',owner:owner.member.pubkey},admin)).data;
  expect((await call(`projects/${project.id}`,confirmation(project),owner,canvas.id,'DELETE')).status).toBe(403);
  expect((await call(`projects/${project.id}`,confirmation(project),participant,canvas.id,'DELETE')).status).toBe(403);
  expect((await call(`projects/${project.id}`,confirmation(project),admin,other.id,'DELETE')).status).toBe(404);
  expect((await call(`projects/${crypto.randomUUID()}`,confirmation(project),admin,canvas.id,'DELETE')).status).toBe(404);
  expect((await call(`projects/${project.id}`,{...confirmation(project),confirmTitle:'wrong'},admin,canvas.id,'DELETE')).status).toBe(400);
  expect((await call(`projects/${project.id}`,{...confirmation(project),extra:true},admin,canvas.id,'DELETE')).status).toBe(400);
  expect((await call(`projects/${project.id}`,{...confirmation(project),expectedRevisionId:crypto.randomUUID()},admin,canvas.id,'DELETE')).status).toBe(409);
  expect((await call(`projects/${project.id}`,confirmation(project),{...admin,csrf:'wrong'},canvas.id,'DELETE')).status).toBe(403);
  expect(app.db.query('SELECT deleted_at FROM projects WHERE id=?').get(project.id)).toEqual({deleted_at:null});
});

test('successful deletion removes live access and local app data while retaining immutable and auditable history',async()=>{
  const {admin,owner,participant,canvas,project}=await fixture();
  const requestId=crypto.randomUUID();
  await call(`projects/${project.id}/requests`,{requestId,prompt:'A retained private request',expectedRevisionId:project.current_revision},owner,canvas.id);
  app.db.run('INSERT INTO napplet_user_data VALUES(?,?,?,?,?,?)',[canvas.id,project.id,participant.member.pubkey,'score','7',6]);
  app.db.run("INSERT INTO ippon_wallets(workshop_id,project_id,user_pubkey,state,operation_id,updated_at) VALUES(?,?,?,'uncertain','retained-audit',1)",[canvas.id,project.id,participant.member.pubkey]);
  app.db.run('INSERT INTO consent VALUES(?,?,?,?,?)',[project.id,project.current_revision,owner.member.pubkey,1,1]);
  app.db.run('UPDATE projects SET shared_revision=? WHERE id=?',[project.current_revision,project.id]);
  const beforeBoard=app.db.query('SELECT version,objects_json FROM workshop_boards WHERE workshop_id=?').get(canvas.id) as any;
  expect(JSON.parse(beforeBoard.objects_json).some((item:any)=>item.projectId===project.id)).toBe(true);

  const deleted=await call(`projects/${project.id}`,confirmation(project),admin,canvas.id,'DELETE');
  expect(deleted.status).toBe(200);expect(deleted.data).toMatchObject({deletedNappletId:project.id,localDataDeleted:1,boardObjectRemoved:true,externalArtifactsRetained:true,nativeLifecycleUnchanged:true});
  expect(app.db.query('SELECT hidden,shared_revision,deleted_by,deleted_at FROM projects WHERE id=?').get(project.id)).toMatchObject({hidden:1,shared_revision:null,deleted_by:admin.member.pubkey});
  expect(app.db.query('SELECT count(*) n FROM revisions WHERE project_id=?').get(project.id)).toEqual({n:1});
  expect(app.db.query('SELECT count(*) n FROM requests WHERE project_id=?').get(project.id)).toEqual({n:1});
  expect(app.db.query('SELECT count(*) n FROM request_builder_prompts WHERE request_id=?').get(requestId)).toEqual({n:1});
  expect(app.db.query('SELECT granted FROM consent WHERE project_id=?').get(project.id)).toEqual({granted:0});
  expect(app.db.query('SELECT count(*) n FROM napplet_user_data WHERE project_id=?').get(project.id)).toEqual({n:0});
  expect(app.db.query('SELECT state,operation_id FROM ippon_wallets WHERE project_id=?').get(project.id)).toEqual({state:'uncertain',operation_id:'retained-audit'});
  expect(app.db.query('SELECT excluded FROM hosted_publication_exclusions WHERE workshop_id=? AND project_id=?').get(canvas.id,project.id)).toEqual({excluded:1});
  const audit=app.db.query("SELECT actor,action,detail_json FROM project_admin_audit WHERE project_id=? AND action='delete'").get(project.id) as any;
  expect(audit.actor).toBe(admin.member.pubkey);expect(JSON.parse(audit.detail_json)).toEqual({localDataDeleted:1,boardObjectRemoved:true,externalArtifactsRetained:true,nativeLifecycleUnchanged:true});
  expect(JSON.parse((app.db.query('SELECT objects_json FROM workshop_boards WHERE workshop_id=?').get(canvas.id) as any).objects_json).some((item:any)=>item.projectId===project.id)).toBe(false);

  expect((await call('room',undefined,owner,canvas.id)).data.board.napplets.some((item:any)=>item.id===project.id)).toBe(false);
  expect((await call('host/people',undefined,owner,canvas.id)).data.projects.some((item:any)=>item.id===project.id)).toBe(false);
  expect((await call(`projects/${project.id}`,undefined,owner,canvas.id)).status).toBe(404);
  expect((await call(`projects/${project.id}/preview?revision=${project.current_revision}`,undefined,owner,canvas.id)).status).toBe(404);
  expect((await call(`projects/${project.id}`,confirmation(project),admin,canvas.id,'DELETE')).status).toBe(404);
  expect(app.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('active, uncertain and in-flight native lifecycle states block deletion without partial changes',async()=>{
  const {admin,canvas,project}=await fixture(),body=confirmation(project);
  const requestId=crypto.randomUUID();
  app.db.run("INSERT INTO requests(id,project_id,prompt,expected_revision,status,error,created_at,mode) VALUES(?,?,?,?, 'building',NULL,1,'auto')",[requestId,project.id,'active',project.current_revision]);
  expect((await call(`projects/${project.id}`,body,admin,canvas.id,'DELETE')).status).toBe(409);
  app.db.run("UPDATE requests SET status='failed' WHERE id=?",[requestId]);
  app.db.run("UPDATE builder_epochs SET state='deleting',reason='fixture' WHERE project_id=? AND generation=0",[project.id]);
  app.db.run("INSERT INTO builder_deletions(id,project_id,generation,input_json,status) VALUES(?,?,0,'{}','dispatch_pending')",[crypto.randomUUID(),project.id]);
  expect((await call(`projects/${project.id}`,body,admin,canvas.id,'DELETE')).status).toBe(409);
  app.db.run("UPDATE builder_deletions SET status='completed' WHERE project_id=?",[project.id]);app.db.run("UPDATE builder_epochs SET state='retired' WHERE project_id=?",[project.id]);
  const snapshotId=crypto.randomUUID();app.db.run('INSERT INTO publication_snapshots VALUES(?,?,?,?,?)',[snapshotId,admin.member.pubkey,JSON.stringify({workshopId:canvas.id,apps:[{projectId:project.id}]}),'publishing',1]);app.db.run('INSERT INTO publication_claims VALUES(?,?,?)',[snapshotId,crypto.randomUUID(),Date.now()+60_000]);
  expect((await call(`projects/${project.id}`,body,admin,canvas.id,'DELETE')).status).toBe(409);
  expect(app.db.query('SELECT deleted_at FROM projects WHERE id=?').get(project.id)).toEqual({deleted_at:null});
  expect(app.db.query("SELECT count(*) n FROM project_admin_audit WHERE project_id=? AND action='delete'").get(project.id)).toEqual({n:0});
});
