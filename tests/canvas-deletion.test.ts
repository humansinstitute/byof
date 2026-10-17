import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {application} from '../src/application.ts';

const origin='https://canvas-delete.test';
let app:ReturnType<typeof application>,dir:string,hostKey:Uint8Array;
type Account={cookie:string;csrf:string;member:any};

async function call(path:string,body:any=undefined,account?:Account,scope='',method?:string){
  const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:method||(body===undefined?'GET':'POST'),headers:{origin,...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,data:await response.json() as any};
}
async function login(key=generateSecretKey()):Promise<Account>{
  const challenge=(await call('challenge',{})).data,response=await app.handle(new Request(origin+'/api/v1/login',{method:'POST',headers:{origin},body:JSON.stringify({challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension',name:'Deletion tester'})}));
  const data=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0]!,csrf:data.csrf,member:data.member};
}
async function createCanvas(admin:Account,title:string,owner:string){return(await call('site/workshops',{title,introduction:title+' introduction',owner},admin)).data;}
async function seedProject(admin:Account,user:Account,canvas:any,starterId='todo'){
  await call('host/settings',{title:canvas.title,introduction:canvas.introduction,lightning:'',admission:'open',paused:false},admin,canvas.id);
  await call('workshops/join',{},user,canvas.id);
  const created=(await call('projects',{starterId},user,canvas.id)).data.project;
  await call(`projects/${created.id}/requests`,{requestId:'request-'+created.id,prompt:'Keep this request scoped',expectedRevisionId:created.current_revision},user,canvas.id);
  return created;
}

beforeEach(()=>{dir=mkdtempSync('/tmp/freedom-canvas-delete-');hostKey=generateSecretKey();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'canvas-delete-test'});});
afterEach(()=>{app.db.close();rmSync(dir,{recursive:true,force:true});});

test('only the owner or site admin can delete a non-legacy Canvas with exact confirmation',async()=>{
  const admin=await login(hostKey),owner=await login(),participant=await login(),canvas=await createCanvas(admin,'Owned Canvas',owner.member.pubkey);
  await call('host/settings',{title:canvas.title,introduction:canvas.introduction,lightning:'',admission:'open',paused:false},owner,canvas.id);
  await call('workshops/join',{},participant,canvas.id);
  expect((await call(`workshops/${canvas.id}`,{confirmText:'CONFIRM',confirmPermanent:true},participant,canvas.id,'DELETE')).status).toBe(403);
  expect((await call(`workshops/${canvas.id}`,{confirmText:'confirm',confirmPermanent:true},owner,canvas.id,'DELETE')).status).toBe(400);
  expect((await call(`workshops/${canvas.id}`,{confirmTitle:canvas.title,confirmPermanent:true},owner,canvas.id,'DELETE')).status).toBe(400);
  const wrongCsrf={...owner,csrf:'wrong'};
  expect((await call(`workshops/${canvas.id}`,{confirmText:'CONFIRM',confirmPermanent:true},wrongCsrf,canvas.id,'DELETE')).status).toBe(403);
  const deleted=await call(`workshops/${canvas.id}`,{confirmText:'CONFIRM',confirmPermanent:true},owner,canvas.id,'DELETE');
  expect(deleted.status).toBe(200);expect(deleted.data).toMatchObject({deletedCanvasId:canvas.id,externalDataRetained:true});
  expect(app.db.query('SELECT id FROM workshops WHERE id=?').get(canvas.id)).toBeNull();
});

test('Canvas deletion removes the complete local graph and leaves another Canvas untouched',async()=>{
  const admin=await login(hostKey),owner=await login(),user=await login(),canvas=await createCanvas(admin,'Delete me',owner.member.pubkey),other=await createCanvas(admin,'Keep me',owner.member.pubkey);
  const project=await seedProject(owner,user,canvas),otherProject=await seedProject(owner,user,other,'game'),requestId='request-'+project.id;
  app.db.run('INSERT INTO canvas_create_intents VALUES(?,?,?,?)',[admin.member.pubkey,crypto.randomUUID(),'{}',canvas.id]);
  app.db.run('INSERT INTO workshop_board_images VALUES(?,?,?,?,?)',[canvas.id,'a'.repeat(64),'image/png',10,10]);
  app.db.run('INSERT INTO napplet_user_data VALUES(?,?,?,?,?,?)',[canvas.id,project.id,user.member.pubkey,'score','1',1]);
  app.db.run('INSERT INTO publication_snapshots VALUES(?,?,?,?,?)',[crypto.randomUUID(),owner.member.pubkey,JSON.stringify({workshopId:canvas.id,apps:[]}), 'prepared',1]);
  app.db.run('INSERT INTO project_admin_audit VALUES(?,?,?,?,?,?,?,?)',[crypto.randomUUID(),canvas.id,project.id,user.member.pubkey,owner.member.pubkey,'fixture','{}',1]);
  expect((await call(`workshops/${canvas.id}`,{confirmText:'CONFIRM',confirmPermanent:true},admin,canvas.id,'DELETE')).status).toBe(200);
  for(const [table,column,value] of [
    ['workshops','id',canvas.id],['workshop_members','workshop_id',canvas.id],['workshop_prompts','workshop_id',canvas.id],['workshop_boards','workshop_id',canvas.id],['workshop_board_images','workshop_id',canvas.id],['canvas_create_intents','workshop_id',canvas.id],['napplet_user_data','workshop_id',canvas.id],['projects','workshop_id',canvas.id],['revisions','project_id',project.id],['requests','id',requestId],['project_admin_audit','workshop_id',canvas.id]
  ] as const)expect(app.db.query(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(value)).toEqual({n:0});
  expect(app.db.query("SELECT count(*) n FROM publication_snapshots WHERE json_extract(body_json,'$.workshopId')=?").get(canvas.id)).toEqual({n:0});
  expect(app.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(app.db.query('SELECT title FROM workshops WHERE id=?').get(other.id)).toEqual({title:'Keep me'});
  expect(app.db.query('SELECT id FROM projects WHERE id=?').get(otherProject.id)).toEqual({id:otherProject.id});
  expect((await call('room',undefined,user,other.id)).status).toBe(200);
});

test('the default Canvas is preserved and a failed final delete rolls back every dependent change',async()=>{
  const admin=await login(hostKey),owner=await login(),user=await login(),legacy=app.site.legacy();
  const legacyRow=app.db.query('SELECT title FROM workshops WHERE id=?').get(legacy) as any;
  expect((await call(`workshops/${legacy}`,{confirmText:'CONFIRM',confirmPermanent:true},admin,legacy,'DELETE')).status).toBe(409);

  const canvas=await createCanvas(admin,'Atomic Canvas',owner.member.pubkey),project=await seedProject(owner,user,canvas);
  const before={projects:app.db.query('SELECT count(*) n FROM projects WHERE workshop_id=?').get(canvas.id),requests:app.db.query('SELECT count(*) n FROM requests WHERE project_id=?').get(project.id)};
  app.db.exec(`CREATE TRIGGER fail_canvas_delete BEFORE DELETE ON workshops WHEN OLD.id='${canvas.id}' BEGIN SELECT RAISE(ABORT,'fixture final delete failure'); END;`);
  expect((await call(`workshops/${canvas.id}`,{confirmText:'CONFIRM',confirmPermanent:true},owner,canvas.id,'DELETE')).status).toBe(500);
  expect(app.db.query('SELECT count(*) n FROM projects WHERE workshop_id=?').get(canvas.id)).toEqual(before.projects);
  expect(app.db.query('SELECT count(*) n FROM requests WHERE project_id=?').get(project.id)).toEqual(before.requests);
  expect(app.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='revision_no_delete'").get()).toEqual({name:'revision_no_delete'});
  expect((await call('room',undefined,user,canvas.id)).status).toBe(200);
});
