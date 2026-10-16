import { test,expect } from 'bun:test';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { generateSecretKey,getPublicKey,nip19,finalizeEvent } from 'nostr-tools';
import { application } from '../src/application.ts';
import { TowerConnect } from '../src/tower-connect.ts';
import { sha256 } from '../src/assets.ts';
import { Workshop } from '../src/workshop.ts';
import { storageStatus,updateStorageJob,storeStorageDelivery } from '../src/storage.ts';
const towerOrigin='https://tower.example',origin='https://byo.example';
function fixture(){
 const dir=mkdtempSync('/private/tmp/byo-connect-'),key=generateSecretKey(),actor=getPublicKey(key),appKey=generateSecretKey();
 const credential=dir+'/capability';writeFileSync(credential,'a'.repeat(43),{mode:0o600});
 const template:any={installationId:crypto.randomUUID(),appPubkey:getPublicKey(appKey),appNpub:nip19.npubEncode(getPublicKey(appKey)),towerOrigin,localRoot:dir,workshopId:crypto.randomUUID(),pipeline:{brokerUrl:'http://127.0.0.1/api/internal/wapps/pipelines',credentialFile:credential,origin:'https://autopilot.example',definitionId:'storage',callbackUrl:origin+'/api/v1/storage/callback',appPubkey:getPublicKey(appKey)}};
 const config:any={dataDir:dir,hostPubkey:actor,origin,version:'test',storageTemplates:[template]};const app=application(config);
 app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[actor,'Admin','extension','admitted',20,1]);const member=app.auth.member(actor);
 const tower=app.site.register(member,{label:'Tower',origin:towerOrigin})[0],workshop=app.site.create(member,{title:'Workshop',towerId:tower.id})!;
 const connect=new TowerConnect(app.site,app.workshop.assets),sign=(url:string,method:string,payload?:any)=>finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method',method],...(payload===undefined?[]:[['payload',sha256(JSON.stringify(payload))]])]},key);
 return {dir,key,appKey,config,app,member,tower,workshop,connect,sign,template,close(){app.db.close();rmSync(dir,{recursive:true,force:true});key.fill(0);appKey.fill(0);}};
}
test('direct admin creation pins signer/app/Tower and intent; retries do not create duplicates or silently bind',async()=>{
 const f=fixture(),saved=globalThis.fetch;try{
 const body={workspaceName:'Workspace',idempotencyKey:crypto.randomUUID()},prepared=f.connect.intent(f.member,f.tower.id,f.workshop.id,body);expect(prepared.url).toBe(towerOrigin+'/api/v4/admin/flightdeck-pg/workspaces');expect(prepared.payload.app_npub).toBe(f.template.appNpub);expect(prepared.payload.creator_npub).toBe(nip19.npubEncode(f.member.pubkey));
 expect(()=>f.connect.intent({...f.member,admin:false},f.tower.id,f.workshop.id,body)).toThrow('administrator');expect(()=>f.connect.intent(f.member,f.tower.id,f.workshop.id,{...body,workspaceName:'Changed'})).toThrow('intent changed');
 let calls=0,denied=true;const workspaceId=crypto.randomUUID();
 globalThis.fetch=(async(url:any,init:any)=>{calls++;expect(url).toBe(prepared.url);expect(init.body).toBe(JSON.stringify(prepared.payload));if(denied)return Response.json({error:'admin_required'},{status:403});return Response.json({workspace_id:workspaceId,descriptor:{identity:{workspace_id:workspaceId,workspace_owner_npub:prepared.payload.creator_npub,app_npub:prepared.payload.app_npub}}});}) as any;
 await expect(f.connect.create(f.member,f.tower.id,f.workshop.id,{...body,event:f.sign(prepared.url,'POST',{...prepared.payload,workspace_name:'Wrong'})})).rejects.toThrow('signature');expect(calls).toBe(0);
 await expect(f.connect.create(f.member,f.tower.id,f.workshop.id,{...body,event:f.sign(prepared.url,'POST',prepared.payload)})).rejects.toThrow('admin_required');denied=false;
 const result=await f.connect.create(f.member,f.tower.id,f.workshop.id,{...body,event:f.sign(prepared.url,'POST',prepared.payload)});expect(result.workspace_id).toBe(workspaceId);
 expect(await f.connect.create(f.member,f.tower.id,f.workshop.id,{...body,event:f.sign(prepared.url,'POST',prepared.payload)})).toEqual(result);expect(calls).toBe(2);expect(f.app.db.query('SELECT * FROM workshop_storage_bindings').all()).toHaveLength(0);
 }finally{globalThis.fetch=saved;f.close();}
});
test('selection automatically registers app, grants guest, starts one scoped job; readiness waits for verified signed delivery; existing targets fenced',async()=>{
 const f=fixture(),saved=globalThis.fetch;try{
 const workspaceId=crypto.randomUUID(),owner=nip19.npubEncode(f.member.pubkey),entry={label:'Workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}},requests:string[]=[],runId=crypto.randomUUID();let failRegistration=true;
 globalThis.fetch=(async(url:any,init:any)=>{
  requests.push(url);if(url.endsWith('/workspaces'))return Response.json({workspaces:[entry]});
  if(url.endsWith('/apps'))return failRegistration?Response.json({error:'denied'},{status:403}):Response.json({});
  if(url.endsWith('/invites'))return Response.json({identity:{workspace_owner_npub:owner}});
  expect(url).toBe(f.template.pipeline.brokerUrl);const request=JSON.parse(init.body),bodyHash=sha256(request.serializedBody),signedUrl=f.template.pipeline.origin+request.path,event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',signedUrl],['method',request.method],['payload',bodyHash]]},f.appKey);
  return Response.json({response:{runId},httpStatus:200,receipt:{url:signedUrl,method:request.method,bodyHash,event}});
 }) as any;
 await f.connect.connect(f.member,f.tower.id,f.workshop.id,{event:f.sign(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET')});
 const body={workspaceId,event:f.sign(`${towerOrigin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,'POST',{invitee_npub:f.template.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'}),namespaceEvent:f.sign(`${towerOrigin}/api/v4/workspaces/${owner}/apps`,'POST',{app_npub:f.template.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true})};
 await expect(f.connect.bind(f.member,f.tower.id,f.workshop.id,body)).rejects.toThrow('namespace');expect(f.app.db.query('SELECT * FROM storage_jobs').all()).toHaveLength(0);failRegistration=false;
 const state=await f.connect.bind(f.member,f.tower.id,f.workshop.id,body);expect(state.binding.status).toBe('probing');expect(state.namespaceReady).toBe(false);
 const cfg=f.app.site.storage(f.workshop.id)!,w=new Workshop(f.app.db,f.app.workshop.assets,f.workshop.id),job:any=f.app.db.query('SELECT * FROM storage_jobs').get(),target=JSON.parse(job.target_json),objectId=crypto.randomUUID();
 updateStorageJob(w,cfg,job.id,{step:'namespace',namespace:{workspace_owner_npub:owner,app_npub:cfg.appNpub,schema_name:'wapp_byo_freedom_abcdef'}});
 updateStorageJob(w,cfg,job.id,{step:'preparing'});updateStorageJob(w,cfg,job.id,{step:'prepared',objectId});
 const artifact={objectId,workspaceId,towerUrl:towerOrigin,contentUrl:towerOrigin+'/api/v4/storage/'+objectId+'/content',sha256:job.sha256,sizeBytes:job.size_bytes,isPublic:false};
 updateStorageJob(w,cfg,job.id,{step:'verified',artifact,base64:job.base64});expect(storageStatus(w,cfg).binding.status).toBe('probing');
 storeStorageDelivery(w,cfg,{eventId:crypto.randomUUID(),bodyHash:'verified-delivery',attempt:1,envelope:{deliveryId:crypto.randomUUID(),runId,terminal:true,status:'ok',error:null,result:{jobId:job.id,remoteStorage:artifact}}});expect(storageStatus(w,cfg).binding.status).toBe('ready');
 f.app.db.run('UPDATE storage_jobs SET run_id=NULL WHERE id=?',[job.id]);await f.connect.bind(f.member,f.tower.id,f.workshop.id,body);expect(f.app.db.query('SELECT * FROM storage_jobs').all()).toHaveLength(1);expect(requests.filter(x=>x.endsWith('/invites'))).toHaveLength(1);
 const other=crypto.randomUUID();f.app.db.run('UPDATE storage_connections SET workspaces_json=? WHERE actor=?',[JSON.stringify([entry,{identity:{workspace_id:other,workspace_owner_npub:owner}}]),f.member.pubkey]);await expect(f.connect.bind(f.member,f.tower.id,f.workshop.id,{...body,workspaceId:other})).rejects.toThrow('already bound');
 const second=f.app.site.create(f.member,{title:'Second',towerId:f.tower.id})!;expect(f.app.site.storage(second.id)?.workshopId).toBe(second.id);expect(f.app.site.storage(second.id)?.pipeline).toEqual(cfg.pipeline);f.config.storageTemplates[0]={...f.template,pipeline:{...f.template.pipeline,definitionId:'newer-connector'}};expect(f.app.site.storage(second.id)?.pipeline.definitionId).toBe(cfg.pipeline.definitionId);expect(target.workspaceId).toBe(workspaceId);
 const beforeGrants=requests.filter(x=>x.endsWith('/invites')||x.endsWith('/apps')).length;failRegistration=true;
 await f.connect.connect(f.member,f.tower.id,second.id,{event:f.sign(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET')});
 const secondState=await f.connect.bind(f.member,f.tower.id,second.id,body);expect(secondState.binding.status).toBe('probing');expect(f.app.db.query('SELECT * FROM storage_jobs').all()).toHaveLength(2);
 expect(requests.filter(x=>x.endsWith('/invites')||x.endsWith('/apps')).length).toBe(beforeGrants);expect(secondState.namespaceReady).toBe(false);

 expect(()=>f.app.site.storage(crypto.randomUUID())).not.toThrow();
 }finally{globalThis.fetch=saved;f.close();}
});
test('exact managed WApp binding reuses its installed namespace and only asks the user for the workspace invite',async()=>{
 const f=fixture(),saved=globalThis.fetch,prior={WAPP_INSTALLATION_ID:process.env.WAPP_INSTALLATION_ID,WAPP_TOWER_URL:process.env.WAPP_TOWER_URL,WAPP_TOWER_WORKSPACE_ID:process.env.WAPP_TOWER_WORKSPACE_ID,WAPP_TOWER_WORKSPACE_OWNER_NPUB:process.env.WAPP_TOWER_WORKSPACE_OWNER_NPUB,WAPP_APP_NPUB:process.env.WAPP_APP_NPUB};
 try{
  const workspaceId=crypto.randomUUID(),owner=nip19.npubEncode(f.member.pubkey),requests:string[]=[];
  Object.assign(process.env,{WAPP_INSTALLATION_ID:f.template.installationId,WAPP_TOWER_URL:towerOrigin,WAPP_TOWER_WORKSPACE_ID:workspaceId,WAPP_TOWER_WORKSPACE_OWNER_NPUB:owner,WAPP_APP_NPUB:f.template.appNpub});
  globalThis.fetch=(async(url:any,init:any)=>{
   requests.push(String(url));
   if(String(url).endsWith('/workspaces'))return Response.json({workspaces:[{label:'Managed workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}]});
   if(String(url).endsWith('/invites'))return Response.json({identity:{workspace_id:workspaceId,workspace_owner_npub:owner}});
   expect(String(url)).not.toEndWith('/apps');expect(String(url)).toBe(f.template.pipeline.brokerUrl);
   const request=JSON.parse(init.body),bodyHash=sha256(request.serializedBody),signedUrl=f.template.pipeline.origin+request.path,event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',signedUrl],['method',request.method],['payload',bodyHash]]},f.appKey);
   return Response.json({response:{runId:crypto.randomUUID()},httpStatus:200,receipt:{url:signedUrl,method:request.method,bodyHash,event}});
  }) as any;
  await f.connect.connect(f.member,f.tower.id,f.workshop.id,{event:f.sign(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET')});
  const invite={invitee_npub:f.template.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'},event=f.sign(`${towerOrigin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,'POST',invite);
  const state=await f.connect.bind(f.member,f.tower.id,f.workshop.id,{workspaceId,event,reconnect:true});expect(state.state).toBe('probing');
  expect(requests.filter(url=>url.endsWith('/invites'))).toHaveLength(1);expect(requests.some(url=>url.endsWith('/apps'))).toBe(false);
  const grant=f.app.db.query('SELECT * FROM tower_storage_grants WHERE workshop_id=?').get(f.workshop.id) as any,proof=f.app.db.query('SELECT * FROM tower_setup_operations WHERE event_id=?').get(grant.namespace_event) as any;
  expect(grant.namespace_event).toMatch(/^[a-f0-9]{64}$/);expect(proof.url).toBe(`managed-wapp-installation:${f.template.installationId}`);expect(JSON.parse(proof.payload)).toMatchObject({towerUrl:towerOrigin,workspaceId,workspaceOwnerNpub:owner,appNpub:f.template.appNpub});
 }finally{
  globalThis.fetch=saved;for(const [key,value] of Object.entries(prior))value===undefined?delete process.env[key]:process.env[key]=value;f.close();
 }
});
test('account discovery selects unconfigured workshop only after authorization and does not require connector',async()=>{
 const f=fixture(),saved=globalThis.fetch;try{
  f.config.storageTemplates=[];
  f.app.db.run('UPDATE workshops SET tower_id=NULL WHERE id=?',[f.workshop.id]);
  globalThis.fetch=(async()=>Response.json({error:'denied'},{status:401})) as any;
  const event=f.sign(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET');
  await expect(f.connect.connect(f.member,f.tower.id,f.workshop.id,{event})).rejects.toThrow('authorization');
  expect((f.app.db.query('SELECT tower_id FROM workshops WHERE id=?').get(f.workshop.id) as any).tower_id).toBeNull();
  expect(f.app.db.query('SELECT * FROM tower_accounts').all()).toHaveLength(0);
  globalThis.fetch=(async()=>Response.json({workspaces:[{label:'Remote workspace'}]})) as any;
  const result=await f.connect.connect(f.member,f.tower.id,f.workshop.id,{event});
  expect(result.workspaces).toHaveLength(1);expect(result.storage.configured).toBe(false);
  expect((f.app.db.query('SELECT tower_id FROM workshops WHERE id=?').get(f.workshop.id) as any).tower_id).toBe(f.tower.id);
  await expect(f.connect.bind(f.member,f.tower.id,f.workshop.id,{})).rejects.toThrow('installation-wide storage worker');
 }finally{globalThis.fetch=saved;f.close();}
});
test('discovering another Tower preserves configured workshop destination and fences storage setup',async()=>{
 const f=fixture(),saved=globalThis.fetch;try{
  const config=f.app.site.storage(f.workshop.id),before=f.app.db.query('SELECT * FROM managed_workshop_storage').all();
  globalThis.fetch=(async()=>Response.json({workspaces:[]})) as any;
  await f.connect.connect(f.member,f.tower.id,f.workshop.id,{event:f.sign(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET')});
  const connections=f.app.db.query('SELECT * FROM storage_connections').all();
  const other=f.app.site.register(f.member,{label:'Other',origin:'https://other.example'}).find(t=>t.origin==='https://other.example')!;
  globalThis.fetch=(async()=>Response.json({workspaces:[]})) as any;
  const result=await f.connect.connect(f.member,other.id,f.workshop.id,{event:f.sign(other.origin+'/api/v4/flightdeck-pg/workspaces','GET')});
  expect(result.storage).toEqual({configured:false,otherTower:true});expect(f.app.db.query('SELECT * FROM storage_connections').all()).toEqual(connections);
  expect(f.app.site.storage(f.workshop.id)).toEqual(config);expect(f.app.db.query('SELECT * FROM managed_workshop_storage').all()).toEqual(before);
  expect((f.app.db.query('SELECT tower_id FROM workshops WHERE id=?').get(f.workshop.id) as any).tower_id).toBe(f.tower.id);
  await expect(f.connect.bind(f.member,other.id,f.workshop.id,{})).rejects.toThrow('Select this Tower');
  expect(f.app.site.towers(f.member).find(t=>t.id===other.id)?.connected).toBe(true);
 }finally{globalThis.fetch=saved;f.close();}
});

test('installation-wide connector onboards selected Nstack without per-Tower templates and keeps grant/job/namespace authority exact',async()=>{
 const f=fixture(),saved=globalThis.fetch;try{
 f.config.storageTemplates=[];f.config.managedStorage=f.template;
 const nstack='https://nstack.otherstuff.ai',tower=f.app.site.register(f.member,{label:'Nstack',origin:nstack}).find(t=>t.origin===nstack)!;
 const workshop=f.app.site.create(f.member,{title:'Nstack workshop',towerId:tower.id})!,workspaceId=crypto.randomUUID(),owner=nip19.npubEncode(f.member.pubkey),runId=crypto.randomUUID();let grants=0;
 globalThis.fetch=(async(url:any,init:any)=>{
  if(url===nstack+'/api/v4/flightdeck-pg/workspaces')return Response.json({workspaces:[{label:'Selected workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}]});
  if(url.startsWith(nstack)&&url.endsWith('/apps')){grants++;return Response.json({});}
  if(url.startsWith(nstack)&&url.endsWith('/invites')){grants++;return Response.json({identity:{workspace_id:workspaceId,workspace_owner_npub:owner}});}
  expect(url).toBe(f.template.pipeline.brokerUrl);const b=JSON.parse(init.body),bodyHash=sha256(b.serializedBody),signedUrl=f.template.pipeline.origin+b.path,event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',signedUrl],['method',b.method],['payload',bodyHash]]},f.appKey);
  return Response.json({response:{runId},httpStatus:200,receipt:{url:signedUrl,method:b.method,bodyHash,event}});
 }) as any;
 const connected:any=await f.connect.connect(f.member,tower.id,workshop.id,{event:f.sign(nstack+'/api/v4/flightdeck-pg/workspaces','GET')});expect(connected.storage.state).toBe('needs_authorization');expect(connected.storage.towerOrigin).toBe(nstack);
 const cfg=f.app.site.storage(workshop.id)!,w=new Workshop(f.app.db,f.app.workshop.assets,workshop.id);
 const body={workspaceId,reconnect:true,event:f.sign(`${nstack}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`,'POST',{invitee_npub:cfg.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'}),namespaceEvent:f.sign(`${nstack}/api/v4/workspaces/${owner}/apps`,'POST',{app_npub:cfg.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true})};
 await expect(f.connect.bind(f.member,tower.id,workshop.id,{...body,workspaceId:crypto.randomUUID()})).rejects.toThrow('authorized Tower list');
 const before=f.app.db.query('SELECT current_revision FROM projects').all();const state=await f.connect.bind(f.member,tower.id,workshop.id,body);expect(state.state).toBe('probing');expect(grants).toBe(2);
 const {getStorageJob}=await import('../src/storage.ts');const job=getStorageJob(w,cfg,state.probe.id);expect(job.destinationGrant).toMatchObject({installationId:cfg.installationId,workshopId:workshop.id,target:{towerUrl:nstack,workspaceId,appNpub:cfg.appNpub},inviteEventId:body.event.id,namespaceEventId:body.namespaceEvent.id});
 expect(f.app.db.query('SELECT current_revision FROM projects').all()).toEqual(before);
 const oid=crypto.randomUUID(),row=f.app.db.query('SELECT * FROM storage_jobs WHERE id=?').get(job.jobId) as any;
 updateStorageJob(w,cfg,job.jobId,{step:'namespace',namespace:{workspace_owner_npub:owner,app_npub:cfg.appNpub,schema_name:'wapp_byo_freedom_abcd'}});updateStorageJob(w,cfg,job.jobId,{step:'preparing'});updateStorageJob(w,cfg,job.jobId,{step:'prepared',objectId:oid});
 const artifact={objectId:oid,workspaceId,towerUrl:nstack,contentUrl:nstack+'/api/v4/storage/'+oid+'/content',sha256:job.sha256,sizeBytes:job.sizeBytes,isPublic:false};updateStorageJob(w,cfg,job.jobId,{step:'verified',artifact,base64:row.base64});
 expect(storageStatus(w,cfg).state).toBe('probing');storeStorageDelivery(w,cfg,{eventId:crypto.randomUUID(),bodyHash:'nstack',attempt:1,envelope:{deliveryId:crypto.randomUUID(),runId,terminal:true,status:'ok',error:null,result:{jobId:job.jobId,remoteStorage:artifact}}});expect(storageStatus(w,cfg).state).toBe('ready');
 await f.connect.bind(f.member,tower.id,workshop.id,body);expect(grants).toBe(2);expect(f.app.db.query('SELECT id FROM storage_jobs WHERE workshop_id=?').all(workshop.id)).toHaveLength(1);
 updateStorageJob(w,cfg,job.jobId,{step:'failed',error:'tower_storage_read_http_403'});expect(storageStatus(w,cfg).state).toBe('error');expect(storageStatus(w,cfg).binding.status).toBe('needs_authorization');
 expect(storageStatus(w,cfg).binding.target.workspaceId).toBe(workspaceId);expect(f.app.db.query('SELECT current_revision FROM projects').all()).toEqual(before);
 }finally{globalThis.fetch=saved;f.close();}
});

test('Canvas creation intent preserves details and exact Tower across reload and duplicate submissions',()=>{
 const f=fixture();try{
  const input={title:'Canvas with Nstack',introduction:'Keep my details',towerId:f.tower.id,owner:f.member.pubkey,idempotencyKey:crypto.randomUUID()};
  const first=f.app.site.create(f.member,input)!;
  expect(f.app.site.create(f.member,input)?.id).toBe(first.id);
  expect(f.app.site.create(f.member,{...input,idempotencyKey:crypto.randomUUID()})?.id).not.toBe(first.id);
  expect(()=>f.app.site.create(f.member,{...input,title:'Changed'})).toThrow('details changed');
  expect(()=>f.app.site.create({...f.member,admin:false},input)).toThrow('administrator');
  expect(f.app.site.workshops(f.member).find(w=>w.id===first.id)).toMatchObject({introduction:'Keep my details',tower_id:f.tower.id,owner:f.member.pubkey});
 }finally{f.close();}
});

test('connection reuse requires current workspace access and exact durable app evidence, then launches a fresh scoped probe',async()=>{
 const f=fixture(),saved=globalThis.fetch,keyB=generateSecretKey();try{
  const {reusableStorageGrant}=await import('../src/storage.ts');
  const actorB=getPublicKey(keyB);f.config.adminPubkeys=[actorB];f.app.db.run('INSERT INTO members VALUES(?,?,?,?,?,?)',[actorB,'Second admin','extension','admitted',20,1]);const memberB=f.app.auth.member(actorB);
  const signB=(url:string,method:string,payload?:any)=>finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method',method],...(payload===undefined?[]:[['payload',sha256(JSON.stringify(payload))]])]},keyB);
  const cfg=f.app.site.storage(f.workshop.id)!,w=new Workshop(f.app.db,f.app.workshop.assets,f.workshop.id),workspaceId=crypto.randomUUID(),owner=nip19.npubEncode(f.member.pubkey);
  const target={towerUrl:towerOrigin,workspaceId,workspaceOwnerNpub:owner,appNpub:cfg.appNpub};
  const namespaceEvent=crypto.randomUUID(),inviteEvent=crypto.randomUUID(),namespace={workspace_owner_npub:owner,app_npub:cfg.appNpub,schema_name:'wapp_byo_freedom_abcd'};
  f.app.db.run('INSERT INTO workshop_storage_bindings(workshop_id,installation_id,target_json,local_root,status,connected_actor,namespace_json) VALUES(?,?,?,?,?,?,?)',[w.id,cfg.installationId,JSON.stringify(target),cfg.localRoot,'ready',f.member.pubkey,JSON.stringify(namespace)]);
  f.app.db.run('INSERT INTO tower_storage_grants VALUES(?,?,?,?,?,?,?)',[w.id,cfg.installationId,JSON.stringify(target),f.member.pubkey,namespaceEvent,inviteEvent,Math.floor(Date.now()/1000)]);
  expect(reusableStorageGrant(w,cfg,target,f.member.pubkey)).toBeUndefined();
  const nsUrl=`${towerOrigin}/api/v4/workspaces/${owner}/apps`,inviteUrl=`${towerOrigin}/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`;
  f.app.db.run('INSERT INTO tower_setup_operations VALUES(?,?,?,?)',[namespaceEvent,nsUrl,JSON.stringify({app_npub:cfg.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true}),'{}']);
  f.app.db.run('INSERT INTO tower_setup_operations VALUES(?,?,?,?)',[inviteEvent,inviteUrl,JSON.stringify({invitee_npub:cfg.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'}),JSON.stringify({identity:{workspace_id:workspaceId,workspace_owner_npub:owner}})]);
  expect(reusableStorageGrant(w,cfg,target,f.member.pubkey)).toBeUndefined();
  f.app.db.run('INSERT INTO storage_connections VALUES(?,?,?,?)',[f.member.pubkey,towerOrigin,JSON.stringify([{identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}]),Math.floor(Date.now()/1000)]);
  expect(reusableStorageGrant(w,cfg,target,f.member.pubkey)).toBeDefined();
  for(const changes of [{workspaceId:crypto.randomUUID()},{towerUrl:'https://other.example'},{appNpub:nip19.npubEncode('b'.repeat(64))},{workspaceOwnerNpub:nip19.npubEncode('c'.repeat(64))}])expect(reusableStorageGrant(w,cfg,{...target,...changes},f.member.pubkey)).toBeUndefined();
  expect(reusableStorageGrant(w,cfg,target,actorB)).toBeUndefined();
  f.app.db.run('INSERT INTO storage_connections VALUES(?,?,?,?)',[actorB,towerOrigin,JSON.stringify([{identity:{workspace_id:workspaceId,workspace_owner_npub:nip19.npubEncode('c'.repeat(64))}}]),Math.floor(Date.now()/1000)]);
  expect(reusableStorageGrant(w,cfg,target,actorB)).toBeUndefined();
  f.app.db.run('UPDATE storage_connections SET workspaces_json=?,connected_at=? WHERE actor=?',[JSON.stringify([{identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}]),Math.floor(Date.now()/1000)-901,actorB]);
  expect(reusableStorageGrant(w,cfg,target,actorB)).toBeUndefined();
  f.app.db.run('UPDATE storage_connections SET connected_at=? WHERE actor=?',[Math.floor(Date.now()/1000),actorB]);
  expect(reusableStorageGrant(w,cfg,target,actorB)).toBeDefined();
  const second=f.app.site.create(memberB,{title:'Reuse',towerId:f.tower.id})!,calls:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
   calls.push(url);if(url===towerOrigin+'/api/v4/flightdeck-pg/workspaces')return Response.json({workspaces:[{label:'Exact workspace',identity:{workspace_id:workspaceId,workspace_owner_npub:owner}}]});
   expect(url).toBe(f.template.pipeline.brokerUrl);const request=JSON.parse(init.body),bodyHash=sha256(request.serializedBody),signedUrl=f.template.pipeline.origin+request.path,event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',signedUrl],['method',request.method],['payload',bodyHash]]},f.appKey);
   return Response.json({response:{runId:crypto.randomUUID()},httpStatus:200,receipt:{url:signedUrl,method:request.method,bodyHash,event}});
  }) as any;
  const result=await f.connect.connect(memberB,f.tower.id,second.id,{event:signB(towerOrigin+'/api/v4/flightdeck-pg/workspaces','GET')});expect(result.reusable).toEqual([workspaceId]);
  const ready=await f.connect.bind(memberB,f.tower.id,second.id,{workspaceId,reuse:true});expect(ready.state).toBe('probing');expect(ready.binding.target).toEqual(target);expect(ready.namespaceReady).toBe(false);
  expect(calls.some(url=>url===nsUrl||url===inviteUrl)).toBe(false);expect(f.app.db.query('SELECT id FROM storage_jobs WHERE workshop_id=?').all(second.id)).toHaveLength(1);
  expect(f.app.db.query('SELECT actor,namespace_event,invite_event FROM tower_storage_grants WHERE workshop_id=?').get(second.id)).toEqual({actor:actorB,namespace_event:namespaceEvent,invite_event:inviteEvent});
  const cfg2=f.app.site.storage(second.id)!,w2=new Workshop(f.app.db,f.app.workshop.assets,second.id);updateStorageJob(w2,cfg2,ready.probe.id,{step:'failed',error:'tower_storage_http_403'});expect(storageStatus(w2,cfg2).state).toBe('error');
  expect(storageStatus(w,cfg).binding.status).toBe('ready');
  f.app.db.run('DELETE FROM tower_setup_operations WHERE event_id=?',[inviteEvent]);await expect(f.connect.bind(memberB,f.tower.id,second.id,{workspaceId,reuse:true})).rejects.toThrow('needs authorization');
 }finally{globalThis.fetch=saved;keyB.fill(0);f.close();}
});
