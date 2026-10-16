import {sha256} from './assets.ts';
import type {StorageTarget,StorageTransport} from './tower-storage-client.ts';
export const namespaceMigrationSql='CREATE TABLE napplet_storage_receipts (id text PRIMARY KEY, workspace_id text NOT NULL, installation_id text NOT NULL, project_id text NOT NULL, version integer NOT NULL, object_id text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL);';
export const namespaceMigration={migrations:[{version:'001_napplet_storage_receipts',checksum:"sha256:"+sha256(namespaceMigrationSql),sql:namespaceMigrationSql}]};
export class TowerNamespaceClient{
 readonly base:string;
 constructor(readonly target:StorageTarget,private request:StorageTransport){this.base=`${target.towerUrl}/api/v4/workspaces/${target.workspaceOwnerNpub}/apps/${target.appNpub}/db`;}
 private async json(path:string,method:string,body?:unknown){const r=await this.request(this.base+path,method,body);if(!r.ok){const error=await r.json().catch(()=>({}));throw Error('tower_namespace_http_'+r.status+':'+String(error.code||'unknown'));}return r.json();}
 async ensure(){
  const descriptor=await this.json('/provision','POST',{app_slug:'byo_freedom'});
  if(descriptor.workspace_owner_npub!==this.target.workspaceOwnerNpub||descriptor.app_npub!==this.target.appNpub||!/^wapp_byo_freedom_[a-f0-9]+$/.test(descriptor.schema_name))throw Error('namespace_binding_denied');
  await this.json('/migrations','POST',namespaceMigration);return descriptor;
 }
 async receipt(data:any){
  const path='/tables/napplet_storage_receipts/rows/'+data.id;
  let r=await this.request(this.base+path,'GET');
  const initial=r.ok?await r.clone().json():null;
  if(r.status===404||initial?.row===null){r=await this.request(this.base+'/tables/napplet_storage_receipts/rows','POST',{id:data.id,data});if(!r.ok&&r.status!==409)throw Error('namespace_receipt_write_'+r.status);r=await this.request(this.base+path,'GET');}
  if(!r.ok)throw Error('namespace_receipt_read_'+r.status);
  const result=await r.json(),row=result.row??result.data??result;
  if(Object.keys(data).some(k=>String(row[k])!==String(data[k])))throw Error('namespace_receipt_mismatch');return row;
 }
}
