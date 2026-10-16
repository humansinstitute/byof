/** Evidence comes only from verified managed receipts, never browser assertions.
 * Preparing survives failures before store.sending; allow only known no-writer
 * readiness/source failures. Claimed ordinary deliveries and ambiguous launches
 * deliberately remain subject to reconciliation. */
export function confirmedPreSend(envelope:any,expected?:{requestId:string;projectId:string;conversationKey:string}):boolean {
  const turn=envelope?.result?.turn;
  if(envelope?.status!=='error' || !turn || !turn.receiptId || turn.nativeSessionId || turn.reply || turn.blockedBy)return false;
  if(expected && (turn.requestId!==expected.requestId || turn.projectId!==expected.projectId || turn.conversationKey!==expected.conversationKey))return false;
  if(turn.status==='preparing')return turn.error==='Completed-turn session has unrelated queued prompts' ||
    (turn.error==='Completed-turn bound session unavailable' && !turn.sessionId && !turn.executionId) ||
    (turn.error==='No available agent ports. Increase AGENT_MAX or free sessions.' && !turn.sessionId && !turn.executionId) ||
    turn.error==='Bound native conversation transcript unavailable';
  return false;
}
export function currentPreSend(db:any,request:any):boolean {
  const rows=db.query('SELECT result_json FROM delivery_receipts WHERE request_id=? AND run_id=?').all(request.id,request.run_id);
  const recovery=db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(request.id);
  const project=db.query('SELECT conversation_id FROM projects WHERE id=?').get(request.project_id);
  const input=recovery?JSON.parse(recovery.input_json):null;
  const expected={requestId:input?.nativeRequestId??request.id,projectId:request.project_id,conversationKey:input?.conversationKey??project.conversation_id};
  return rows.some((row:any)=>confirmedPreSend(JSON.parse(row.result_json),expected));
}

export function currentAbandoned(db:any,request:any):boolean {
 const rows=db.query('SELECT result_json FROM delivery_receipts WHERE request_id=? AND run_id=?').all(request.id,request.run_id);
 return rows.some((row:any)=>{const e=JSON.parse(row.result_json);return e.status==='ok' && e.result?.action==='builder_abandoned' && e.result.nativeReceipt?.status==='abandoned' && e.result.nativeReceipt.output?.writerStopped===true;});
}
