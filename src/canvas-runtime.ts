import type { Database } from 'bun:sqlite';
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { demand } from './errors.ts';
import { CanvasDatasetStore, datasetBinding, type DatasetBinding } from './canvas-datasets.ts';
import type { StorageConfig } from './storage.ts';
import { datasetTarget, revokeDatasetBinding, storageStatus } from './storage.ts';
import type { StorageTransport } from './tower-storage-client.ts';
import type { NappletData } from './napplet-data.ts';
import { now } from './auth.ts';
import { canvasTransport } from './canvas-broker.ts';
type Grant={token:string;sessionHash:string;user:string;canvas:string;destination:string;binding:DatasetBinding};
type Watcher={grant:Grant;check:()=>void;send:(message:any)=>void;close:()=>void};
type Poll={watchers:Set<Watcher>;controller:AbortController;timer:ReturnType<typeof setInterval>;busy:boolean;fingerprint:string;first:boolean;refresh:()=>Promise<void>};
export class CanvasRuntime {
 private grants=new Map<string,Grant>();
 private watchers=new Set<Watcher>();
 private polls=new Map<string,Poll>();
 private activeRequests=0;
 constructor(private db:Database,private data:NappletData,private fixture?: (scope:any)=>StorageTransport){data.onClose(token=>this.revokeToken(token));db.run("DELETE FROM storage_jobs WHERE operation='dataset'");}
 private revokeToken(token:string){for(const [id,g] of this.grants)if(g.token===token)this.revoke(id);}
 private revoke(id:string){const g=this.grants.get(id);this.grants.delete(id);for(const w of [...this.watchers])if(w.grant===g)w.close();}
 private prune(){for(const [id,g] of this.grants)if(!this.data.activeToken(g.token)||!this.db.query('SELECT hash FROM sessions WHERE hash=? AND expires_at>?').get(g.sessionHash,now()))this.revoke(id);}
 private check(workshop:Workshop,member:Member,sessionHash:string,token?:string){
 demand(this.db.query('SELECT hash FROM sessions WHERE hash=? AND pubkey=? AND expires_at>?').get(sessionHash,member.pubkey,now()),401,'Dataset session expired');
 workshop.admitted(workshop.scoped(member));if(token)this.data.authorize(workshop,member,sessionHash,token);
 }
 private store(workshop:Workshop,member:Member,sessionHash:string,config?:StorageConfig,token?:string,signal?:AbortSignal){
 this.check(workshop,member,sessionHash,token);
 const binding=storageStatus(workshop,config).binding;
 demand(this.fixture||config&&binding?.status==='ready',503,'Tower Canvas data is not activated');
 const target=this.fixture?binding?.target||{towerUrl:'https://fixture.invalid',workspaceId:'fixture',workspaceOwnerNpub:'fixture',appNpub:'fixture'}:datasetTarget(workshop,config!);
 const scope={installationId:config?.installationId||'fixture',target,canvasId:workshop.id,user:member.pubkey};
 const transport=this.fixture?this.fixture(scope):canvasTransport(scope,signal);
 const request:StorageTransport=async(url,method,body)=>{
  this.check(workshop,member,sessionHash,token);demand(!signal?.aborted,408,'Dataset request cancelled; read current data before retrying');
  demand(this.activeRequests<8,429,'Canvas data is busy; retry after reading current data');this.activeRequests++;
  try{
   const result=await transport(url,method,body);if(!this.fixture&&[401,403].includes(result.status))revokeDatasetBinding(workshop);const reader=result.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
   try{if(reader)while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;demand(bytes<=9*1024*1024,502,'Tower dataset response exceeds bounded capacity');chunks.push(next.value);}}catch(e){await reader?.cancel();throw e;}
   this.check(workshop,member,sessionHash,token);demand(!signal?.aborted,408,'Dataset outcome may have committed; read current data before retrying');
   return new Response(Buffer.concat(chunks),{status:result.status,headers:result.headers});
  }finally{this.activeRequests--;}
 };
 return new CanvasDatasetStore(scope,request);
 }
 async discovery(workshop:Workshop,member:Member,sessionHash:string,config?:StorageConfig){const store=this.store(workshop,member,sessionHash,config);await store.ensure();return {canvasId:workshop.id,readAt:new Date().toISOString(),datasets:await store.discovery(),valuesIncluded:false};}
 private channel(g:Grant){return JSON.stringify([g.canvas,g.binding.name,g.binding.visibility,g.binding.visibility==='private'?g.user:'']);}
 async operate(workshop:Workshop,member:Member,sessionHash:string,config:StorageConfig|undefined,body:any,signal?:AbortSignal){
 demand(Object.keys(body).every(k=>['token','method','dataset','handle','key','value','expectedVersion'].includes(k)),400,'Unexpected Canvas data field');
 demand(typeof body.token==='string',400,'Bridge token required');this.prune();
 const store=this.store(workshop,member,sessionHash,config,body.token,signal);
 if(body.method==='open'){
  datasetBinding(body.dataset);
  demand([...this.grants.values()].filter(g=>g.token===body.token).length<4&&this.grants.size<1000,429,'Dataset grant limit reached');
  // Reserve before async work so concurrent opens cannot bypass grant quotas.
  const handle=crypto.randomUUID(),g={token:body.token,sessionHash,user:member.pubkey,canvas:workshop.id,destination:JSON.stringify([store.scope.installationId,store.scope.target]),binding:datasetBinding(body.dataset)};this.grants.set(handle,g);
  try{await store.ensure();const opened=await store.open(body.dataset);this.check(workshop,member,sessionHash,body.token);demand(this.grants.get(handle)===g,403,'Dataset grant closed');return {handle,...opened};}catch(e){this.revoke(handle);throw e;}
 }
 const g=this.grants.get(body.handle);
 demand(g&&g.token===body.token&&g.sessionHash===sessionHash&&g.user===member.pubkey&&g.canvas===workshop.id,403,'Dataset grant missing or mismatched');
 if(body.method==='close'){this.revoke(body.handle);return {ok:true};}
 demand(g.destination===JSON.stringify([store.scope.installationId,store.scope.target]),403,'Dataset destination changed; reopen with consent');
 let result;
 if(body.method==='get')result=await store.get(g.binding,body.key);
 else if(body.method==='list')result={records:store.records(await store.list(g.binding))};
 else if(body.method==='set'||body.method==='remove'){
  result=body.method==='set'?await store.set(g.binding,body.key,body.value,body.expectedVersion):await store.remove(g.binding,body.key,body.expectedVersion);
  for(const w of this.polls.get(this.channel(g))?.watchers??[])try{w.check();w.send({type:'change',reason:'saved'});}catch{w.close();}
 }else demand(false,400,'Unknown dataset method');
 this.check(workshop,member,sessionHash,body.token);demand(this.grants.get(body.handle)===g,403,'Dataset grant ended; write may have committed, refetch current data');return result;
 }
 watch(workshop:Workshop,member:Member,sessionHash:string,config:StorageConfig|undefined,body:any,signal:AbortSignal){
 demand(Object.keys(body).every(k=>['token','handle'].includes(k)),400,'Unexpected subscription field');this.prune();
 const g=this.grants.get(body.handle);
 demand(g&&g.token===body.token&&g.sessionHash===sessionHash&&g.user===member.pubkey&&g.canvas===workshop.id,403,'Dataset subscription binding denied');
 this.check(workshop,member,sessionHash,body.token);
 demand(this.watchers.size<128&&[...this.watchers].filter(w=>w.grant.token===g.token).length<4,429,'Dataset subscription quota reached');
 let finish=()=>{};
 return new ReadableStream<Uint8Array>({start:controller=>{
  let closed=false;const key=this.channel(g);
  const check=()=>{demand(this.grants.get(body.handle)===g,403,'Dataset permission revoked');this.check(workshop,member,sessionHash,body.token);const current=this.store(workshop,member,sessionHash,config,body.token);demand(g.destination===JSON.stringify([current.scope.installationId,current.scope.target]),403,'Dataset destination changed');};
  const send=(message:any)=>{if(closed)return;if((controller.desiredSize??0)<=0){finish();return;}controller.enqueue(new TextEncoder().encode(JSON.stringify(message)+'\n'));};
  const watcher:Watcher={grant:g,check,send,close:()=>finish()};
  finish=()=>{if(closed)return;closed=true;clearInterval(heartbeat);this.watchers.delete(watcher);signal.removeEventListener('abort',finish);const poll=this.polls.get(key);poll?.watchers.delete(watcher);if(poll&&!poll.watchers.size){clearInterval(poll.timer);poll.controller.abort();this.polls.delete(key);}try{controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'status',state:'closed',message:'Dataset permission ended'})+'\n'));controller.close();}catch{}};
  const heartbeat=setInterval(()=>{try{check();send({type:'heartbeat'});}catch{this.revoke(body.handle);}},1000);
  let poll=this.polls.get(key);
  if(!poll){
   const abort=new AbortController();
   const refresh=async()=>{
    if(poll!.busy||abort.signal.aborted)return;poll!.busy=true;
    try{
     // Re-authorize all consumers; query under one currently authorized session with exact private owner filter.
     for(const w of [...poll!.watchers])try{w.check();}catch{w.close();}
     const w=[...poll!.watchers][0];if(!w)return;
     // Each watcher supplies its own authorized request factory. Never borrow another private owner's authority.
     const rows=await (w as Watcher&{read:()=>Promise<any[]>}).read();
     const current=JSON.stringify(rows);const changed=poll!.first||current!==poll!.fingerprint;
     poll!.fingerprint=current;poll!.first=false;
     for(const consumer of [...poll!.watchers])try{consumer.check();if(changed)consumer.send({type:'change',reason:'current-read'});consumer.send({type:'status',state:'live'});}catch{consumer.close();}
    }catch{for(const w of poll!.watchers)w.send({type:'status',state:'recovering',message:'Tower refresh failed; refetch after recovery'});poll!.first=true;}finally{poll!.busy=false;}
   };
   poll={watchers:new Set(),controller:abort,timer:setInterval(()=>void refresh(),5000),busy:false,fingerprint:'',first:true,refresh};this.polls.set(key,poll);
  }
  Object.assign(watcher,{read:()=>this.store(workshop,member,sessionHash,config,body.token,poll!.controller.signal).versions(g.binding)});
  poll.watchers.add(watcher);this.watchers.add(watcher);signal.addEventListener('abort',finish,{once:true});send({type:'status',state:'connecting'});send({type:'change',reason:'current-read'});void poll.refresh();if(signal.aborted)finish();
 },cancel:()=>finish()},{highWaterMark:8});
 }
 verifyJob(workshop:Workshop,member:Member,candidate:any){const a=candidate?.datasetAuthority;demand(a&&a.expires>Date.now()&&a.user===member.pubkey,403,'Dataset operation expired');this.check(workshop,member,a.sessionHash,a.token||undefined);}
}
