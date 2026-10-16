import { demand } from './errors.ts';
import type { DatasetScope } from './canvas-datasets.ts';
import type { StorageTransport } from './tower-storage-client.ts';
export type CanvasBrokerBindingStatus={code:'exact_match'|'managed_binding_mismatch'|'broker_unavailable';canvasOrigin:string;managedOrigin:string|null;message:string};
export function canvasBrokerBindingStatus(scope:DatasetScope,env=process.env):CanvasBrokerBindingStatus {
 const managedOrigin=env.WAPP_TOWER_URL||null;
 const complete=!!(env.WAPP_INSTALLATION_ID&&managedOrigin&&env.WAPP_TOWER_WORKSPACE_ID&&env.WAPP_TOWER_WORKSPACE_OWNER_NPUB&&env.WAPP_APP_NPUB);
 if(!complete)return {code:'broker_unavailable',canvasOrigin:scope.target.towerUrl,managedOrigin,message:'Canvas datasets require an active managed broker binding'};
 const exact=env.WAPP_INSTALLATION_ID===scope.installationId&&managedOrigin===scope.target.towerUrl&&env.WAPP_TOWER_WORKSPACE_ID===scope.target.workspaceId&&env.WAPP_TOWER_WORKSPACE_OWNER_NPUB===scope.target.workspaceOwnerNpub&&env.WAPP_APP_NPUB===scope.target.appNpub;
 if(exact)return {code:'exact_match',canvasOrigin:scope.target.towerUrl,managedOrigin,message:'Canvas dataset destination matches the managed broker binding'};
 return {code:'managed_binding_mismatch',canvasOrigin:scope.target.towerUrl,managedOrigin,message:`Canvas dataset destination ${scope.target.towerUrl} is not authorized by the managed broker binding ${managedOrigin}. Keep this Canvas on ${scope.target.towerUrl}; ask the site operator to add an exact managed dataset binding for this destination, then check managed authorization again.`};
}
/** Runtime-only app capability injected by Autopilot. No signer/storage secrets enter Freedom. */
export function canvasBroker(scope:DatasetScope,signal?:AbortSignal,env=process.env):StorageTransport {
 const broker=env.WAPP_TOWER_DB_BROKER_URL,capability=env.WAPP_TOWER_DB_CAPABILITY;
 demand(broker&&capability,503,'Canvas data requires the managed app Tower DB broker binding');
 const address=new URL(broker);
 demand(address.protocol==='http:'&&address.hostname==='127.0.0.1'&&address.pathname==='/api/internal/wapps/tower-db',503,'Canvas broker route is invalid');
 const binding=canvasBrokerBindingStatus(scope,env);
 demand(binding.code==='exact_match',503,binding.message);
 const base=`${scope.target.towerUrl}/api/v4/workspaces/${scope.target.workspaceOwnerNpub}/apps/${scope.target.appNpub}/db`;
 return async(url,method,body)=>{
  const path=url.slice(base.length);
  demand(url.startsWith(base+'/')&&(path==='/descriptor'&&method==='GET'||path==='/migrations'&&method==='POST'||path==='/tables/canvas_dataset_records/query'&&method==='POST'||path==='/tables/canvas_dataset_records/rows'&&method==='POST'||/^\/tables\/canvas_dataset_records\/rows\/[a-f0-9]{64}$/.test(path)&&method==='PATCH'),403,'Canvas broker request denied');
  // A fresh bounded deadline for EVERY request, including watch refresh after long idle periods.
  return fetch(broker,{method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),headers:{authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify({method,path,...(body===undefined?{}:{body})})});
 };
}
