import type {Workshop} from './workshop.ts';
import type {Member} from './auth.ts';
import {demand,HttpError} from './errors.ts';

/** Dispatchers persist authority before sending. Absence of ALL checkpoints is
 * proof of no send, only while the saved request remains queued/unavailable.
 * Use inside the dispatch/cancel transaction after every asynchronous prepare. */
export function neverDispatched(db:any,request:any):boolean {
  if(!request || request.run_id || !['queued','unavailable'].includes(request.status))return false;
  return !['request_dispatch','request_recoveries','request_epochs','request_epoch_history','local_builds','dispatch_receipts','delivery_receipts','build_receipts','activity_authority','request_activity','agent_publications','final_message_receipts','replacement_attempts']
    .some(table=>db.query(`SELECT request_id FROM ${table} WHERE request_id=? LIMIT 1`).get(request.id));
}

export function preparationFailed(workshop:Workshop,projectId:string,requestId:string,error:unknown){
  if(error instanceof HttpError&&error.status<500)throw error;
  const saved=workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,projectId) as any;
  if(!neverDispatched(workshop.db,saved))throw error;
  const reason=error instanceof HttpError?error.message:'Preparation is temporarily unavailable';
  workshop.db.run("UPDATE requests SET error=? WHERE id=? AND status IN ('queued','unavailable') AND run_id IS NULL",[`Saved; dispatch has not started. ${reason}. Retry or cancel this saved request.`,requestId]);
  // Names/public HttpErrors only; internal exception messages can contain secrets.
  console.warn('Builder preparation failed before dispatch',requestId,error instanceof HttpError?error.status:error instanceof Error?error.name:'unknown');
  return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);
}

export function cancelUnsentRequest(workshop:Workshop,member:Member,projectId:string,requestId:string){
  workshop.project(member,projectId,!member.host);
  return workshop.db.transaction(()=>{
    const request=workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,projectId) as any;
    demand(request,404,'Saved request not found');
    if(request.status==='cancelled')return request;
    demand(neverDispatched(workshop.db,request),409,'Dispatch may have started; reconcile this saved request before stopping it');
    workshop.db.run("UPDATE requests SET status='cancelled',error='Cancelled before dispatch. Your app and allowance are unchanged.' WHERE id=?",[requestId]);
    return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);
  }).immediate();
}
