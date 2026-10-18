import { sha256 } from './assets.ts';
import { limits } from './config.ts';
export const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type StorageTarget={towerUrl:string;workspaceId:string;workspaceOwnerNpub:string;appNpub:string};
export type StorageTransport=(url:string,method:string,body?:unknown)=>Promise<Response>;
export type StoredArtifact={objectId:string;workspaceId:string;towerUrl:string;contentUrl:string;sha256:string;sizeBytes:number;isPublic:false};
const attachmentContentTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function storedContentLimit(contentType:string){return attachmentContentTypes.has(contentType)?limits.attachmentBytes:contentType==='text/html'?limits.sourceBytes:0;}
async function boundedBytes(response:Response,limit:number){
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let total=0;
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>limit)throw Error('storage_read_size_denied');chunks.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
export function storageTarget(value:any):StorageTarget {
  const url=new URL(value.towerUrl);
  if(url.protocol!=='https:' || url.origin!==value.towerUrl || !uuid.test(value.workspaceId) || !/^npub1[0-9a-z]{58}$/.test(value.workspaceOwnerNpub) || !/^npub1[0-9a-z]{58}$/.test(value.appNpub))throw Error('storage_target_invalid');
  return {towerUrl:url.origin,workspaceId:value.workspaceId,workspaceOwnerNpub:value.workspaceOwnerNpub,appNpub:value.appNpub};
}
export class TowerStorageClient {
  readonly target:StorageTarget;
  constructor(target:StorageTarget,private request:StorageTransport){this.target=storageTarget(target);}
  private url(path:string){return this.target.towerUrl+path;}
  async metadata(objectId:string){if(!uuid.test(objectId))throw Error('storage_object_invalid');return this.json('/api/v4/storage/'+objectId,'GET');}
  async json(path:string,method:string,body?:unknown){const r=await this.request(this.url(path),method,body);if(!r.ok)throw Error('tower_storage_http_'+r.status);return r.json();}
  async prepare(fileName:string,bytes:Uint8Array,contentType='text/html'){
    const purpose=contentType==='text/html'?'byo-napplet/version':'byo-chat/attachment';
    const result=await this.json(`/api/v4/flightdeck-pg/workspaces/${this.target.workspaceId}/storage/prepare`,'POST',{file_name:fileName,content_type:contentType,size_bytes:bytes.length,is_public:false,metadata:{purpose}});
    if(!uuid.test(result.object_id)||result.is_public!==false||result.owner_npub!==this.target.workspaceOwnerNpub||result.identity?.workspace_id!==this.target.workspaceId)throw Error('storage_prepare_invalid');
    return result.object_id as string;
  }
  assertMetadata(metadata:any,objectId:string,fileName:string,contentType='text/html'){
    if(metadata.object_id!==objectId||metadata.owner_npub!==this.target.workspaceOwnerNpub||metadata.created_by_npub!==this.target.appNpub||metadata.owner_group_id!==null||metadata.access_group_ids?.length!==0||metadata.file_name!==fileName||metadata.is_public!==false||metadata.content_type!==contentType)throw Error('storage_object_binding_denied');
  }
  async readAndVerify(objectId:string,fileName:string,hash:string,size:number,contentType='text/html'){
    const metadata=await this.metadata(objectId);this.assertMetadata(metadata,objectId,fileName,contentType);
    if(!metadata.completed_at||metadata.sha256_hex!==hash||Number(metadata.size_bytes)!==size)throw Error('storage_metadata_hash_mismatch');
    const limit=storedContentLimit(contentType);if(!limit||!Number.isSafeInteger(size)||size<1||size>limit)throw Error('storage_read_size_denied');
    const response=await this.request(this.url('/api/v4/storage/'+objectId+'/content'),'GET');
    if(!response.ok)throw Error('tower_storage_read_http_'+response.status);
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==size))throw Error('storage_read_length_mismatch');
    const bytes=await boundedBytes(response,Math.min(limit,size));
    if(bytes.length!==size||sha256(bytes)!==hash)throw Error('storage_readback_mismatch');
    return bytes;
  }
  async uploadAndVerify(objectId:string,fileName:string,bytes:Uint8Array,contentType='text/html'):Promise<{artifact:StoredArtifact;bytes:Uint8Array}> {
    const before=await this.metadata(objectId);this.assertMetadata(before,objectId,fileName,contentType);
    if(!before.completed_at){
      await this.json('/api/v4/storage/'+objectId,'PUT',{base64_data:Buffer.from(bytes).toString('base64')});
      await this.json('/api/v4/storage/'+objectId+'/complete','POST',{sha256_hex:sha256(bytes)});
    }
    const hash=sha256(bytes),downloaded=await this.readAndVerify(objectId,fileName,hash,bytes.length,contentType);
    if(!Buffer.from(downloaded).equals(Buffer.from(bytes)))throw Error('storage_readback_mismatch');
    return {artifact:{objectId,workspaceId:this.target.workspaceId,towerUrl:this.target.towerUrl,contentUrl:this.url('/api/v4/storage/'+objectId+'/content'),sha256:hash,sizeBytes:bytes.length,isPublic:false},bytes:downloaded};
  }
}
