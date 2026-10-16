import { canvasDataMigration } from '../canvas-datasets.ts';
import { namespaceMigration } from '../tower-namespace.ts';
import { randomUUID } from 'node:crypto';
import { publicKey } from '../config.ts';
import { sha256 } from '../assets.ts';
import { storageTarget, uuid, type StorageTarget, type StorageTransport } from '../tower-storage-client.ts';
export type ManagedStorageScope={autopilotRoot:string;installationId:string;appId:string;ownerNpub:string;appPubkey:string;appOrigin:string;appRoot:string;towerOrigin:string;workshopId:string;remoteBuilderRoot?:string;installationWorkshops?:boolean;browserAuthorizedDestinations?:boolean};
export type StorageJobAuthority={jobId:string;target:StorageTarget;objectId:string|null;fileName:string;contentType:string;sha256:string;sizeBytes:number;operation:string;namespaceReceipts?:any[];receipt?:any;destinationGrant?:any;candidate?:any};
export type PublicationAuthority={body:{requestId:string;projectId:string;candidate:any}};
export type BuilderPreparationAuthority={body:Record<string,unknown>};
/** Callback-only managed custody, used exclusively by a trusted installed pipeline function. */
export async function managedStorageTransport(scope:ManagedStorageScope,job:StorageJobAuthority|null=null,bootstrapJobId?:string,publication?:PublicationAuthority,builderPreparation?:BuilderPreparationAuthority):Promise<StorageTransport> {
  const storeModule=await import(scope.autopilotRoot+'/src/wapps/wapp-store.ts');
  const publishing=await import(scope.autopilotRoot+'/src/wapps/wapp-publishing-client.ts');
  const store=storeModule.wappStore;
  const apps=await import(scope.autopilotRoot+'/src/apps/app-registry.ts');
  const assert=async()=>{const app=await apps.appRegistry.getApp(scope.appId);const wapp=store.get(scope.installationId);if(!app||app.root!==scope.appRoot||app.ownerNpub!==scope.ownerNpub||!wapp||wapp.appId!==scope.appId||wapp.recordState!=='active'||wapp.status!=='active'||wapp.ownerNpub!==scope.ownerNpub||publicKey(wapp.appNpub)!==scope.appPubkey||new URL(wapp.launchUrl).origin!==scope.appOrigin)throw Error('storage_installation_authority_denied');};
  return async(url,method,body)=>{
    await assert();authorizeStorageHttp(scope,job,url,method,body,bootstrapJobId,publication,builderPreparation);
    const serializedBody=body===undefined?undefined:JSON.stringify(body);
    const authorization=await store.withAppSigningKey(scope.installationId,(nsec:string)=>publishing.createWappNip98Authorization({url,method,nsec,serializedBody,nonce:randomUUID()}));
    await assert();return fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization,'content-type':'application/json'},...(serializedBody?{body:serializedBody}:{})});
  };
}

export function authorizeStorageHttp(scope:ManagedStorageScope,job:StorageJobAuthority|null,url:string,method:string,body?:unknown,bootstrapJobId?:string,publication?:PublicationAuthority,builderPreparation?:BuilderPreparationAuthority){
const target=new URL(url);
    if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw Error('storage_http_target_denied');
    const api=scope.appOrigin+'/api/v1/internal/storage/';
    let allowed=!job&&((url===api+'candidates'&&method==='POST')||(uuid.test(bootstrapJobId||'')&&url===api+'jobs/'+bootstrapJobId&&method==='GET'&&body===undefined));
    if(builderPreparation)allowed ||= method==='POST'&&url===scope.appOrigin+'/api/v1/internal/builder/prepare'&&JSON.stringify(body)===JSON.stringify(builderPreparation.body);
    if(publication&&method==='POST'){
      const b=body as any,base=publication.body;
      const same=b?.requestId===base.requestId&&b?.projectId===base.projectId;
      allowed ||= same&&url===scope.appOrigin+'/api/v1/internal/publication/candidate'&&typeof b.sourceBase64==='string'&&typeof b.sourceSha256==='string'&&JSON.stringify(b)===JSON.stringify(base);
      allowed ||= same&&url===scope.appOrigin+'/api/v1/internal/publication/intent'&&JSON.stringify(b)===JSON.stringify(base);
      allowed ||= same&&url===scope.appOrigin+'/api/v1/internal/publication/failure'&&typeof b.error==='string'&&JSON.stringify({...b,error:undefined})===JSON.stringify(base);
      allowed ||= same&&url===scope.appOrigin+'/api/v1/publication/version'&&uuid.test(b.candidate?.jobId)&&b.candidate?.remoteStorage&&JSON.stringify({...b,candidate:{...b.candidate,jobId:undefined,remoteStorage:undefined}})===JSON.stringify(base);
    }
    if(job){
      const binding=storageTarget(job.target);
      if(!uuid.test(job.jobId)||binding.towerUrl!==scope.towerOrigin||publicKey(binding.appNpub)!==scope.appPubkey)throw Error('storage_job_authority_denied');
      if(url===api+'jobs/'+job.jobId){
        allowed=(method==='GET'&&body===undefined)||(method==='POST'&&['preparing','prepared','verified','read','prepare_failed','namespace','dataset','failed'].includes((body as any)?.step));
      }
      if(target.origin===binding.towerUrl){
        const namespaceBase=`/api/v4/workspaces/${binding.workspaceOwnerNpub}/apps/${binding.appNpub}/db`;
        if(job.operation!=='read'){
          allowed ||= target.pathname===namespaceBase+'/provision'&&method==='POST'&&JSON.stringify(body)===JSON.stringify({app_slug:'byo_freedom'});
          allowed ||= target.pathname===namespaceBase+'/migrations'&&method==='POST'&&JSON.stringify(body)===JSON.stringify(namespaceMigration);
          if(job.operation==='dataset'){
            const planned=job.candidate?.request;
            const path=target.pathname;
            const bounded=path===namespaceBase+'/descriptor'&&method==='GET'&&body===undefined
              || path===namespaceBase+'/migrations'&&method==='POST'&&JSON.stringify(body)===JSON.stringify(canvasDataMigration)
              || path===namespaceBase+'/tables/canvas_dataset_records/query'&&method==='POST'
              || path===namespaceBase+'/tables/canvas_dataset_records/rows'&&method==='POST'
              || new RegExp('^'+namespaceBase+'/tables/canvas_dataset_records/rows/[a-f0-9]{64}$').test(path)&&method==='PATCH';
            allowed ||= bounded&&planned?.url===url&&planned.method===method&&JSON.stringify(planned.body)===JSON.stringify(body)&&Buffer.byteLength(JSON.stringify(body)??'')<=40000;
          }
          const receipts=job.operation==='namespace'?job.namespaceReceipts??[]:job.receipt?[job.receipt]:[];
          allowed ||= target.pathname===namespaceBase+'/tables/napplet_storage_receipts/rows'&&method==='POST'&&receipts.some(r=>JSON.stringify(body)===JSON.stringify({id:r.id,data:r}));
          allowed ||= method==='GET'&&body===undefined&&receipts.some(r=>target.pathname===namespaceBase+'/tables/napplet_storage_receipts/rows/'+r.id);
        }
        if(target.pathname===`/api/v4/flightdeck-pg/workspaces/${binding.workspaceId}/storage/prepare`&&method==='POST'&&!job.objectId&&job.operation!=='read'){
          const b=body as any,purpose=job.contentType==='text/html'?'byo-napplet/version':'byo-chat/attachment';allowed=b?.is_public===false&&b.file_name===job.fileName&&b.content_type===job.contentType&&b.size_bytes===job.sizeBytes&&JSON.stringify(b.metadata)===JSON.stringify({purpose})&&Object.keys(b).sort().join(',')==='content_type,file_name,is_public,metadata,size_bytes';
        }
        if(job.objectId&&uuid.test(job.objectId)){
          const base='/api/v4/storage/'+job.objectId;
          allowed ||= ((target.pathname===base||target.pathname===base+'/content')&&method==='GET'&&body===undefined);
          if(job.operation!=='read')allowed ||= (target.pathname===base&&method==='PUT'&&Object.keys(body as any).join(',')==='base64_data'&&sha256(Buffer.from((body as any).base64_data,'base64'))===job.sha256&&Buffer.from((body as any).base64_data,'base64').length===job.sizeBytes)||(target.pathname===base+'/complete'&&method==='POST'&&Object.keys(body as any).join(',')==='sha256_hex'&&(body as any).sha256_hex===job.sha256);
        }
      }
    }
    if(!allowed)throw Error('storage_http_scope_denied');
}
