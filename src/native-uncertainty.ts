import { currentPreSend } from './pre-send-recovery.ts';
import type {Database} from 'bun:sqlite';
/** Old app versions labelled native errors failed. Inspect current-run evidence before allowing retirement or new work. */
export function unresolvedNativeExecution(db:Database,projectId:string,exceptRequestId:string|null=null):boolean {
  const receipts=db.query("SELECT r.id,r.project_id,r.run_id,d.result_json FROM requests r JOIN delivery_receipts d ON d.request_id=r.id AND d.run_id=r.run_id WHERE r.project_id=? AND (? IS NULL OR r.id<>?) AND r.status IN ('failed','cancelled','execution_uncertain')").all(projectId,exceptRequestId,exceptRequestId) as any[];
  return receipts.some(row=>{
    const e=JSON.parse(row.result_json),turn=e.result?.turn;
    if(e.status==='ok'||turn?.status==='completed'||currentPreSend(db,row))return false;
    if(turn?.status==='preparing'&&turn.error==='Completed-turn bound session unavailable'&&!turn.sessionId&&!turn.executionId&&!turn.nativeSessionId&&!turn.reply)return false;
    if(e.error==='followup_scope_denied'&&!e.result?.conversationInput&&!turn)return false;
    return true;
  });
}
