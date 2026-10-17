import {afterEach,beforeEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {application} from '../src/application.ts';
import {canonicalPublicName,HostedPublication,randomPublicName,reservedPublicNames} from '../src/hosted-publication.ts';

const origin='https://public.test';
let app:ReturnType<typeof application>,directory:string,hostKey:Uint8Array;
type Account={cookie:string;csrf:string;member:any};
async function request(path:string,account?:Account,body?:any,headers:Record<string,string>={}){
 const response=await app.handle(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{origin,'content-type':'application/json'}),...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const text=await response.text();return {status:response.status,headers:response.headers,text,data:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};
}
async function login(key=generateSecretKey(),name='Visitor'):Promise<Account>{const challenge=(await request('/api/v1/challenge',undefined,{})).data,result=await request('/api/v1/login',undefined,{challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension',name});return {cookie:result.headers.get('set-cookie')!.split(';')[0]!,csrf:result.data.csrf,member:result.data.member};}
beforeEach(()=>{directory=mkdtempSync('/tmp/freedom-hosted-publication-');hostKey=generateSecretKey();app=application({origin,dataDir:directory,hostPubkey:getPublicKey(hostKey),version:'hosted-test'});});
afterEach(()=>{app.db.close();rmSync(directory,{recursive:true,force:true});});

test('three-word names are canonical, readable, reserved-safe and collision-safe',async()=>{
 expect(randomPublicName(()=>0)).toBe('amber-badger-bay');expect(randomPublicName(()=>.999999)).toBe('wild-wren-wood');
 expect(canonicalPublicName('  Community-Garden  ')).toBe('community-garden');
 for(const name of [...reservedPublicNames,'UP PER','two--dashes','-edge','edge-','xy'])expect(()=>canonicalPublicName(name)).toThrow();
 const host=await login(hostKey,'Host'),member=app.workshop.scoped(app.auth.member(host.member.pubkey));app.workshop.create(member,'dice');
 const first=new HostedPublication(app.db,app.workshop).publish(member,{},()=>0);expect(first.alias).toBe('amber-badger-bay');
 const other=(await request('/api/v1/site/workshops',host,{title:'Other Canvas',introduction:'Other'})).data;
 const otherId=other.id||other.workshop?.id|| (await request('/api/v1/workshops',host)).data.workshops.find((w:any)=>w.title==='Other Canvas').id;
 const scoped=new (await import('../src/workshop.ts')).Workshop(app.db,app.workshop.assets,otherId),owner=scoped.scoped(app.auth.member(host.member.pubkey));scoped.create(owner,'dice');
 let calls=0;const second=new HostedPublication(app.db,scoped).publish(owner,{},()=>calls++?0.06:0);expect(second.alias).not.toBe(first.alias);expect(second.alias.split('-')).toHaveLength(3);
});

test('hosts publish active current revisions without owner consent; only site admins choose names',async()=>{
 const admin=await login(hostKey,'Admin'),owner=await login(generateSecretKey(),'Canvas owner');
 const created=(await request('/api/v1/site/workshops',admin,{title:'Community Canvas',introduction:'Public by setup',owner:owner.member.pubkey})).data;
 const workshopId=created.id||created.workshop?.id||(await request('/api/v1/workshops',admin)).data.workshops.find((w:any)=>w.title==='Community Canvas').id;
 await request('/api/v1/workshops/join',owner,{}, {'x-workshop-id':workshopId});
 const project=(await request('/api/v1/projects',owner,{starterId:'dice'},{'x-workshop-id':workshopId})).data.project;
 expect(app.db.query('SELECT * FROM consent WHERE project_id=?').all(project.id)).toEqual([]);
 const ordinary=await request('/api/v1/host/hosted-publication',owner,{name:'vanity-name',expectedVersion:0},{'x-workshop-id':workshopId});expect(ordinary.status).toBe(403);
 const published=await request('/api/v1/host/hosted-publication',owner,{expectedVersion:0},{'x-workshop-id':workshopId});expect(published.status).toBe(201);expect(published.data.alias.split('-')).toHaveLength(3);expect(published.data.snapshot.napplets[0]).toMatchObject({projectId:project.id,revisionId:project.current_revision});
 const custom=await request('/api/v1/host/hosted-publication',admin,{name:'community-garden',expectedVersion:1},{'x-workshop-id':workshopId});expect(custom.status).toBe(201);expect(custom.data.alias).toBe('community-garden');
 const conflict=await request('/api/v1/host/hosted-publication',admin,{name:'api',expectedVersion:2},{'x-workshop-id':workshopId});expect(conflict.status).toBe(409);
 expect((await request('/p/community-garden')).status).toBe(200);expect(app.site.deleteCanvas(app.auth.member(owner.member.pubkey),workshopId,{confirmPermanent:true,confirmText:'CONFIRM'}).deletedCanvasId).toBe(workshopId);expect((await request('/p/community-garden')).status).toBe(404);
});

test('republish is stable and idempotent while exclusion updates the current public export without deleting private Canvas state',async()=>{
 const host=await login(hostKey,'Host'),member=app.workshop.scoped(app.auth.member(host.member.pubkey)),a=app.workshop.create(member,'dice').project,b=app.workshop.create(member,'spinner',undefined,true).project;
 let result=await request('/api/v1/host/hosted-publication',host,{expectedVersion:0});expect(result.status).toBe(201);const alias=result.data.alias;
 result=await request('/api/v1/host/hosted-publication',host,{expectedVersion:1});expect(result.data).toMatchObject({alias,version:2});
 expect((await request('/api/v1/host/hosted-publication',host,{expectedVersion:1})).status).toBe(409);
 const excluded=await request(`/api/v1/host/hosted-publication/projects/${a.id}`,host,{included:false});expect(excluded.status).toBe(200);expect(excluded.data.publication.version).toBe(3);
 const page=await request('/p/'+alias);expect(page.status).toBe(200);expect(page.text).not.toContain(a.title);expect(page.text).not.toContain('conversation_id');expect(page.text).not.toContain('prompt');
 expect((await request(`/p/${alias}/apps/${a.id}`)).status).toBe(404);expect((await request(`/p/${alias}/apps/${b.id}`)).status).toBe(200);
 expect(app.db.query('SELECT id,current_revision FROM projects WHERE id=?').get(a.id)).toMatchObject({id:a.id,current_revision:a.current_revision});
});

test('public routes do not enumerate or leak private records and bridge authority still requires a real admitted session',async()=>{
 const host=await login(hostKey,'Host'),member=app.workshop.scoped(app.auth.member(host.member.pubkey)),project=app.workshop.create(member,'dice').project;
 app.db.run('INSERT INTO requests(id,project_id,prompt,expected_revision,status,created_at) VALUES(?,?,?,?,?,?)',['private-request',project.id,'secret builder prompt',project.current_revision,'queued',1]);
 const published=await request('/api/v1/host/hosted-publication',host,{name:'safe-public-canvas',expectedVersion:0}),alias=published.data.alias;
 for(const path of ['/p/unknown-canvas','/p/Not-Canonical','/p/'+alias+'/apps/'+crypto.randomUUID(),'/p/'+alias+'/images/'+'a'.repeat(64)])expect((await request(path)).status).toBe(404);
 const page=await request('/p/'+alias);expect(page.text).not.toContain('secret builder prompt');expect(page.text).not.toContain(host.cookie);expect(page.headers.get('set-cookie')).toBeNull();
 expect((await request('/api/v1/public/session?alias='+alias)).status).toBe(401);
 const outsider=await login(generateSecretKey(),'Outsider');expect((await request('/api/v1/public/session?alias='+alias,outsider)).status).toBe(403);
 expect((await request('/api/v1/public/session?alias='+alias,host)).status).toBe(200);
 const source=await request(`/p/${alias}/apps/${project.id}`);expect(source.status).toBe(200);expect(source.text).toContain('window');expect(source.headers.get('permissions-policy')).toContain('payment=()');
});
