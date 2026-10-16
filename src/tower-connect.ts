import { nip19 } from 'nostr-tools';
import { sha256 } from './assets.ts';
import { demand, text } from './errors.ts';
import type { Member } from './auth.ts';
import { now } from './auth.ts';
import type { Site } from './site.ts';
import { Workshop } from './workshop.ts';
import { storageStatus, towerSetup, verifyForwarded, reusableStorageGrant } from './storage.ts';
import { storageTarget, uuid } from './tower-storage-client.ts';

export function installTowerConnect(site: Site) {
 site.db.exec(`CREATE TABLE IF NOT EXISTS tower_create_intents(actor TEXT NOT NULL,tower_id TEXT NOT NULL,intent_id TEXT NOT NULL,payload TEXT NOT NULL,result_json TEXT,PRIMARY KEY(actor,tower_id,intent_id));
 CREATE TABLE IF NOT EXISTS managed_workshop_storage(workshop_id TEXT PRIMARY KEY REFERENCES workshops(id),tower_id TEXT NOT NULL REFERENCES towers(id),config_json TEXT);`);
 const cols=site.db.query('PRAGMA table_info(managed_workshop_storage)').all() as {name:string}[];if(!cols.some(c=>c.name==='config_json'))site.db.exec('ALTER TABLE managed_workshop_storage ADD COLUMN config_json TEXT');
}
export class TowerConnect {
 private binds=new Map<string,Promise<unknown>>();
 constructor(private site: Site, private assets: Workshop['assets']) { installTowerConnect(site); }
 private context(member: Member, towerId: string, workshopId: string) {
  this.site.admin(member);
  const tower=this.site.db.query('SELECT * FROM towers WHERE id=?').get(towerId) as any;
  demand(tower,404,'Tower not found');
  const row=this.site.db.query('SELECT * FROM workshops WHERE id=?').get(workshopId) as any;
  demand(row,404,'Workshop not found');
  demand(row.tower_id===towerId,409,'Select this Tower for the workshop before connecting');
  const config=this.site.storage(workshopId);
  demand(config,503,'Managed app execution is unavailable. The site operator must configure the installation-wide storage worker.');
  return {tower,config,workshop:new Workshop(this.site.db, this.assets, workshopId)};
 }
 private selection(member:Member,towerId:string,workshopId:string){
  this.site.admin(member);
  const tower=this.site.db.query('SELECT * FROM towers WHERE id=?').get(towerId) as any;
  demand(tower,404,'Tower not found');
  const row=this.site.db.query('SELECT * FROM workshops WHERE id=?').get(workshopId) as any;
  demand(row,404,'Workshop not found');
  const pinned=this.site.db.query('SELECT workshop_id FROM managed_workshop_storage WHERE workshop_id=?').get(workshopId)
   || this.site.db.query('SELECT workshop_id FROM workshop_storage_bindings WHERE workshop_id=?').get(workshopId)
   || this.site.db.query('SELECT workshop_id FROM storage_binding WHERE workshop_id=?').get(workshopId)
   || this.site.storage(workshopId);
  return {tower,locked:row.tower_id!==towerId&&!!pinned};
 }
 async connect(member:Member,towerId:string,workshopId:string,body:any){
  this.selection(member,towerId,workshopId);
  const result=await this.site.connect(member,towerId,body,false);
  // Recheck after remote authorization: another request may have pinned storage.
  return this.site.db.transaction(()=>{
   const {tower,locked}=this.selection(member,towerId,workshopId);
   if(!locked)this.site.db.run('UPDATE workshops SET tower_id=? WHERE id=?',[towerId,workshopId]);
   const config=locked?undefined:this.site.storage(workshopId),workshop=new Workshop(this.site.db,this.assets,workshopId);
   const storage=locked?{configured:false,otherTower:true}:storageStatus(workshop,config);
   this.site.db.run('INSERT INTO tower_accounts VALUES(?,?,?,?) ON CONFLICT(connection_id,actor) DO UPDATE SET workspaces_json=excluded.workspaces_json,connected_at=excluded.connected_at',[towerId,member.pubkey,JSON.stringify(result.workspaces),now()]);
   if(!locked)this.site.db.run('INSERT INTO storage_connections VALUES(?,?,?,?) ON CONFLICT(actor) DO UPDATE SET tower_origin=excluded.tower_origin,workspaces_json=excluded.workspaces_json,connected_at=excluded.connected_at',[member.pubkey,tower.origin,JSON.stringify(result.workspaces),now()]);
   const reusable=config?result.workspaces.filter((w:any)=>{try{return !!reusableStorageGrant(workshop,config,storageTarget({towerUrl:tower.origin,workspaceId:w.identity.workspace_id,workspaceOwnerNpub:w.identity.workspace_owner_npub,appNpub:config.appNpub}),member.pubkey);}catch{return false;}}).map((w:any)=>w.identity.workspace_id):[];
   return {...result,storage,reusable};
  })();
 }

 intent(member:Member,towerId:string,workshopId:string,body:any){
  const {tower,config}=this.context(member,towerId,workshopId);
  const name=text(body.workspaceName,'Workspace name',80);demand(uuid.test(body.idempotencyKey),400,'A persistent creation intent is required');
  const payload=JSON.stringify({creator_npub:nip19.npubEncode(member.pubkey),workspace_name:name,app_npub:config.appNpub,workspace_service_npub:nip19.npubEncode(sha256(`${config.installationId}:${member.pubkey}:${towerId}:${body.idempotencyKey}`))});
  const prior=this.site.db.query('SELECT * FROM tower_create_intents WHERE actor=? AND tower_id=? AND intent_id=?').get(member.pubkey,towerId,body.idempotencyKey) as any;
  demand(!prior||prior.payload===payload,409,'Creation intent changed; start a new workspace request');
  this.site.db.run('INSERT OR IGNORE INTO tower_create_intents VALUES(?,?,?,?,NULL)',[member.pubkey,towerId,body.idempotencyKey,payload]);
  return {url:tower.origin+'/api/v4/admin/flightdeck-pg/workspaces',payload:JSON.parse(payload)};
 }
 async create(member:Member,towerId:string,workshopId:string,body:any){
  const prepared=this.intent(member,towerId,workshopId,body),payload=JSON.stringify(prepared.payload);
  verifyForwarded(body.event,member.pubkey,prepared.url,'POST',payload);
  const prior=this.site.db.query('SELECT result_json FROM tower_create_intents WHERE actor=? AND tower_id=? AND intent_id=?').get(member.pubkey,towerId,body.idempotencyKey) as any;
  if(prior.result_json)return JSON.parse(prior.result_json);
  const response=await fetch(prepared.url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(body.event)).toString('base64'),'content-type':'application/json'},body:payload,redirect:'error',signal:AbortSignal.timeout(20000)});
  const result=await response.json();demand(response.ok,response.status,'Tower could not create the workspace: '+String(result.error||result.code||response.status));
  demand(uuid.test(result.workspace_id)&&result.descriptor?.identity?.workspace_id===result.workspace_id&&result.descriptor.identity.workspace_owner_npub===prepared.payload.creator_npub&&result.descriptor.identity.app_npub===prepared.payload.app_npub,502,'Created workspace identity mismatch');
  this.site.db.run('UPDATE tower_create_intents SET result_json=? WHERE actor=? AND tower_id=? AND intent_id=?',[JSON.stringify(result),member.pubkey,towerId,body.idempotencyKey]);
  return result;
 }
 async bind(member:Member,towerId:string,workshopId:string,body:any){
  const {config,workshop}=this.context(member,towerId,workshopId);
  const previous=this.binds.get(workshopId)||Promise.resolve();
  const pending=previous.catch(()=>{}).then(()=>towerSetup(workshop,config,member,{...body,operation:'bind',localRoot:config.localRoot}));this.binds.set(workshopId,pending);
  try{return await pending;}finally{if(this.binds.get(workshopId)===pending)this.binds.delete(workshopId);} 
 }
}
