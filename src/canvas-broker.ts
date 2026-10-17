import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { sha256 } from './assets.ts';
import { demand } from './errors.ts';
import type { DatasetScope } from './canvas-datasets.ts';
import type { StorageTransport } from './tower-storage-client.ts';

type RuntimeEnv=Record<string,string|undefined>;
type Fetcher=(input:any,init?:any)=>Promise<Response>;
export type CanvasBrokerBindingStatus={
 code:'exact_match'|'managed_binding_mismatch'|'signer_target_mismatch'|'broker_unavailable';
 canvasOrigin:string;
 managedOrigin:string|null;
 message:string;
 transport:'managed_loopback'|'direct_nip98'|null;
 signerNpub?:string;
};

function managedBrokerSelected(env:RuntimeEnv){return !!(env.WAPP_TOWER_DB_BROKER_URL||env.WAPP_TOWER_DB_CAPABILITY);}

export function canvasDirectSigner(env:RuntimeEnv=process.env){
 const encoded=env.BYO_NSEC?.trim();
 demand(encoded,503,'Canvas dataset signing is unavailable: configure the backend-only BYO_NSEC');
 let decoded:ReturnType<typeof nip19.decode>;
 try{decoded=nip19.decode(encoded);}catch{demand(false,503,'Canvas dataset signing is unavailable: BYO_NSEC is invalid');throw Error('unreachable');}
 demand(decoded.type==='nsec'&&decoded.data instanceof Uint8Array&&decoded.data.length===32,503,'Canvas dataset signing is unavailable: BYO_NSEC must be an nsec');
 const secret=decoded.data;
 const pubkey=getPublicKey(secret);
 return {secret,pubkey,npub:nip19.npubEncode(pubkey)};
}

export function canvasBrokerBindingStatus(scope:DatasetScope,env:RuntimeEnv=process.env):CanvasBrokerBindingStatus {
 if(managedBrokerSelected(env)){
  const managedOrigin=env.WAPP_TOWER_URL||null;
  const complete=!!(env.WAPP_TOWER_DB_BROKER_URL&&env.WAPP_TOWER_DB_CAPABILITY&&env.WAPP_INSTALLATION_ID&&managedOrigin&&env.WAPP_TOWER_WORKSPACE_ID&&env.WAPP_TOWER_WORKSPACE_OWNER_NPUB&&env.WAPP_APP_NPUB);
  if(!complete)return {code:'broker_unavailable',canvasOrigin:scope.target.towerUrl,managedOrigin,message:'Canvas datasets require a complete managed loopback broker capability',transport:'managed_loopback'};
  const exact=env.WAPP_INSTALLATION_ID===scope.installationId&&managedOrigin===scope.target.towerUrl&&env.WAPP_TOWER_WORKSPACE_ID===scope.target.workspaceId&&env.WAPP_TOWER_WORKSPACE_OWNER_NPUB===scope.target.workspaceOwnerNpub&&env.WAPP_APP_NPUB===scope.target.appNpub;
  if(exact)return {code:'exact_match',canvasOrigin:scope.target.towerUrl,managedOrigin,message:'Canvas dataset destination matches the managed broker binding',transport:'managed_loopback'};
  return {code:'managed_binding_mismatch',canvasOrigin:scope.target.towerUrl,managedOrigin,message:`Canvas dataset destination ${scope.target.towerUrl} is not authorized by the managed broker binding ${managedOrigin}. Keep this Canvas on ${scope.target.towerUrl}; ask the site operator to add an exact managed dataset binding for this destination, then check managed authorization again.`,transport:'managed_loopback'};
 }
 try{
  const signer=canvasDirectSigner(env);
  if(signer.npub===scope.target.appNpub)return {code:'exact_match',canvasOrigin:scope.target.towerUrl,managedOrigin:null,message:'Canvas dataset destination matches the server signing identity',transport:'direct_nip98',signerNpub:signer.npub};
  return {code:'signer_target_mismatch',canvasOrigin:scope.target.towerUrl,managedOrigin:null,message:`Canvas reauthorization is required: this Canvas records app identity ${scope.target.appNpub}, but this Freedom Tools deployment signs dataset requests as ${signer.npub}. Open Canvas setup and authorize the displayed Freedom Tools identity for the same backend workspace; the saved authority must not be rewritten silently.`,transport:'direct_nip98',signerNpub:signer.npub};
 }catch(error){
  return {code:'broker_unavailable',canvasOrigin:scope.target.towerUrl,managedOrigin:null,message:error instanceof Error?error.message:'Canvas dataset signing is unavailable',transport:null};
 }
}

function canvasRequestPath(scope:DatasetScope,url:string,method:string,body?:unknown){
 const base=`${scope.target.towerUrl}/api/v4/workspaces/${scope.target.workspaceOwnerNpub}/apps/${scope.target.appNpub}/db`;
 const path=url.slice(base.length);
 const allowed=url.startsWith(base+'/')&&(
  path==='/descriptor'&&method==='GET'&&body===undefined||
  path==='/migrations'&&method==='POST'&&body!==undefined||
  path==='/tables/canvas_dataset_records/query'&&method==='POST'&&body!==undefined||
  path==='/tables/canvas_dataset_records/rows'&&method==='POST'&&body!==undefined||
  /^\/tables\/canvas_dataset_records\/rows\/[a-f0-9]{64}$/.test(path)&&method==='PATCH'&&body!==undefined
 );
 demand(allowed,403,'Canvas broker request denied');
 return path;
}

/** Runtime-only app capability injected by Autopilot. No signer/storage secrets enter Freedom. */
export function canvasBroker(scope:DatasetScope,signal?:AbortSignal,env:RuntimeEnv=process.env,fetcher:Fetcher=fetch as Fetcher):StorageTransport {
 const broker=env.WAPP_TOWER_DB_BROKER_URL,capability=env.WAPP_TOWER_DB_CAPABILITY;
 demand(broker&&capability,503,'Canvas data requires the managed app Tower DB broker binding');
 const address=new URL(broker);
 demand(address.protocol==='http:'&&address.hostname==='127.0.0.1'&&address.pathname==='/api/internal/wapps/tower-db',503,'Canvas broker route is invalid');
 const binding=canvasBrokerBindingStatus(scope,env);
 demand(binding.code==='exact_match'&&binding.transport==='managed_loopback',503,binding.message);
 return async(url,method,body)=>{
  const path=canvasRequestPath(scope,url,method,body);
  return fetcher(broker,{method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),headers:{authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})});
 };
}

/** Server-only direct transport for deployments that cannot reach Autopilot's loopback broker. */
export function canvasDirect(scope:DatasetScope,signal?:AbortSignal,env:RuntimeEnv=process.env,fetcher:Fetcher=fetch as Fetcher):StorageTransport {
 const signer=canvasDirectSigner(env);
 demand(signer.npub===scope.target.appNpub,503,`Canvas reauthorization is required: saved app identity ${scope.target.appNpub} does not match the configured dataset signer ${signer.npub}`);
 return async(url,method,body)=>{
  canvasRequestPath(scope,url,method,body);
  const payload=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method',method],...(payload===undefined?[]:[['payload',sha256(payload)]])]},signer.secret);
  return fetcher(url,{method,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:payload})});
 };
}

/** Select by explicit runtime capability, never by Tower brand or hostname. */
export function canvasTransport(scope:DatasetScope,signal?:AbortSignal,env:RuntimeEnv=process.env,fetcher:Fetcher=fetch as Fetcher):StorageTransport {
 return managedBrokerSelected(env)?canvasBroker(scope,signal,env,fetcher):canvasDirect(scope,signal,env,fetcher);
}
