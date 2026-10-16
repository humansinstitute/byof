import {publicKey} from '../config.ts';
import {TowerNamespaceClient} from '../tower-namespace.ts';
import { TowerStorageClient, storageTarget, uuid } from '../tower-storage-client.ts';
import { managedStorageTransport, type ManagedStorageScope, type StorageJobAuthority } from './managed-storage-transport.ts';
/** Reads only app-issued jobs and the selected validated HTML. Never sees builder scratch. */
export async function storeArtifactJob(input:any,scope:ManagedStorageScope) {
  if(!uuid.test(input.jobId))throw Error('storage_job_invalid');
  const url=scope.appOrigin+'/api/v1/internal/storage/jobs/'+input.jobId;
  const bootstrap=await managedStorageTransport(scope,null,input.jobId);
  const initial=await bootstrap(url,'GET');if(!initial.ok)throw Error('storage_job_http_'+initial.status);
  const job=await initial.json();
  const target=storageTarget(job.target);
  if(scope.installationWorkshops===true){if(!uuid.test(job.workshopId))throw Error('storage_workshop_authority_denied');scope={...scope,workshopId:job.workshopId};}
  scope=storageJobScope(scope,job);
  if(job.installationId!==scope.installationId||job.workshopId!==scope.workshopId||job.jobId!==input.jobId||target.towerUrl!==scope.towerOrigin)throw Error('storage_job_authority_denied');
  const authority:StorageJobAuthority={...job};
  const request=await managedStorageTransport(scope,authority);
  const json=async(method:string,body?:unknown)=>{const r=await request(url,method,body);if(!r.ok)throw Error('storage_job_http_'+r.status);return r.json();};
  const result=(artifact:any)=>({action:job.operation==='probe'?'storage_ready':job.operation==='read'?'storage_read':job.operation==='chat_attachment'?'attachment_completed':'build_completed',banRequired:false,jobId:input.jobId,...job.candidate,remoteStorage:artifact});
  if(job.operation==='dataset'){
    if(job.status==='verified')return {action:'dataset_completed',jobId:job.jobId};
    const planned=job.candidate.request;
    // Recheck the live participant/session/Canvas authority immediately before storage.
    await json('GET');
    const response=await request(planned.url,planned.method,planned.body);
    const text=await response.text();if(Buffer.byteLength(text)>400000)throw Error('dataset_response_limit');
    await json('POST',{step:'dataset',result:{status:response.status,body:JSON.parse(text)}});
    return {action:'dataset_completed',jobId:job.jobId};
  }
  if(job.status==='verified')return job.operation==='namespace'?{action:'namespace_ready',banRequired:false,jobId:job.jobId,namespace:job.namespace}:result(job.artifact);
  if(job.status==='preparing'&&!job.objectId)return {...job.candidate,action:'storage_pending',banRequired:false,jobId:input.jobId,error:'Storage prepare outcome is uncertain; reconcile the object before retrying.'};
  try{
    const client=new TowerStorageClient(target,request);
    if(job.operation==='namespace'){const ns=new TowerNamespaceClient(target,request),namespace=await ns.ensure();for(const receipt of job.namespaceReceipts)await ns.receipt(receipt);await json('POST',{step:'namespace',namespace});return {action:'namespace_ready',banRequired:false,jobId:input.jobId,namespace};}
    if(job.operation==='read'){
      const bytes=await client.readAndVerify(job.objectId,job.fileName,job.sha256,job.sizeBytes,job.contentType);
      await json('POST',{step:'read',artifact:job.artifact,base64:Buffer.from(bytes).toString('base64')});return result(job.artifact);
    }
    const bytes=new Uint8Array(Buffer.from(job.base64,'base64'));
    let objectId=job.objectId;
    if(!objectId){await json('POST',{step:'preparing'});objectId=await client.prepare(job.fileName,bytes,job.contentType);await json('POST',{step:'prepared',objectId});authority.objectId=objectId;}
    const stored=await client.uploadAndVerify(objectId,job.fileName,bytes,job.contentType);
    if(job.operation!=='chat_attachment'){const receipt={id:job.jobId,workspace_id:target.workspaceId,installation_id:scope.installationId,project_id:job.candidate?.nativeReceipt?.projectId??scope.workshopId,version:job.candidate?.version??0,object_id:objectId,sha256:job.sha256,size_bytes:job.sizeBytes};authority.receipt=receipt;const ns=new TowerNamespaceClient(target,request),namespace=await ns.ensure();await ns.receipt(receipt);await json('POST',{step:'namespace',namespace});}
    await json('POST',{step:'verified',artifact:stored.artifact,base64:Buffer.from(stored.bytes).toString('base64')});return result(stored.artifact);
  }catch(error){await json('POST',{step:'failed',error:(error instanceof Error?error.message:'storage_failed').slice(0,4000)});if(!authority.objectId&&error instanceof Error&&/^tower_storage_http_4[0-9]{2}$/.test(error.message))await json('POST',{step:'prepare_failed',error:error.message});return { ...job.candidate,action:'storage_pending',banRequired:false,jobId:input.jobId,error:error instanceof Error?error.message:'storage_failed'};}
}
export async function storeBuildCandidate(input:any,scope:ManagedStorageScope){
 if(input.candidate?.action!=='build_completed')return input.candidate;
 const request=await managedStorageTransport(scope),r=await request(scope.appOrigin+'/api/v1/internal/storage/candidates','POST',input);
 if(!r.ok)throw Error('storage_candidate_http_'+r.status);
 const job=await r.json();return storeArtifactJob(job,scope);
}

/** Destination comes only from the authenticated installation job endpoint.
 * Browser grant bindings are checked before any destination receives app signing. */
export function storageJobScope(scope:ManagedStorageScope,job:any):ManagedStorageScope {
 const target=storageTarget(job.target);
 if(target.towerUrl===scope.towerOrigin)return scope;
 const grant=job.destinationGrant;
 if(!scope.browserAuthorizedDestinations||!scope.installationWorkshops||job.installationId!==scope.installationId||!uuid.test(job.workshopId)||job.workshopId!==scope.workshopId||!grant||grant.installationId!==scope.installationId||grant.workshopId!==job.workshopId||JSON.stringify(storageTarget(grant.target))!==JSON.stringify(target)||publicKey(target.appNpub)!==scope.appPubkey||!/^[a-f0-9]{64}$/.test(grant.actor)||!/^[a-f0-9]{64}$/.test(grant.namespaceEventId)||!/^[a-f0-9]{64}$/.test(grant.inviteEventId))throw Error('storage_destination_grant_denied');
 return {...scope,towerOrigin:target.towerUrl};
}
