import type { Workshop } from './workshop.ts';
import type { Config, OperatorBuildConfig } from './config.ts';
import { publicKey } from './config.ts';
import { readLocalCandidate } from './local-builds.ts';
import { sha256 } from './assets.ts';
import { demand } from './errors.ts';
import { storageTarget, uuid, type StorageTarget } from './tower-storage-client.ts';
import { now, type Member } from './auth.ts';
import { ManagedPipelineClient } from './pipeline/managed-client.ts';
import { storeDelivery } from './delivery-store.ts';
import {registerAgentPublication} from './agent-publication.ts';
import type { VerifiedDelivery } from './pipeline/receiver.ts';
import { verifyEvent } from 'nostr-tools';
import { ensureBuilderDirectory } from './pipeline/project-directory.ts';
import { resolve } from 'node:path';
import { canvasBrokerBindingStatus } from './canvas-broker.ts';
export type StorageConfig={installationId:string;appPubkey:string;appNpub:string;towerOrigin:string;workshopId:string;localRoot:string;signupGatewayOrigin?:string;pipeline:OperatorBuildConfig};
export function installStorageTables(workshop:Workshop){workshop.db.exec(`
 CREATE TABLE IF NOT EXISTS storage_binding(id INTEGER PRIMARY KEY CHECK(id=1),installation_id TEXT NOT NULL,workshop_id TEXT NOT NULL,target_json TEXT NOT NULL,local_root TEXT NOT NULL,status TEXT NOT NULL,probe_job_id TEXT,connected_actor TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workshop_storage_bindings(workshop_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,target_json TEXT NOT NULL,local_root TEXT NOT NULL,status TEXT NOT NULL,probe_job_id TEXT,connected_actor TEXT NOT NULL,namespace_json TEXT);
 CREATE TABLE IF NOT EXISTS tower_storage_grants(workshop_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,target_json TEXT NOT NULL,actor TEXT NOT NULL,namespace_event TEXT NOT NULL,invite_event TEXT NOT NULL,authorized_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tower_setup_operations(event_id TEXT PRIMARY KEY,url TEXT NOT NULL,payload TEXT NOT NULL,result_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS storage_connections(actor TEXT PRIMARY KEY,tower_origin TEXT NOT NULL,workspaces_json TEXT NOT NULL,connected_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS storage_jobs(id TEXT PRIMARY KEY,operation TEXT NOT NULL,request_id TEXT UNIQUE,original_run_id TEXT,candidate_json TEXT,target_json TEXT NOT NULL,file_name TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,base64 TEXT NOT NULL,status TEXT NOT NULL,object_id TEXT,artifact_json TEXT,run_id TEXT,attempt INTEGER NOT NULL DEFAULT 0,read_base64 TEXT,error TEXT);
 CREATE TABLE IF NOT EXISTS storage_auth_events(event_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS storage_deliveries(delivery_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,envelope_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS remote_versions(revision_id TEXT PRIMARY KEY REFERENCES revisions(id),job_id TEXT NOT NULL UNIQUE REFERENCES storage_jobs(id),artifact_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS chat_attachments(id TEXT PRIMARY KEY,workshop_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),uploader TEXT NOT NULL REFERENCES members(pubkey),storage_job_id TEXT NOT NULL UNIQUE REFERENCES storage_jobs(id),storage_object_id TEXT UNIQUE,filename TEXT NOT NULL,content_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS request_attachments(request_id TEXT NOT NULL REFERENCES requests(id),attachment_id TEXT NOT NULL REFERENCES chat_attachments(id),ordinal INTEGER NOT NULL,metadata_json TEXT NOT NULL,PRIMARY KEY(request_id,attachment_id),UNIQUE(request_id,ordinal));
 CREATE TRIGGER IF NOT EXISTS request_attachment_no_update BEFORE UPDATE ON request_attachments BEGIN SELECT RAISE(ABORT,'immutable request attachment'); END;
 CREATE TRIGGER IF NOT EXISTS request_attachment_no_delete BEFORE DELETE ON request_attachments BEGIN SELECT RAISE(ABORT,'immutable request attachment'); END;
 `);const columns=workshop.db.query('PRAGMA table_info(storage_binding)').all() as {name:string}[];if(!columns.some(c=>c.name==='namespace_json'))workshop.db.exec('ALTER TABLE storage_binding ADD COLUMN namespace_json TEXT');const jobs=workshop.db.query('PRAGMA table_info(storage_jobs)').all() as {name:string}[];if(!jobs.some(c=>c.name==='workshop_id')){workshop.db.exec('ALTER TABLE storage_jobs ADD COLUMN workshop_id TEXT');workshop.db.run('UPDATE storage_jobs SET workshop_id=?',[(workshop.db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id]);}if(!jobs.some(c=>c.name==='content_type'))workshop.db.exec("ALTER TABLE storage_jobs ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text/html'");const requestAttachments=workshop.db.query('PRAGMA table_info(request_attachments)').all() as {name:string}[];if(!requestAttachments.some(c=>c.name==='metadata_json'))workshop.db.exec("ALTER TABLE request_attachments ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");}
export function storageBinding(workshop:Workshop,config?:StorageConfig){
 if(config)demand(config.workshopId===workshop.id,409,'Storage installation workshop mismatch');
 const row=workshop.legacy?workshop.db.query('SELECT * FROM storage_binding WHERE id=1').get() as any:workshop.db.query('SELECT * FROM workshop_storage_bindings WHERE workshop_id=?').get(workshop.id) as any;
 if(!row)return null;
 if(!config||row.installation_id!==config.installationId||row.workshop_id!==config.workshopId||row.local_root!==config.localRoot)throw Error('storage_binding_config_changed');
 const target=storageTarget(JSON.parse(row.target_json));if(target.towerUrl!==config.towerOrigin||target.appNpub!==config.appNpub)throw Error('storage_binding_authority_changed');
 return {...row,target};
}
export function storageStatus(workshop:Workshop,config?:StorageConfig,env=process.env){
 const binding=storageBinding(workshop,config),probe:any=binding?.probe_job_id?workshop.db.query('SELECT id,status,error,artifact_json FROM storage_jobs WHERE id=?').get(binding.probe_job_id):null;
 const state=!config?'disconnected':!binding?'needs_authorization':probe?.error?'error':binding.status==='ready'&&binding.namespace_json?'ready':binding.status==='probing'?'probing':'needs_authorization';
 const datasetDiscovery=config&&binding?canvasBrokerBindingStatus({installationId:config.installationId,target:binding.target,canvasId:workshop.id,user:''},env):null;
 return {state,namespace:binding?.namespace_json?JSON.parse(binding.namespace_json):null,namespaceReady:!!binding?.namespace_json,signupGatewayOrigin:config?.signupGatewayOrigin,configured:!!config,installationId:config?.installationId,appNpub:config?.appNpub,towerOrigin:config?.towerOrigin,workshopId:config?.workshopId,localRoot:config?.localRoot,binding,probe,datasetDiscovery};
}
export function verifyStorageAuth(request:Request,raw:string,pubkey:string,origin:string){
 let event:any;try{event=JSON.parse(Buffer.from((request.headers.get('authorization')||'').replace(/^Nostr /,''),'base64').toString());}catch{}
 const tag=(name:string)=>{const rows=event?.tags?.filter((t:string[])=>t[0]===name);return rows?.length===1&&rows[0].length===2?rows[0][1]:undefined;};
 demand(event&&verifyEvent(event)&&event.pubkey===pubkey&&event.kind===27235&&event.content===''&&Math.abs(event.created_at-now())<=60&&tag('u')===origin+new URL(request.url).pathname&&tag('method')===request.method&&(raw?tag('payload')===sha256(raw):tag('payload')===undefined),401,'Storage authentication denied');
 return event.id as string;
}
export function createStorageJob(workshop:Workshop,operation:string,target:StorageTarget,fileName:string,bytes:Uint8Array,candidate?:any,request?:any,contentType='text/html'){
 const id=crypto.randomUUID();workshop.db.run('INSERT INTO storage_jobs(id,operation,request_id,original_run_id,candidate_json,target_json,file_name,sha256,size_bytes,base64,status,content_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,operation,request?.id??null,request?.run_id??null,candidate?JSON.stringify(candidate):null,JSON.stringify(target),fileName,sha256(bytes),bytes.length,Buffer.from(bytes).toString('base64'),'pending',contentType]);workshop.db.run('UPDATE storage_jobs SET workshop_id=? WHERE id=?',[workshop.id,id]);return id;
}
export function candidateStorageJob(workshop:Workshop,config:StorageConfig,body:any){
 const binding=storageBinding(workshop,config);demand(binding?.status==='ready',409,'Tower storage is not ready');
 const request=workshop.db.query('SELECT * FROM requests WHERE id=?').get(body.requestId) as any;
 const project=request&&workshop.db.query('SELECT * FROM projects WHERE id=?').get(request.project_id) as any;
 demand(request&&project?.workshop_id===config.workshopId&&request.project_id===body.projectId&&request.run_id===body.candidate?.nativeReceipt?.invocationRunId&&request.id===body.candidate?.nativeReceipt?.requestId&&body.candidate.action==='build_completed'&&body.candidate.nativeReceipt.projectId===project.id,403,'Storage candidate correlation denied');
 const prior=workshop.db.query('SELECT * FROM storage_jobs WHERE request_id=?').get(request.id) as any;
 if(prior){demand(prior.candidate_json===JSON.stringify(body.candidate),409,'Storage candidate changed');return {jobId:prior.id};}
 demand(request.status==='building',409,'Build is not active');
 const candidate=readLocalCandidate(workshop,request,body.candidate);
 const id=createStorageJob(workshop,'build',binding.target,`napplet-${project.id}-v${candidate.row.version}.html`,Buffer.from(candidate.source),body.candidate,request);
 return {jobId:id};
}
export function getStorageJob(workshop:Workshop,config:StorageConfig,id:string){
 demand(uuid.test(id),400,'Invalid storage job');const job=workshop.db.query('SELECT * FROM storage_jobs WHERE id=?').get(id) as any;demand(job&&job.workshop_id===workshop.id,404,'Storage job not found');
 const target=storageTarget(JSON.parse(job.target_json)),binding=storageBinding(workshop,config);
 demand(binding&&JSON.stringify(target)===JSON.stringify(binding.target),403,'Storage job binding changed');
 const receipt=job.candidate_json&&job.object_id?{id:job.id,workspace_id:target.workspaceId,installation_id:config.installationId,project_id:JSON.parse(job.candidate_json).nativeReceipt.projectId,version:JSON.parse(job.candidate_json).version,object_id:job.object_id,sha256:job.sha256,size_bytes:job.size_bytes}:null;
 const namespaceReceipts=job.operation==='namespace'?(workshop.db.query('SELECT j.* FROM remote_versions v JOIN storage_jobs j ON j.id=v.job_id WHERE j.workshop_id=?').all(workshop.id) as any[]).filter(j=>JSON.stringify(storageTarget(JSON.parse(j.target_json)))===JSON.stringify(target)).map(j=>({id:j.id,workspace_id:target.workspaceId,installation_id:config.installationId,project_id:JSON.parse(j.candidate_json).nativeReceipt.projectId,version:JSON.parse(j.candidate_json).version,object_id:j.object_id,sha256:j.sha256,size_bytes:j.size_bytes})):[];
 const grant=workshop.db.query('SELECT * FROM tower_storage_grants WHERE workshop_id=?').get(workshop.id) as any;
 const destinationGrant=grant&&grant.installation_id===config.installationId&&grant.target_json===JSON.stringify(target)?{installationId:grant.installation_id,workshopId:workshop.id,target,actor:grant.actor,namespaceEventId:grant.namespace_event,inviteEventId:grant.invite_event}:null;
 return {destinationGrant,namespace:binding.namespace_json?JSON.parse(binding.namespace_json):null,namespaceReceipts,receipt,installationId:config.installationId,workshopId:config.workshopId,jobId:job.id,operation:job.operation,status:job.status,error:job.error??null,target,objectId:job.object_id,fileName:job.file_name,contentType:job.content_type||'text/html',sha256:job.sha256,sizeBytes:job.size_bytes,base64:job.base64,candidate:job.candidate_json?JSON.parse(job.candidate_json):null,artifact:job.artifact_json?JSON.parse(job.artifact_json):null};
}
export function updateStorageJob(workshop:Workshop,config:StorageConfig,id:string,body:any){
 const job=getStorageJob(workshop,config,id),db=workshop.db;
 if(body.step==='dataset'){demand(job.operation==='dataset'&&body.result&&Number.isInteger(body.result.status)&&body.result.status>=200&&body.result.status<=599&&Buffer.byteLength(JSON.stringify(body.result))<=400000,400,'Dataset result denied');db.run("UPDATE storage_jobs SET status='verified',artifact_json=? WHERE id=? AND status='pending'",[JSON.stringify(body.result),id]);}
 else if(body.step==='namespace'){const n=body.namespace;demand(n?.workspace_owner_npub===job.target.workspaceOwnerNpub&&n.app_npub===config.appNpub&&/^wapp_byo_freedom_[a-f0-9]+$/.test(n.schema_name),409,'Namespace receipt denied');db.run(`UPDATE ${workshop.legacy?'storage_binding':'workshop_storage_bindings'} SET namespace_json=? WHERE workshop_id=?`,[JSON.stringify(n),workshop.id]);if(job.operation==='namespace')db.run("UPDATE storage_jobs SET status='verified' WHERE id=?",[id]);}
 else if(body.step==='preparing'){demand(job.status==='pending'&&!job.objectId,409,'Storage prepare already claimed');db.run("UPDATE storage_jobs SET status='preparing' WHERE id=? AND status='pending'",[id]);}
 else if(body.step==='prepared'){demand(uuid.test(body.objectId)&&(!job.objectId||job.objectId===body.objectId)&&['preparing','prepared'].includes(job.status),409,'Storage object binding conflict');db.run("UPDATE storage_jobs SET status='prepared',object_id=? WHERE id=?",[body.objectId,id]);}
 else if(['verified','read'].includes(body.step)){
  const a=body.artifact,bytes=Buffer.from(body.base64||'','base64');
  demand(job.objectId&&a?.objectId===job.objectId&&a.workspaceId===job.target.workspaceId&&a.towerUrl===job.target.towerUrl&&a.contentUrl===`${job.target.towerUrl}/api/v4/storage/${job.objectId}/content`&&a.sha256===job.sha256&&a.sizeBytes===job.sizeBytes&&a.isPublic===false&&bytes.length===job.sizeBytes&&sha256(bytes)===job.sha256,409,'Storage verification receipt denied');
  demand(['prepared','verified'].includes(job.status),409,'Storage job not prepared');
  if(job.artifact)demand(JSON.stringify(a)===JSON.stringify(job.artifact),409,'Storage receipt changed');
  db.run("UPDATE storage_jobs SET status='verified',artifact_json=?,read_base64=?,error=NULL WHERE id=?",[JSON.stringify(a),body.base64,id]);
 }else if(body.step==='failed'){demand(typeof body.error==='string'&&body.error.length<=4000,400,'Invalid storage failure');db.run('UPDATE storage_jobs SET error=? WHERE id=?',[body.error,id]);if(/tower_.*http_(401|403)/.test(body.error))db.run(`UPDATE ${workshop.legacy?'storage_binding':'workshop_storage_bindings'} SET status='needs_authorization' WHERE workshop_id=?`,[workshop.id]);}else if(body.step==='prepare_failed'){demand(job.status==='preparing'&&!job.objectId&&/^tower_storage_http_4[0-9]{2}$/.test(body.error),409,'Prepare failure is uncertain');db.run("UPDATE storage_jobs SET status='pending',error=? WHERE id=?",[body.error,id]);}else demand(false,400,'Unknown storage step');
 return getStorageJob(workshop,config,id);
}
export function requireRemoteVersion(workshop:Workshop,request:any,result:any,hash:string){
 const job=workshop.db.query("SELECT * FROM storage_jobs WHERE request_id=? AND status='verified'").get(request.id) as any;
 demand(job&&['artifactPath','version','validation','response'].every(key=>JSON.stringify(JSON.parse(job.candidate_json)[key])===JSON.stringify(result[key]))&&result.jobId===job.id&&job.sha256===hash&&job.candidate_json&&JSON.stringify(JSON.parse(job.candidate_json).nativeReceipt)===JSON.stringify(result.nativeReceipt)&&JSON.stringify(JSON.parse(job.artifact_json))===JSON.stringify(result.remoteStorage),409,'Verified Tower storage required');
 return {jobId:job.id,artifact:JSON.parse(job.artifact_json)};
}
export async function dispatchStorageJob(workshop:Workshop,config:StorageConfig,id:string){
 const job=getStorageJob(workshop,config,id),row=workshop.db.query('SELECT * FROM storage_jobs WHERE id=?').get(id) as any;
 demand(job.status!=='preparing'||!!job.objectId,409,'Prepare outcome is uncertain; reconcile the Tower object before retrying');
 const claimed=workshop.db.transaction(()=>{const current=workshop.db.query('SELECT * FROM storage_jobs WHERE id=?').get(id) as any;demand(!current.run_id,409,'Storage attempt is active; refresh its result');const attempt=current.attempt+1;workshop.db.run('UPDATE storage_jobs SET attempt=?,run_id=? WHERE id=?',[attempt,`storage:${id}:${attempt}`,id]);return attempt;}).immediate();
 const client=new ManagedPipelineClient(config.pipeline);
 // The attempt key persists across uncertain acceptance. Never repeat the native build.
 const key=`storage:${id}:${claimed}`;
 try{const accepted=await client.submit({requestId:id,projectId:row.request_id??config.workshopId,prompt:'Verify the installation-issued private storage job',jobId:id} as any,key);workshop.db.run('UPDATE storage_jobs SET run_id=? WHERE id=? AND run_id=?',[accepted.runId,id,key]);return {jobId:id,runId:accepted.runId};}
 catch(error){workshop.db.run('UPDATE storage_jobs SET error=? WHERE id=?',[String(error),id]);throw error;}
}
export function storeStorageDelivery(workshop:Workshop,config:StorageConfig,delivery:VerifiedDelivery){
 const result=delivery.envelope.result as any,id=result?.jobId,row=workshop.db.query('SELECT * FROM storage_jobs WHERE id=?').get(id||'') as any;
 demand(row&&row.run_id===delivery.envelope.runId,403,'Storage callback run binding denied');
 return workshop.db.transaction(()=>{
 demand(!workshop.db.query('SELECT event_id FROM storage_auth_events WHERE event_id=?').get(delivery.eventId),401,'Storage callback authentication replay');
 workshop.db.run('INSERT INTO storage_auth_events VALUES(?)',[delivery.eventId]);
 const previous=workshop.db.query('SELECT * FROM storage_deliveries WHERE delivery_id=?').get(delivery.envelope.deliveryId) as any;
 if(previous){demand(previous.body_hash===delivery.bodyHash,409,'Storage callback conflict');return 'duplicate';}
 const job=getStorageJob(workshop,config,id);
 if(row.operation==='dataset'&&job.status==='verified'&&result.action==='dataset_completed'){}
 else if(row.operation==='namespace'&&delivery.envelope.status==='ok'&&job.status==='verified'&&result.action==='namespace_ready'){workshop.db.run('UPDATE storage_jobs SET error=NULL WHERE id=?',[id]);}
 else if(delivery.envelope.status==='ok'&&job.status==='verified'&&result.remoteStorage&&JSON.stringify(result.remoteStorage)===JSON.stringify(job.artifact)){
  if(row.operation==='probe')workshop.db.run(`UPDATE ${workshop.legacy?'storage_binding':'workshop_storage_bindings'} SET status='ready' WHERE workshop_id=? AND probe_job_id=?`,[workshop.id,id]);
  if(row.operation==='build'){
   const candidate=JSON.parse(row.candidate_json);
   demand(result.action==='build_completed'&&JSON.stringify(result.nativeReceipt)===JSON.stringify(candidate.nativeReceipt),409,'Storage retry candidate denied');
   // Signed storage callback is correlated through the durable job to the original native invocation.
   const recovery=workshop.db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(row.request_id) as any;
   if(recovery&&JSON.parse(recovery.input_json).replacementContext?.fileBuild?.publication==='agent-tool-v1')registerAgentPublication(workshop,{requestId:row.request_id,projectId:candidate.nativeReceipt.projectId,candidate:result});
   else storeDelivery(workshop.db,{...delivery,envelope:{...delivery.envelope,runId:row.original_run_id,result:{...result,requestId:row.request_id,projectId:candidate.nativeReceipt.projectId}}},workshop);
  }
 }else {const error=String(result?.error||delivery.envelope.error||'Storage verification failed');workshop.db.run('UPDATE storage_jobs SET error=? WHERE id=?',[error,id]);if(/tower_.*http_(401|403)/.test(error))workshop.db.run(`UPDATE ${workshop.legacy?'storage_binding':'workshop_storage_bindings'} SET status='needs_authorization' WHERE workshop_id=?`,[workshop.id]);}
 workshop.db.run('INSERT INTO storage_deliveries VALUES(?,?,?)',[delivery.envelope.deliveryId,delivery.bodyHash,JSON.stringify(delivery.envelope)]);
 return 'applied';
 })();
}
export async function pollStorageJob(workshop:Workshop,config:StorageConfig,id:string){
 const row=workshop.db.query('SELECT * FROM storage_jobs WHERE id=?').get(id) as any;demand(row,404,'Storage job not found');
 if(!row.run_id)return getStorageJob(workshop,config,id);
 const client=new ManagedPipelineClient(config.pipeline);
 if(row.run_id.startsWith('storage:')){const accepted=await client.submit({requestId:id,projectId:row.request_id??config.workshopId,prompt:'Verify the installation-issued private storage job',jobId:id} as any,row.run_id);workshop.db.run('UPDATE storage_jobs SET run_id=? WHERE id=?',[accepted.runId,id]);row.run_id=accepted.runId;}
 const poll=await client.poll(row.run_id),run=poll.response;
 if(['ok','error','cancelled'].includes(run.status)&&getStorageJob(workshop,config,id).status!=='verified')workshop.db.run('UPDATE storage_jobs SET run_id=NULL,error=? WHERE id=?',[String(run.result?.error??run.error??'Storage pending'),id]);
 return getStorageJob(workshop,config,id);
}
export async function remotePreview(workshop:Workshop,config:StorageConfig,revisionId:string){
 const remote=workshop.db.query('SELECT * FROM remote_versions WHERE revision_id=?').get(revisionId) as any;
 if(!remote)return null;
 const previous=getStorageJob(workshop,config,remote.job_id),a=JSON.parse(remote.artifact_json),id=createStorageJob(workshop,'read',previous.target,previous.fileName,new Uint8Array(0));
 workshop.db.run("UPDATE storage_jobs SET status='prepared',object_id=?,artifact_json=?,sha256=?,size_bytes=? WHERE id=?",[a.objectId,JSON.stringify(a),a.sha256,a.sizeBytes,id]);
 await dispatchStorageJob(workshop,config,id);
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){const job=await pollStorageJob(workshop,config,id);if(job.status==='verified'){const row=workshop.db.query('SELECT read_base64 FROM storage_jobs WHERE id=?').get(id) as any;return Buffer.from(row.read_base64,'base64').toString('utf8');}await new Promise(r=>setTimeout(r,200));}
 demand(false,503,'Private Tower preview read is pending; retry shortly');
}
// Server relays only an exact host-signed setup operation; no host or app key enters this process.
// Reuse is tied to the installation and exact native destination. The original
// actor is audit evidence; the current actor must separately prove fresh access
// to the same workspace before that durable app grant can be reused.
// Stored signatures are never reused as credentials; a new probe checks live authority.
export function reusableStorageGrant(workshop:Workshop,config:StorageConfig,target:StorageTarget,actor:string){
 const connection=workshop.db.query('SELECT * FROM storage_connections WHERE actor=?').get(actor) as any;
 if(!connection||connection.tower_origin!==target.towerUrl||now()-connection.connected_at>=900)return;
 let workspaces:any[];try{workspaces=JSON.parse(connection.workspaces_json);}catch{return;}
 if(!Array.isArray(workspaces)||!workspaces.some(w=>w.identity?.workspace_id===target.workspaceId&&w.identity?.workspace_owner_npub===target.workspaceOwnerNpub))return;
 const rows=workshop.db.query('SELECT g.*,b.status,b.namespace_json FROM tower_storage_grants g JOIN workshop_storage_bindings b ON b.workshop_id=g.workshop_id UNION ALL SELECT g.*,b.status,b.namespace_json FROM tower_storage_grants g JOIN storage_binding b ON b.workshop_id=g.workshop_id').all() as any[];
 return rows.find(g=>{
  if(g.installation_id!==config.installationId||g.target_json!==JSON.stringify(target)||g.status!=='ready'||!g.namespace_json)return false;
  const n=JSON.parse(g.namespace_json);if(n.workspace_owner_npub!==target.workspaceOwnerNpub||n.app_npub!==target.appNpub)return false;
  const namespace=workshop.db.query('SELECT * FROM tower_setup_operations WHERE event_id=?').get(g.namespace_event) as any,invite=workshop.db.query('SELECT * FROM tower_setup_operations WHERE event_id=?').get(g.invite_event) as any;
  const legacyNamespace=namespace?.url===`${target.towerUrl}/api/v4/workspaces/${target.workspaceOwnerNpub}/apps`&&namespace.payload===JSON.stringify({app_npub:config.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true});
  const managedNamespace=namespace?.url===`managed-wapp-installation:${config.installationId}`&&namespace.payload===JSON.stringify(target);
  return (legacyNamespace||managedNamespace)&&invite?.url===`${target.towerUrl}/api/v4/flightdeck-pg/workspaces/${target.workspaceId}/invites`&&invite.payload===JSON.stringify({invitee_npub:config.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'});
 });
}
export async function towerSetup(workshop:Workshop,config:StorageConfig,member:Member,body:any){
 const db=workshop.db,base=config.towerOrigin;
 if(body.operation==='create'){return createTowerWorkspace(workshop,config,member,body);}
 if(body.operation==='connect'){
  const url=base+'/api/v4/flightdeck-pg/workspaces';verifyForwarded(body.event,member.pubkey,url,'GET');
  const r=await fetch(url,{headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(body.event)).toString('base64')},redirect:'error',signal:AbortSignal.timeout(15000)});demand(r.ok,r.status,'Tower sign-in failed');const result=await r.json();
  db.run('INSERT INTO storage_connections VALUES(?,?,?,?) ON CONFLICT(actor) DO UPDATE SET tower_origin=excluded.tower_origin,workspaces_json=excluded.workspaces_json,connected_at=excluded.connected_at',[member.pubkey,base,JSON.stringify(result.workspaces),now()]);return {workspaces:result.workspaces};
 }
 demand(body.operation==='bind',400,'Unknown Tower setup operation');
 const connection=db.query('SELECT * FROM storage_connections WHERE actor=?').get(member.pubkey) as any;
 demand(connection&&connection.tower_origin===base&&now()-connection.connected_at<900,403,'Connect to Tower before selecting a workspace');
 const selected=JSON.parse(connection.workspaces_json).find((w:any)=>w.identity?.workspace_id===body.workspaceId);
 demand(selected&&uuid.test(body.workspaceId),403,'Workspace was not in the authorized Tower list');
 const target=storageTarget({towerUrl:base,workspaceId:body.workspaceId,workspaceOwnerNpub:selected.identity.workspace_owner_npub,appNpub:config.appNpub});
 demand(body.localRoot===config.localRoot&&resolve(body.localRoot)===body.localRoot,400,'Local root must match the installation-configured absolute Napplet root');ensureBuilderDirectory(body.localRoot);
 const previous=storageBinding(workshop,config);
 demand(!previous||JSON.stringify(previous.target)===JSON.stringify(target),409,'Storage target is already bound; migrate existing remote versions before changing workspace');

 const reuse=body.reuse?reusableStorageGrant(workshop,config,target,member.pubkey):null;
 if(body.reuse)demand(reuse,409,'This exact connection needs authorization. Review and sign access again.');
 if(reuse){
  demand(!db.query("SELECT r.id FROM requests r JOIN projects p ON p.id=r.project_id WHERE p.workshop_id=? AND r.status IN ('dispatching','building','storage_pending','execution_uncertain') LIMIT 1").get(workshop.id),409,'A Canvas build is active or uncertain; reconcile it before checking storage');
  if(previous?.status==='probing'){await pollStorageJob(workshop,config,previous.probe_job_id);return storageStatus(workshop,config);}
  db.run('INSERT INTO tower_storage_grants VALUES(?,?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET actor=excluded.actor,namespace_event=excluded.namespace_event,invite_event=excluded.invite_event,authorized_at=excluded.authorized_at',[workshop.id,config.installationId,JSON.stringify(target),member.pubkey,reuse.namespace_event,reuse.invite_event,now()]);
 }else{
 const data={invitee_npub:config.appNpub,role:'guest',kind:'app',display_name:'BYO Freedom private storage'};
 const url=`${base}/api/v4/flightdeck-pg/workspaces/${target.workspaceId}/invites`;
 verifyForwarded(body.event,member.pubkey,url,'POST',JSON.stringify(data));
 const namespaceUrl=`${base}/api/v4/workspaces/${target.workspaceOwnerNpub}/apps`,namespaceData={app_npub:config.appNpub,app_name:'BYO Freedom',capabilities:['wapp','app-db'],enabled:true};
 const managedBinding=canvasBrokerBindingStatus({installationId:config.installationId,target,canvasId:workshop.id,user:member.pubkey});
 if(body.namespaceEvent)verifyForwarded(body.namespaceEvent,member.pubkey,namespaceUrl,'POST',JSON.stringify(namespaceData));
 else demand(managedBinding.code==='exact_match',400,'App namespace authorization is required because this destination is not the exact managed WApp binding');
 const managedNamespaceEvent=sha256(`managed-wapp-installation:${config.installationId}:${JSON.stringify(target)}`),namespaceEventId=body.namespaceEvent?.id??managedNamespaceEvent;
 const priorGrant=db.query('SELECT * FROM tower_storage_grants WHERE workshop_id=?').get(workshop.id) as any;
 if(previous?.status==='ready'&&previous.namespace_json&&(!body.reconnect||(priorGrant?.invite_event===body.event.id&&priorGrant?.namespace_event===namespaceEventId)))return storageStatus(workshop,config);
 if(previous&&previous.status==='probing'){
  const job=await pollStorageJob(workshop,config,previous.probe_job_id);const row=db.query('SELECT run_id FROM storage_jobs WHERE id=?').get(job.jobId) as any;
  if(job.status!=='verified'&&!row.run_id)await dispatchStorageJob(workshop,config,job.jobId);
  return storageStatus(workshop,config);
 }
 demand(!db.query("SELECT r.id FROM requests r JOIN projects p ON p.id=r.project_id WHERE p.workshop_id=? AND r.status IN ('dispatching','building','storage_pending','execution_uncertain') LIMIT 1").get(workshop.id),409,'A workshop build is active or uncertain; reconcile it before reconnecting storage');
 // Persist exact successful native operations, not short-lived NIP-98 credentials.
 // A replay may reconcile that operation but cannot change its destination/payload.
 const relay=async(event:any,url:string,data:any)=>{
  const payload=JSON.stringify(data),prior=db.query('SELECT * FROM tower_setup_operations WHERE event_id=?').get(event.id) as any;
  if(prior){demand(prior.url===url&&prior.payload===payload,409,'Tower authorization replay conflict');return JSON.parse(prior.result_json);}
  const response=await fetch(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),'content-type':'application/json'},body:payload,redirect:'error',signal:AbortSignal.timeout(15000)});
  demand(response.ok,response.status,url===namespaceUrl?'Tower owner authorization is required for BYO Freedom app namespace':'Tower workspace storage authority was not granted');
  const result=await response.json();db.run('INSERT OR IGNORE INTO tower_setup_operations VALUES(?,?,?,?)',[event.id,url,payload,JSON.stringify(result)]);return result;
 };
 const established=(db.query('SELECT target_json,status,namespace_json FROM storage_binding UNION ALL SELECT target_json,status,namespace_json FROM workshop_storage_bindings').all() as any[]).filter(row=>{if(row.status!=='ready'||!row.namespace_json)return false;const t=storageTarget(JSON.parse(row.target_json)),n=JSON.parse(row.namespace_json);return t.towerUrl===target.towerUrl&&t.appNpub===target.appNpub&&t.workspaceOwnerNpub===target.workspaceOwnerNpub&&n.workspace_owner_npub===target.workspaceOwnerNpub&&n.app_npub===target.appNpub;});
 if(body.namespaceEvent&&(body.reconnect||!established.length))await relay(body.namespaceEvent,namespaceUrl,namespaceData);
 if(!body.namespaceEvent)db.run('INSERT OR IGNORE INTO tower_setup_operations VALUES(?,?,?,?)',[namespaceEventId,`managed-wapp-installation:${config.installationId}`,JSON.stringify(target),JSON.stringify({binding:managedBinding})]);
 const granted=await relay(body.event,url,data);
 demand(granted.identity?.workspace_owner_npub===target.workspaceOwnerNpub&&(!granted.identity?.workspace_id||granted.identity.workspace_id===target.workspaceId),409,'Workspace owner binding mismatch');
 db.run('INSERT INTO tower_storage_grants VALUES(?,?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET actor=excluded.actor,namespace_event=excluded.namespace_event,invite_event=excluded.invite_event,authorized_at=excluded.authorized_at',[workshop.id,config.installationId,JSON.stringify(target),member.pubkey,namespaceEventId,body.event.id,now()]);
 }
 const id=createStorageJob(workshop,'probe',target,`byo-storage-probe-${config.installationId}.html`,Buffer.from('<!doctype html><html><body>Private BYO Freedom storage readiness probe</body></html>'));
 if(workshop.legacy)db.run('INSERT INTO storage_binding(id,installation_id,workshop_id,target_json,local_root,status,probe_job_id,connected_actor) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,probe_job_id=excluded.probe_job_id',[config.installationId,config.workshopId,JSON.stringify(target),config.localRoot,'probing',id,member.pubkey]);
 else db.run('INSERT INTO workshop_storage_bindings(workshop_id,installation_id,target_json,local_root,status,probe_job_id,connected_actor) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET status=excluded.status,probe_job_id=excluded.probe_job_id',[config.workshopId,config.installationId,JSON.stringify(target),config.localRoot,'probing',id,member.pubkey]);
 await dispatchStorageJob(workshop,config,id);return storageStatus(workshop,config);
}
export function verifyForwarded(event:any,pubkey:string,url:string,method:string,body?:string,freshContent=false){
 const rows=(name:string)=>event?.tags?.filter((t:string[])=>t[0]===name);
 const tag=(name:string)=>rows(name)?.length===1&&rows(name)[0].length===2?rows(name)[0][1]:undefined;
 demand(event&&verifyEvent(event)&&event.pubkey===pubkey&&event.kind===27235&&(event.content===''||(freshContent&&uuid.test(event.content)))&&Math.abs(event.created_at-now())<=60&&tag('u')===url&&tag('method')===method&&(body?tag('payload')===sha256(body):tag('payload')===undefined),401,'Tower setup signature does not match the selected operation');
}

export async function createTowerWorkspace(workshop:Workshop,config:StorageConfig,member:Member,body:any){
 demand(config.signupGatewayOrigin,503,'Configure an approved hosted workspace signup gateway to enable creation');
 const gateway=new URL(config.signupGatewayOrigin);demand(gateway.protocol==='https:'&&gateway.origin===config.signupGatewayOrigin,503,'Invalid configured signup gateway');
 const name=String(body.workspaceName||'').trim();demand(name.length>0&&name.length<=80&&uuid.test(body.idempotencyKey),400,'Workspace name and persistent creation intent required');
 const payload=JSON.stringify({workspace_name:name,idempotency_key:body.idempotencyKey,terms_version:'hosted-usd-v1'});
 verifyForwarded(body.event,member.pubkey,config.towerOrigin+'/api/v4/flightdeck-pg/hosted/workspaces','POST',payload,true);
 const readiness=await fetch(gateway.origin+'/api/hosted/config',{redirect:'error',signal:AbortSignal.timeout(10000)}),status=await readiness.json();
 demand(readiness.ok&&status.signup_ready===true&&new URL(status.tower_public_base_url).origin===config.towerOrigin,503,'Workspace creation unavailable: approved signup gateway reports signup_ready=false or mismatched Tower. Shared signup activation is required.');
 const r=await fetch(gateway.origin+'/api/hosted/workspaces',{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(body.event)).toString('base64'),'content-type':'application/json'},body:payload,redirect:'error',signal:AbortSignal.timeout(15000)}),created=await r.json();
 demand(r.ok,r.status,'Tower workspace creation failed: '+String(created.code||created.error||r.status));
 demand(uuid.test(created.workspace_id)&&created.descriptor?.identity?.workspace_owner_npub=== (await import('nostr-tools')).nip19.npubEncode(member.pubkey),502,'Created workspace owner mismatch');
 // Selection/binding remains an explicit separate admin action; never automatically move the installation.
 return created;
}
