import {managedStorageTransport,type ManagedStorageScope} from './managed-storage-transport.ts';
import {storeBuildCandidate} from './store-artifact.ts';
import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {limits} from '../config.ts';
import {sha256} from '../assets.ts';
import {validateGeneratedHtml} from './artifact.ts';

function remoteCandidate(scope:ManagedStorageScope,input:any,build:any,candidate:any) {
  if(!scope.remoteBuilderRoot||resolve(scope.remoteBuilderRoot)!==scope.remoteBuilderRoot)throw Error('remote_builder_root_denied');
  const directory=join(scope.remoteBuilderRoot,input.workshopId,input.projectId),path=resolve(directory,build.artifactPath);
  if(!path.startsWith(directory+'/'))throw Error('remote_artifact_path_denied');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>limits.sourceBytes)throw Error('remote_artifact_file_denied');
    const bytes=readFileSync(fd),source=bytes.toString('utf8');
    if(!Buffer.from(source).equals(bytes))throw Error('artifact_encoding_denied');
    validateGeneratedHtml(source);
    return {...candidate,sourceBase64:bytes.toString('base64'),sourceSha256:sha256(bytes)};
  } finally {closeSync(fd);}
}

/** This function is invoked ONLY by the native agent tool dispatcher, during a turn. */
export async function publishNativeNapplet(call:any,scope:ManagedStorageScope,
  transport=managedStorageTransport,store=storeBuildCandidate) {
  const input=call.input,build=input.replacementContext?.fileBuild,validation=call.args?.validation;
  if(build?.publication!=='agent-tool-v1'||!Array.isArray(validation)||!validation.length||validation.length>32||validation.some((v:any)=>typeof v!=='string'||!v.trim()||v.length>4000)||
    Object.keys(call.args).join(',')!=='validation'||call.nativeReceipt.requestId!==input.nativeRequestId||call.nativeReceipt.projectId!==input.projectId)throw Error('publication_tool_input_denied');
  const nativeReceipt={...call.nativeReceipt,requestId:input.requestId,nativeRequestId:input.nativeRequestId,generation:input.generation,contextHash:input.contextHash};
  const candidate={action:'build_completed',banRequired:false,requestId:input.requestId,projectId:input.projectId,
    artifactPath:build.artifactPath,version:build.version,validation,response:'App published through the native publication tool.',nativeReceipt};
  const body={requestId:input.requestId,projectId:input.projectId,candidate};
  const scoped={...scope,workshopId:input.workshopId};
  const request=await transport(scoped,null,undefined,{body});
  const post=async(sender:any,path:string,payload:any)=>{const response=await sender(scope.appOrigin+path,'POST',payload);const value=await response.json();if(!response.ok)throw Error(value.error||`publication_http_${response.status}`);return value;};
  let pending;
  if(scope.remoteBuilderRoot){
    const staged=remoteCandidate(scope,input,build,body),candidateRequest=await transport(scoped,null,undefined,{body:staged});
    pending=await post(candidateRequest,'/api/v1/internal/publication/candidate',staged);
  } else pending=await post(request,'/api/v1/internal/publication/intent',body);
  if(pending.status==='published')return pending.receipt;
  try {
    const stored=await store(body,{...scope,installationWorkshops:true,workshopId:input.workshopId});
    if(stored.action!=='build_completed'||!stored.remoteStorage)throw Error(stored.error||'Verified Tower storage is required');
    return await post(request,'/api/v1/publication/version',{...body,candidate:stored});
  } catch(error) {
    const message=error instanceof Error?error.message:'Publication failed';
    try {await post(request,'/api/v1/internal/publication/failure',{...body,error:message});}
    catch {return {status:'pending',error:message+' Publication status could not be confirmed; retry this same tool call to reconcile it.',retryable:true};}
    return {status:'pending',error:message,retryable:true};
  }
}
