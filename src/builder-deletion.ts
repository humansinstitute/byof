import { unresolvedNativeExecution } from "./native-uncertainty.ts";
import type {Workshop} from './workshop.ts';
import type {Member} from './auth.ts';
import type {FollowupConfig} from './config.ts';
import {builderEpoch} from './builder-lifecycle.ts';
import {demand} from './errors.ts';
import {now} from './auth.ts';
import {ManagedPipelineClient} from './pipeline/managed-client.ts';
import {DeliveryDenied,type VerifiedDelivery} from './pipeline/receiver.ts';
export async function deleteNativeBuilder(workshop:Workshop,member:Member,projectId:string,body:any,config?:FollowupConfig,submit?:(input:any)=>Promise<any>){
  const project=workshop.project(member,projectId,true),db=workshop.db;
  demand(config?.nativeDeletion && !config.suspended && projectId===config.projectId && project.owner===config.ownerPubkey && project.conversation_id===config.conversationKey,403,'Scoped native lifecycle capability is not activated');
  demand(body.confirmNativeTranscriptDeletion===true,400,'Confirm deletion of native transcript and runtime records; app messages are preserved');
  demand(!unresolvedNativeExecution(db,projectId),409,'Native execution is uncertain; builder lifecycle is fenced');
  const entry=db.transaction(()=>{
    const epoch=builderEpoch(workshop,project);
    demand(Number.isInteger(body.generation)&&body.generation===epoch.generation,409,'Builder generation changed; reload');
    demand(!db.query("SELECT id FROM requests WHERE project_id=? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(projectId),409,'Active or uncertain request prevents native deletion');
    let deletion=db.query('SELECT * FROM builder_deletions WHERE project_id=? AND generation=?').get(projectId,epoch.generation) as any;
    if(deletion?.run_id||deletion?.status==='completed'||(deletion?.status==='dispatching'&&now()-deletion.claimed_at<30))return null;
    if(!deletion){
      const native=db.query('SELECT receipt_json FROM conversation_receipts WHERE project_id=?').get(projectId) as any;
      const legacy=!native?db.query('SELECT b.receipt_json FROM build_receipts b JOIN requests r ON r.id=b.request_id WHERE r.project_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1').get(projectId) as any:null;
      const receipt=native||legacy?JSON.parse((native||legacy).receipt_json):null;
      demand(receipt?.nativeSessionId&&receipt.sessionId,409,'Native builder receipt is unavailable');
      demand(!epoch.native_id||epoch.native_id===receipt.nativeSessionId,409,'Native builder mapping changed');
      const id=crypto.randomUUID(),input={requestId:id,projectId,ownerPubkey:project.owner,generation:epoch.generation,conversationKey:epoch.conversation_key,expectedNativeSessionId:receipt.nativeSessionId,expectedWingmanSessionId:receipt.sessionId};
      db.run("INSERT INTO builder_deletions(id,project_id,generation,input_json,status) VALUES(?,?,?,?,'queued')",[id,projectId,epoch.generation,JSON.stringify(input)]);
      deletion={id,input_json:JSON.stringify(input)};
    }
    db.run("UPDATE builder_epochs SET state='deleting' WHERE project_id=? AND generation=?",[projectId,epoch.generation]);
    db.run("UPDATE builder_deletions SET status='dispatching',claimed_at=?,error=NULL WHERE id=?",[now(),deletion.id]);
    return deletion;
  }).immediate();
  if(entry)try{const accepted=await (submit??(input=>new ManagedPipelineClient(config!.nativeDeletion!).submit(input)))(JSON.parse(entry.input_json));db.run("UPDATE builder_deletions SET status='working',run_id=?,receipt_json=? WHERE id=? AND run_id IS NULL",[accepted.runId,JSON.stringify(accepted.receipt),entry.id]);}
  catch{db.run("UPDATE builder_deletions SET status='dispatch_pending',error='Native deletion acceptance is uncertain. Retry this exact operation; builder requests remain fenced.' WHERE id=? AND run_id IS NULL",[entry.id]);}
  return db.query('SELECT id,generation,status,error,run_id,receipt_json FROM builder_deletions WHERE project_id=? AND generation=?').get(projectId,body.generation);
}
export function storeBuilderDeletion(workshop:Workshop,delivery:VerifiedDelivery):'applied'|'duplicate'|null{
  const db=workshop.db,e=delivery.envelope;
  if(!db.query('SELECT id FROM builder_deletions WHERE run_id=?').get(e.runId))return null;
  return db.transaction(()=>{
    if(db.query('SELECT event_id FROM delivery_events WHERE event_id=?').get(delivery.eventId))throw new DeliveryDenied('auth_replay');
    const prior=db.query('SELECT body_hash FROM builder_delete_deliveries WHERE delivery_id=?').get(e.deliveryId) as any;
    if(prior){if(prior.body_hash!==delivery.bodyHash)throw new DeliveryDenied('delivery_payload_conflict');db.run('INSERT INTO delivery_events VALUES(?,?)',[delivery.eventId,now()]);return 'duplicate' as const;}
    const entry=db.query('SELECT * FROM builder_deletions WHERE run_id=?').get(e.runId) as any,input=JSON.parse(entry.input_json),epoch=builderEpoch(workshop,db.query('SELECT * FROM projects WHERE id=?').get(entry.project_id));
    if(entry.status==='completed'||entry.generation!==epoch.generation||epoch.state!=='deleting')throw new DeliveryDenied('deletion_generation_denied');
    if(e.status==='ok'){
      const result=e.result as any,r=result?.deletionReceipt;
      if(result?.action!=='builder_storage_deleted'||result.requestId!==entry.id||result.projectId!==entry.project_id||result.generation!==entry.generation||r?.requestId!==entry.id||r.projectId!==entry.project_id||r.conversationKey!==input.conversationKey||r.nativeSessionId!==input.expectedNativeSessionId||r.sessionId!==input.expectedWingmanSessionId||r.runtimeStorageDeleted!==true||typeof r.nativeTranscriptDeleted!=='boolean'||r.nativeStorageDeleted!==false||r.metadataIndexesPreserved!==true||!r.receiptId)throw new DeliveryDenied('deletion_receipt_denied');
      db.run("UPDATE builder_epochs SET state='retired',reason='native_transcript_runtime_deleted',retired_at=? WHERE project_id=? AND generation=?",[now(),entry.project_id,entry.generation]);
      db.run("UPDATE builder_deletions SET status='completed',receipt_json=?,error=NULL WHERE id=?",[JSON.stringify({envelope:e,eventId:delivery.eventId}),entry.id]);
    }else db.run("UPDATE builder_deletions SET status='failed',receipt_json=?,error='Native deletion failed; this builder stays fenced until the exact operation is reconciled.' WHERE id=?",[JSON.stringify(e),entry.id]);
    db.run('INSERT INTO builder_delete_deliveries VALUES(?,?,?,?)',[e.deliveryId,e.runId,delivery.bodyHash,JSON.stringify(e)]);db.run('INSERT INTO delivery_events VALUES(?,?)',[delivery.eventId,now()]);return 'applied' as const;
  }).immediate();
}
