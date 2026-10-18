import type {Auth,Member} from './auth.ts';
import {now} from './auth.ts';
import type {FollowupConfig} from './config.ts';
import {demand} from './errors.ts';
import {requestDeliveryRecovery,staleBuildingSeconds} from './delivery-store.ts';
import {ManagedPipelineClient} from './pipeline/managed-client.ts';
import {projectRoute} from './project-routing.ts';
import {Workshop} from './workshop.ts';

const automaticLimit=6;

export type DeliveryRecoveryState='available'|'still_running'|'retrying_delivery'|'delivery_failed_recoverable'|'recovered'|'unauthorized'|'unsupported'|'correlation_failed'|'publication_pending'|'publication_failed';
export type DeliveryRecoveryTransport={poll(runId:string):Promise<any>;delivery(runId:string):Promise<any>;retryDelivery(runId:string):Promise<any>};

const responseOf=(value:any)=>value?.response;
function save(workshop:Workshop,request:any,state:DeliveryRecoveryState,message:string,remoteStatus:string|null=null,deliveryStatus:string|null=null,retry=false){
  const stamp=now();
  workshop.db.run(`INSERT INTO request_delivery_reconciliation(request_id,run_id,state,remote_status,delivery_status,message,retry_requests,next_check_at,checked_at)
      VALUES(?,?,?,?,?,?,?,0,?)
      ON CONFLICT(request_id) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,remote_status=excluded.remote_status,
        delivery_status=excluded.delivery_status,message=excluded.message,retry_requests=CASE WHEN request_delivery_reconciliation.run_id=excluded.run_id THEN request_delivery_reconciliation.retry_requests+excluded.retry_requests ELSE excluded.retry_requests END,
        next_check_at=CASE WHEN request_delivery_reconciliation.run_id=excluded.run_id THEN request_delivery_reconciliation.next_check_at ELSE 0 END,
        checked_at=excluded.checked_at,recovered_at=CASE WHEN excluded.state IN ('recovered','publication_pending','publication_failed') THEN excluded.checked_at ELSE request_delivery_reconciliation.recovered_at END`,
    [request.id,request.run_id,state,remoteStatus,deliveryStatus,message,retry?1:0,stamp]);
  return requestDeliveryRecovery(workshop.db,{...request,status:(workshop.db.query('SELECT status FROM requests WHERE id=?').get(request.id) as any)?.status})!;
}
function localComplete(workshop:Workshop,request:any){return !!workshop.db.query('SELECT delivery_id FROM delivery_receipts WHERE request_id=? AND run_id=?').get(request.id,request.run_id)}
function publicationRequired(workshop:Workshop,request:any){
  if(request.mode!=='build')return false;
  const recovery=workshop.db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(request.id) as any;
  if(!recovery)return false;
  let agentTool=false;try{agentTool=JSON.parse(recovery.input_json).replacementContext?.fileBuild?.publication==='agent-tool-v1';}catch{}
  const publication=workshop.db.query('SELECT status FROM agent_publications WHERE request_id=?').get(request.id) as any;
  return agentTool&&publication?.status!=='published';
}
function completedState(workshop:Workshop,request:any){
  if(publicationRequired(workshop,request)){
    const publication=workshop.db.query('SELECT error FROM agent_publications WHERE request_id=?').get(request.id) as any;
    return publication?.error
      ? save(workshop,request,'publication_failed',`The saved reply was recovered, but app publication failed: ${String(publication.error).slice(0,1000)}`,request.status,'delivered')
      : save(workshop,request,'publication_pending','The saved reply was recovered. The app change is not published yet.',request.status,'delivered');
  }
  return save(workshop,request,'recovered','The saved result was recovered without rebuilding.',request.status,'delivered');
}
function safeFailure(error:unknown){
  const message=error instanceof Error?error.message:String(error);
  if(/managed_pipeline_http_(401|403|404)|managed_credential|managed_remote|managed_loopback/.test(message))return {state:'unauthorized' as const,message:'Recovery is not authorized for this saved run. Ask the Canvas host to restore the managed Autopilot connection.'};
  if(/managed_pipeline_http_(405|501)/.test(message))return {state:'unsupported' as const,message:'This Autopilot does not yet support safe same-result delivery retry.'};
  return {state:'delivery_failed_recoverable' as const,message:'The retained result could not be redelivered yet. You can safely try Recover result again.'};
}

/** Reconciles only the exact accepted run already bound to this saved request. */
export async function reconcileAcceptedRun(workshop:Workshop,member:Member,projectId:string,requestId:string,config?:FollowupConfig,transport?:DeliveryRecoveryTransport){
  const project=workshop.project(member,projectId,!member.host),request=workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,project.id) as any;
  demand(request,404,'Saved request not found');demand(request.run_id,409,'This request has no accepted run to recover');
  if(localComplete(workshop,request))return completedState(workshop,request);
  demand(request.status==='building',409,'Only an accepted building request can be reconciled');
  const recent=workshop.db.query('SELECT state,checked_at FROM request_delivery_reconciliation WHERE request_id=? AND run_id=?').get(request.id,request.run_id) as any;
  if(recent?.state==='retrying_delivery'&&recent.checked_at>now()-15)return requestDeliveryRecovery(workshop.db,request)!;
  const route=projectRoute(project,config);
  if(!route||route.suspended)return save(workshop,request,'unauthorized','Recovery is not authorized for this project. Ask the Canvas host to restore the managed Autopilot connection.');
  const client=transport??new ManagedPipelineClient(route);
  try{
    const remote=responseOf(await client.poll(request.run_id));
    if(!remote||remote.runId!==request.run_id||typeof remote.terminal!=='boolean'||typeof remote.status!=='string')return save(workshop,request,'correlation_failed','Autopilot returned a mismatched run. Nothing was retried.',null,null);
    if(!remote.terminal)return save(workshop,request,'still_running',`The accepted run is still ${remote.status}. No new build was started.`,remote.status,null);
    const deliveryEnvelope=responseOf(await client.delivery(request.run_id)),delivery=deliveryEnvelope?.delivery;
    if(!deliveryEnvelope||deliveryEnvelope.runId!==request.run_id||delivery&&delivery.runId!==request.run_id)return save(workshop,request,'correlation_failed','Autopilot returned mismatched delivery state. Nothing was retried.',remote.status,null);
    if(localComplete(workshop,request))return completedState(workshop,request);
    if(!delivery||typeof delivery.status!=='string')return save(workshop,request,'unsupported','The run completed, but no retained callback delivery is available. Ask the Canvas host to inspect Autopilot.',remote.status,null);
    if(delivery.status==='pending'||delivery.status==='delivering')return save(workshop,request,'retrying_delivery','The completed result is retained and its signed delivery is in progress. The agent is not running again.',remote.status,delivery.status);
    if(delivery.status==='delivered')return save(workshop,request,'unsupported','Autopilot reports the callback delivered, but Freedom Tools has no matching receipt. Recovery is paused for host investigation.',remote.status,delivery.status);
    if(delivery.status!=='failed')return save(workshop,request,'unsupported','Autopilot returned an unsupported delivery state. Nothing was retried.',remote.status,delivery.status);
    const retry=responseOf(await client.retryDelivery(request.run_id));
    if(!retry||!['requeued','already_pending','delivered'].includes(retry.outcome)||retry.delivery?.runId!==request.run_id||retry.delivery?.id!==delivery.id)return save(workshop,request,'correlation_failed','Autopilot returned a mismatched retry receipt. Nothing was applied.',remote.status,delivery.status);
    if(localComplete(workshop,request))return completedState(workshop,request);
    if(retry.outcome==='delivered')return save(workshop,request,'unsupported','Autopilot reports the callback delivered, but Freedom Tools has no matching receipt. Recovery is paused for host investigation.',remote.status,'delivered');
    return save(workshop,request,'retrying_delivery','The completed result is retained. Autopilot is resending the same signed result; the agent is not running again.',remote.status,delivery.status,true);
  }catch(error){const failure=safeFailure(error);return save(workshop,request,failure.state,failure.message,null,null);}
}

export async function reconcileStaleBuildingRequests(workshop:Workshop,auth:Auth,config?:FollowupConfig,reconcile:typeof reconcileAcceptedRun=reconcileAcceptedRun){
  if(!config)return;
  const rows=workshop.db.query(`SELECT r.*,p.owner,p.workshop_id FROM requests r JOIN projects p ON p.id=r.project_id
    WHERE r.status='building' AND r.run_id IS NOT NULL AND r.created_at<=? ORDER BY r.created_at LIMIT 50`).all(now()-staleBuildingSeconds) as any[];
  for(const request of rows){
    const claimed=workshop.db.transaction(()=>{
      workshop.db.run(`INSERT OR IGNORE INTO request_delivery_reconciliation(request_id,run_id,state,message) VALUES(?,?,?,?)`,[request.id,request.run_id,'available','This accepted request is taking longer than expected.']);
      return workshop.db.run(`UPDATE request_delivery_reconciliation SET automatic_attempts=automatic_attempts+1,next_check_at=?
        WHERE request_id=? AND run_id=? AND automatic_attempts<? AND next_check_at<=?`,[now()+Math.min(900,60*2**Math.min(4,(workshop.db.query('SELECT automatic_attempts n FROM request_delivery_reconciliation WHERE request_id=?').get(request.id) as any)?.n??0)),request.id,request.run_id,automaticLimit,now()]).changes===1;
    }).immediate();
    if(!claimed)continue;
    const scope=new Workshop(workshop.db,workshop.assets,request.workshop_id);
    try{await reconcile(scope,scope.scoped(auth.member(request.owner)),request.project_id,request.id,config);}catch{}
  }
}
