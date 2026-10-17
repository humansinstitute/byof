import { demand, HttpError } from './errors.ts';
import { sha256 } from './assets.ts';
import type { StorageTarget, StorageTransport } from './tower-storage-client.ts';
export const canvasDatasetLimits={datasets:64,keys:128,valueBytes:32768,quotaBytes:4194304,descriptionChars:1000,fields:64};
// New table leaves the historical unshipped receipt-era table untouched. Tower v1 accepts CREATE only.
export const canvasDataSql=`CREATE TABLE canvas_dataset_records (id text PRIMARY KEY, installation_id text NOT NULL, workspace_id text NOT NULL, canvas_id text NOT NULL, dataset text NOT NULL, visibility text NOT NULL CHECK (visibility IN ('shared','private')), owner_pubkey text NOT NULL, record_key text NOT NULL, slot integer NOT NULL CHECK (slot BETWEEN -1 AND 127), schema_slot integer, deleted boolean NOT NULL DEFAULT false, data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND octet_length(data::text)<=65536), version integer NOT NULL CHECK (version > 0), updated_by text NOT NULL, updated_at text NOT NULL, UNIQUE (installation_id,workspace_id,canvas_id,dataset,visibility,owner_pubkey,slot), UNIQUE (installation_id,workspace_id,canvas_id,visibility,owner_pubkey,schema_slot), CHECK ((visibility='shared' AND owner_pubkey='') OR (visibility='private' AND length(owner_pubkey)=64)), CHECK ((record_key='__schema__' AND slot=-1 AND schema_slot IS NOT NULL AND schema_slot BETWEEN 0 AND 63 AND octet_length(data::text)<=4096) OR (record_key<>'__schema__' AND slot>=0 AND schema_slot IS NULL)));`;
export const canvasDataMigration={migrations:[{version:'003_canvas_dataset_records',checksum:'sha256:'+sha256(canvasDataSql),sql:canvasDataSql}]};
export const canvasDatasetProvision={app_slug:'byo_freedom_datasets'};
export type DatasetScope={installationId:string;target:StorageTarget;canvasId:string;user:string};
export type DatasetBinding={name:string;visibility:'shared'|'private'};
export function datasetBinding(input:any):DatasetBinding {
 demand(input&&Object.keys(input).every(k=>['name','visibility','description','fields'].includes(k)),400,'Unexpected dataset binding field');
 demand(typeof input.name==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(input.name)&&['shared','private'].includes(input.visibility),400,'Dataset name and shared/private visibility required');
 return {name:input.name,visibility:input.visibility};
}
export function datasetDescription(input:any){
 demand(typeof input.description==='string'&&input.description.trim().length>0&&input.description.length<=1000,400,'Dataset description required (1–1000 characters)');
 demand(input.fields&&typeof input.fields==='object'&&!Array.isArray(input.fields)&&Object.keys(input.fields).length>0&&Object.keys(input.fields).length<=64,400,'Supply 1–64 field descriptions');
 for(const [name,description] of Object.entries(input.fields))demand(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)&&typeof description==='string'&&description.trim().length>0&&description.length<=200,400,'Invalid field description');
 const value={description:input.description.trim(),fields:Object.fromEntries(Object.entries(input.fields).sort(([a],[b])=>a.localeCompare(b)))};demand(Buffer.byteLength(JSON.stringify(value))<=2048,413,'Schema description exceeds 2 KiB');return value;
}
function sameDescription(a:any,b:any){return a?.description===b?.description&&JSON.stringify(Object.entries(a?.fields??{}).sort(([a],[b])=>a.localeCompare(b)))===JSON.stringify(Object.entries(b?.fields??{}).sort(([a],[b])=>a.localeCompare(b)));}
export class CanvasDatasetStore {
 readonly base:string;
 constructor(readonly scope:DatasetScope,private request:StorageTransport){this.base=`${scope.target.towerUrl}/api/v4/workspaces/${scope.target.workspaceOwnerNpub}/apps/${scope.target.appNpub}/db`;}
 private async json(path:string,method:string,body?:unknown){const r=await this.request(this.base+path,method,body);if(!r.ok){await r.body?.cancel();throw new HttpError(r.status,r.status===409?'Dataset changed; fetch current data before saving':'Tower dataset request failed ('+r.status+')');}return r.json();}
 async requireAtomic(){const descriptor=await this.json('/descriptor','GET');demand(descriptor.capabilities?.conditional_update===true,503,'Tower atomic dataset updates are not deployed; Canvas data is unavailable');return descriptor;}
 async ensure(){const provision=await this.json('/provision','POST',canvasDatasetProvision),descriptor=await this.requireAtomic(),migrations=await this.json('/migrations','POST',canvasDataMigration);return {provision,descriptor,migrations};}
 async prove(){const readiness=await this.ensure(),datasets=await this.discovery();return {...readiness,datasets};}
 private where(binding?:DatasetBinding){return {installation_id:{eq:this.scope.installationId},workspace_id:{eq:this.scope.target.workspaceId},canvas_id:{eq:this.scope.canvasId},...(binding?{dataset:{eq:binding.name},visibility:{eq:binding.visibility},owner_pubkey:{eq:binding.visibility==='private'?this.scope.user:''}}:{visibility:{eq:'shared'},owner_pubkey:{eq:''}})};}
 private id(binding:DatasetBinding,key:string){return sha256(JSON.stringify([this.scope.installationId,this.scope.target.workspaceId,this.scope.canvasId,binding.name,binding.visibility,binding.visibility==='private'?this.scope.user:'',key]));}
 async discovery(){const result=await this.json('/tables/canvas_dataset_records/query','POST',{where:{...this.where(),record_key:{eq:'__schema__'}},select:['dataset','data','version'],order:[{field:'dataset'}],limit:65});demand(result.rows.length<=64,413,'Canvas has too many datasets for discovery');return result.rows.map((r:any)=>({name:r.dataset,visibility:'shared',...r.data,version:r.version}));}
 async list(binding:DatasetBinding){const result=await this.json('/tables/canvas_dataset_records/query','POST',{where:this.where(binding),limit:129,order:[{field:'slot'}]});demand(result.rows.length<=129,502,'Dataset exceeds host limits');return result.rows;}
 async versions(binding:DatasetBinding){const result=await this.json('/tables/canvas_dataset_records/query','POST',{where:this.where(binding),select:['id','version'],limit:129,order:[{field:'slot'}]});return result.rows;}
 async open(input:any){const binding=datasetBinding(input),result=await this.json('/tables/canvas_dataset_records/query','POST',{where:{...this.where(binding),record_key:{eq:'__schema__'}},limit:1}),schema=result.rows[0];
 if(schema){if(input.description!==undefined||input.fields!==undefined)demand(sameDescription(schema.data,datasetDescription(input)),409,'Dataset schema conflicts with existing description; reuse it or explain the conflict');return {binding,schema:schema.data};}
 const description=datasetDescription(input);
 // Unique schema slots enforce the limit atomically, independently for shared and each private owner.
 const allocationScope=Object.fromEntries(Object.entries(this.where(binding)).filter(([k])=>k!=='dataset'));
 const allocated=await this.json('/tables/canvas_dataset_records/query','POST',{where:{...allocationScope,record_key:{eq:'__schema__'}},select:['schema_slot'],limit:64});
 const occupied=new Set(allocated.rows.map((r:any)=>r.schema_slot));
 for(let slot=0;slot<64;slot++){if(occupied.has(slot))continue;try{await this.insert(binding,'__schema__',-1,description,slot);return {binding,schema:description};}catch(e){
 if(!(e instanceof HttpError)||e.status!==409)throw e;
 const existing=(await this.list(binding)).find((r:any)=>r.record_key==='__schema__');
 if(existing){demand(sameDescription(existing.data,description),409,'Dataset schema conflicts with existing description');return {binding,schema:existing.data};}
 }}
 demand(false,413,'Canvas dataset limit reached for this visibility/owner');throw Error('unreachable');}
 private async insert(binding:DatasetBinding,key:string,slot:number,data:any,schemaSlot:number|null=null){return this.json('/tables/canvas_dataset_records/rows','POST',{id:this.id(binding,key),data:{installation_id:this.scope.installationId,workspace_id:this.scope.target.workspaceId,canvas_id:this.scope.canvasId,dataset:binding.name,visibility:binding.visibility,owner_pubkey:binding.visibility==='private'?this.scope.user:'',record_key:key,slot,schema_slot:schemaSlot,deleted:false,data,version:1,updated_by:this.scope.user,updated_at:new Date().toISOString()}});}
 async get(binding:DatasetBinding,key:string){this.key(key);const result=await this.json('/tables/canvas_dataset_records/query','POST',{where:{...this.where(binding),record_key:{eq:key}},limit:1});const row=result.rows[0];return row?{key,value:row.deleted?null:row.data,version:row.version,updatedBy:row.updated_by,updatedAt:row.updated_at}:{key,value:null,version:0};}
 records(rows:any[]){return rows.filter(r=>r.record_key!=='__schema__'&&!r.deleted).map(r=>({key:r.record_key,value:r.data,version:r.version,updatedBy:r.updated_by,updatedAt:r.updated_at}));}
 private key(key:any){demand(typeof key==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key)&&key!=='__schema__',400,'Invalid record key');}
 async set(binding:DatasetBinding,key:string,value:any,expectedVersion:number){await this.requireAtomic();this.key(key);demand(Number.isSafeInteger(expectedVersion)&&expectedVersion>=0&&expectedVersion<2147483647,400,'Expected version required');demand(value!==null&&typeof value==='object'&&!Array.isArray(value),400,'Dataset value must be a non-null JSON object');demand(Buffer.byteLength(JSON.stringify(value))<=32768,413,'Dataset record exceeds 32 KiB');
 if(expectedVersion===0){
 for(let attempt=0;attempt<4;attempt++){const metadata=await this.json('/tables/canvas_dataset_records/query','POST',{where:this.where(binding),select:['record_key','slot'],limit:129});const rows=metadata.rows;demand(rows.some((r:any)=>r.record_key==='__schema__'),404,'Dataset missing');demand(!rows.some((r:any)=>r.record_key===key),409,'Record already exists; read its current version');const slots=new Set(rows.map((r:any)=>r.slot));const slot=Array.from({length:128},(_,i)=>i).find(i=>!slots.has(i));demand(slot!==undefined,413,'Dataset key quota exceeded');try{const r=await this.insert(binding,key,slot,value);return this.records([r.row])[0];}catch(e){if(!(e instanceof HttpError)||e.status!==409||attempt===3)throw e;}}
 }
 const result=await this.json('/tables/canvas_dataset_records/rows/'+this.id(binding,key),'PATCH',{where:{...this.where(binding),version:{eq:expectedVersion},record_key:{eq:key}},set:{data:value,deleted:false,version:expectedVersion+1,updated_by:this.scope.user,updated_at:new Date().toISOString()}});return this.records([result.row])[0];}
 async remove(binding:DatasetBinding,key:string,expectedVersion:number){await this.requireAtomic();this.key(key);demand(Number.isSafeInteger(expectedVersion)&&expectedVersion>0&&expectedVersion<2147483647,400,'Expected version required');const result=await this.json('/tables/canvas_dataset_records/rows/'+this.id(binding,key),'PATCH',{where:{...this.where(binding),version:{eq:expectedVersion},record_key:{eq:key}},set:{data:{},deleted:true,version:expectedVersion+1,updated_by:this.scope.user,updated_at:new Date().toISOString()}});return {key,value:null,version:result.row.version,deleted:true};}
}
