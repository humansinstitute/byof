import { Workshop } from './workshop.ts';
import type { Auth } from './auth.ts';
import type { FollowupConfig } from './config.ts';
import { dispatchReplacement } from './pipeline/replacement-dispatch.ts';
import { projectRoute } from './project-routing.ts';
import { currentPreSend,currentAbandoned } from './pre-send-recovery.ts';
import { now } from './auth.ts';
import {neverDispatched} from './queued-recovery.ts';

/** A server continuation of an already authorized saved instruction. Ownership,
 * admission, revision, pause and allowance are rechecked by the dispatcher. */
export async function recoverWorkshopBuilders(workshop:Workshop,auth:Auth,config?:FollowupConfig,dispatch:typeof dispatchReplacement=dispatchReplacement,options:{storageReady?:(workshopId:string)=>boolean;storageRequired?:(workshopId:string)=>boolean}={}) {
  if(!config)return;
  const db=workshop.db;
  const rows=db.query(`SELECT r.*,p.owner,p.workshop_id FROM requests r JOIN projects p ON p.id=r.project_id
    WHERE r.status IN ('queued','dispatching','failed','execution_uncertain','dispatch_pending') AND NOT EXISTS(SELECT 1 FROM requests newer WHERE newer.project_id=r.project_id AND newer.rowid>r.rowid) ORDER BY r.created_at LIMIT 50`).all() as any[];
  for(const request of rows){
    const scope=new Workshop(db,workshop.assets,request.workshop_id);
    const allocation=db.query('SELECT storage_required FROM local_builds WHERE request_id=?').get(request.id) as any;
    scope.storageReady=options.storageReady?.(scope.id)??workshop.storageReady;
    if(!scope.storageReady&&request.mode!=='answer')continue;
    scope.storageRequired=!!(options.storageRequired?.(scope.id) ?? workshop.storageRequired) || !!allocation?.storage_required;
    let member,project,route;
    try {member=scope.scoped(auth.member(request.owner));project=scope.project(member,request.project_id,true);route=projectRoute(project,config);}catch{continue;}
    if(!route?.replacementEnabled || route.suspended)continue;
    const recovering=db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(request.id) as any;
    const unsent=neverDispatched(db,request);
    if(unsent&&now()-request.created_at<30)continue;
    if(request.status==='dispatching'&&(!recovering||now()-recovering.claimed_at<30))continue;
    if(!unsent && !currentPreSend(db,request) && !currentAbandoned(db,request) && !(['dispatching','dispatch_pending','execution_uncertain'].includes(request.status) && recovering))continue;
    const claimed=db.transaction(()=>{
      db.run('INSERT OR IGNORE INTO automatic_recovery(request_id) VALUES(?)',[request.id]);
      return db.run('UPDATE automatic_recovery SET attempts=attempts+1,next_at=? WHERE request_id=? AND attempts<4 AND next_at<=?',[now()+60,request.id,now()]).changes===1;
    }).immediate();
    if(!claimed)continue;
    try {await dispatch(scope,member,project.id,request.id,config,undefined,{automatic:true});}
    catch { // Bounded outage retries; retain the exact saved instruction and app.
      db.run("UPDATE requests SET error='Your builder is temporarily unavailable. Your saved app is safe. You can retry this saved request.' WHERE id=? AND status IN ('queued','failed','execution_uncertain','dispatch_pending')",[request.id]);
    }
  }
}
