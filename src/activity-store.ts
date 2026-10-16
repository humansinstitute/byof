import type {Database} from 'bun:sqlite';
import {DeliveryDenied} from './pipeline/receiver.ts';
import type {VerifiedActivity} from './pipeline/activity-receiver.ts';
import type {OperatorBuildConfig} from './config.ts';
export const requestTerminal = (status:string) => ['succeeded','failed','banned','classifier_error','cancelled','execution_uncertain'].includes(status);
export function installActivityTables(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_authority(run_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),project_id TEXT NOT NULL,workshop_id TEXT NOT NULL,native_request_id TEXT NOT NULL,definition_id TEXT NOT NULL,receiver_url TEXT NOT NULL,activity_generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_turns(run_id TEXT PRIMARY KEY REFERENCES activity_authority(run_id),step_id TEXT NOT NULL,turn_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_recovery_lineage(invocation_run_id TEXT PRIMARY KEY,original_run_id TEXT NOT NULL,original_step_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT,request_id TEXT NOT NULL REFERENCES requests(id));
    CREATE TABLE IF NOT EXISTS activity_receipts(event_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,run_id TEXT NOT NULL,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,outcome TEXT NOT NULL,UNIQUE(turn_id,sequence));
    CREATE TABLE IF NOT EXISTS request_activity(event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),run_id TEXT NOT NULL,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,body_hash TEXT NOT NULL,payload_json TEXT NOT NULL,received_at INTEGER,UNIQUE(turn_id,sequence));`);
  const columns=db.query('PRAGMA table_info(activity_authority)').all() as {name:string}[];
  if(!columns.some(c=>c.name==='activity_generation'))db.exec("ALTER TABLE activity_authority ADD COLUMN activity_generation TEXT NOT NULL DEFAULT '0'; UPDATE activity_authority SET activity_generation=CAST(COALESCE((SELECT generation FROM request_epoch_history h WHERE h.request_id=activity_authority.request_id AND h.native_request_id=activity_authority.native_request_id ORDER BY generation DESC LIMIT 1),0) AS TEXT)");
  const activityColumns=db.query('PRAGMA table_info(request_activity)').all() as {name:string}[];
  // Historical rows did not record receiver time. Keep them null so the UI
  // never fabricates a misleading current time after an upgrade.
  if(!activityColumns.some(c=>c.name==='received_at'))db.exec('ALTER TABLE request_activity ADD COLUMN received_at INTEGER');
}
/** Called only alongside a verified managed acceptance, using the saved dispatch
 * input. The configured, hash-pinned definition owns the one completedTurn step. */
export function bindActivityAuthority(db:Database,requestId:string,runId:string,input:any,config:OperatorBuildConfig) {
  if(!config.activityWebhookUrl)return;
  const request=db.query('SELECT r.project_id,p.workshop_id FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(requestId) as any;
  if(!request||input.requestId!==requestId||input.projectId!==request.project_id||input.workshopId!==request.workshop_id)throw new DeliveryDenied('dispatch_activity_scope_denied');
  const values=[runId,requestId,request.project_id,request.workshop_id,input.nativeRequestId??requestId,config.definitionId,config.activityWebhookUrl,String(input.activityGeneration??input.generation??0)];
  db.run('INSERT OR IGNORE INTO activity_authority VALUES(?,?,?,?,?,?,?,?)',values);
  const saved=db.query('SELECT * FROM activity_authority WHERE run_id=?').get(runId) as any;
  if(JSON.stringify(Object.values(saved))!==JSON.stringify(values))throw new DeliveryDenied('activity_authority_conflict');
}
export function storeActivity(db:Database,verified:VerifiedActivity,nowSeconds=Math.floor(Date.now()/1000)) {
  return db.transaction(()=>{
    const e=verified.envelope;
    const prior=db.query('SELECT body_hash FROM activity_receipts WHERE event_id=?').get(e.eventId) as any;
    // Cryptographic byte binding is already checked. A stable accepted event is
    // acknowledged even when its retry's authentication timestamp has aged.
    if(prior){if(prior.body_hash!==verified.bodyHash)throw new DeliveryDenied('activity_payload_conflict');return 'duplicate';}
    if(verified.authCreatedAt<nowSeconds-90||verified.authCreatedAt>nowSeconds+15)throw new DeliveryDenied('stale_signature');
    const a=db.query('SELECT * FROM activity_authority WHERE run_id=?').get(e.runId) as any;
    const r=db.query('SELECT r.*,p.workshop_id,p.owner FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(a?.request_id??'') as any;
    if(!a||a.receiver_url!==verified.publicUrl||!r||r.run_id!==e.runId||r.project_id!==a.project_id||r.workshop_id!==a.workshop_id||e.correlation.requestId!==r.id||e.correlation.projectId!==r.project_id||e.correlation.workshopId!==r.workshop_id||e.correlation.nativeRequestId!==a.native_request_id||e.correlation.generation!==a.activity_generation)throw new DeliveryDenied('activity_mapping_denied');
    const epoch=db.query('SELECT * FROM builder_epochs WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(r.project_id) as any;
    const mapping=db.query('SELECT * FROM request_epochs WHERE request_id=?').get(r.id) as any;
    if(epoch&&(epoch.state!=='active'||(mapping?mapping.generation!==epoch.generation:epoch.generation!==0)))throw new DeliveryDenied('retired_generation_activity');
    const turn=db.query('SELECT * FROM activity_turns WHERE run_id=?').get(e.runId) as any;
    if(turn&&(turn.step_id!==e.stepId||turn.turn_id!==e.turnId||turn.session_id!==e.sessionId))throw new DeliveryDenied('activity_turn_conflict');
    if(db.query('SELECT event_id FROM activity_receipts WHERE turn_id=? AND sequence=?').get(e.turnId,e.sequence))throw new DeliveryDenied('activity_sequence_conflict');
    if((db.query('SELECT COUNT(*) n FROM activity_receipts WHERE run_id=?').get(e.runId) as any).n>=257)throw new DeliveryDenied('activity_capacity_denied');
    // A late valid hint is acknowledged but cannot add content or change state.
    const record=(outcome:string)=>db.run('INSERT INTO activity_receipts VALUES(?,?,?,?,?,?)',[e.eventId,verified.bodyHash,e.runId,e.turnId,e.sequence,outcome]);
    if(requestTerminal(r.status)){
      const final=db.query('SELECT result_json FROM delivery_receipts WHERE request_id=? AND run_id=? ORDER BY created_at DESC LIMIT 1').get(r.id,e.runId) as any;
      const result=final?JSON.parse(final.result_json).result:null,receipt=result?.nativeReceipt??result?.turn;
      if(receipt && (receipt.receiptId!==e.turnId || receipt.sessionId!==e.sessionId || (receipt.stepId!==undefined && receipt.stepId!==e.stepId) || (receipt.runId!==undefined && receipt.runId!==e.runId)))throw new DeliveryDenied('activity_final_lineage_denied');
      record('terminal_ignored');return 'terminal_ignored';
    }
    const legacy=(db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id===r.workshop_id;
    const member=legacy?db.query('SELECT state FROM members WHERE pubkey=?').get(r.owner):db.query('SELECT state FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(r.workshop_id,r.owner);
    if((member as any)?.state!=='admitted'){record('access_ignored');return 'access_ignored';}
    const terminal=db.query("SELECT sequence FROM request_activity WHERE turn_id=? AND json_extract(payload_json,'$.type') IN ('completed','failed')").get(e.turnId) as any;
    if(terminal&&e.sequence>terminal.sequence)throw new DeliveryDenied('activity_after_terminal_hint');
    if((e.type==='completed'||e.type==='failed')&&db.query('SELECT event_id FROM request_activity WHERE turn_id=? AND sequence>?').get(e.turnId,e.sequence))throw new DeliveryDenied('activity_terminal_order_conflict');
    if(!turn) {
      // The pinned instance's signed attestation supplies its generated step and
      // receipt identities. Pin once; the authoritative final receipt must agree.
      db.run('INSERT INTO activity_turns VALUES(?,?,?,?)',[e.runId,e.stepId,e.turnId,e.sessionId!]);
    }
    db.run('INSERT INTO request_activity(event_id,request_id,run_id,turn_id,sequence,body_hash,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)',[e.eventId,r.id,e.runId,e.turnId,e.sequence,verified.bodyHash,JSON.stringify(e),nowSeconds]);
    record('applied');
    return 'applied';
  }).immediate();
}
export function requestActivity(db:Database,requestId:string) {
  const rows=db.query('SELECT payload_json,received_at FROM request_activity WHERE request_id=? ORDER BY rowid').all(requestId) as {payload_json:string;received_at:number|null}[];
  // Keep retired runs in their historical order and each turn in source order.
  const turns=new Map<string,any[]>();
  for(const row of rows){const e=JSON.parse(row.payload_json);if(!turns.has(e.turnId))turns.set(e.turnId,[]);turns.get(e.turnId)!.push({...e,receivedAt:Number.isSafeInteger(row.received_at)?new Date(row.received_at!*1000).toISOString():null});}
  return [...turns.values()].flatMap(events=>{
    let previous=0;return events.sort((a,b)=>a.sequence-b.sequence).map(e=>{const gapBefore=e.sequence-previous-1;previous=e.sequence;return {eventId:e.eventId,sequence:e.sequence,type:e.type,content:e.content,turnId:e.turnId,timestamp:e.timestamp,receivedAt:e.receivedAt,...(gapBefore?{gapBefore}:{})};});
  });
}

/** Recovery authority comes only from the app's owned-run broker poll made by
 * the dispatcher, never from an activity event or browser-supplied run ID. */
export function bindActivityRecovery(db:Database,invocationRunId:string,requestId:string,input:any,turn:any) {
  if(!turn || typeof turn.runId!=='string' || typeof turn.stepId!=='string' || typeof turn.receiptId!=='string' )return;
  if(turn.requestId!==(input.nativeRequestId??requestId)||turn.projectId!==input.projectId||turn.conversationKey!==input.conversationKey)throw new DeliveryDenied('recovery_activity_lineage_denied');
  const values=[invocationRunId,turn.runId,turn.stepId,turn.receiptId,turn.sessionId??null,requestId];
  db.run('INSERT OR IGNORE INTO activity_recovery_lineage VALUES(?,?,?,?,?,?)',values);
  if(JSON.stringify(Object.values(db.query('SELECT * FROM activity_recovery_lineage WHERE invocation_run_id=?').get(invocationRunId) as any))!==JSON.stringify(values))throw new DeliveryDenied('recovery_activity_lineage_conflict');
}
export function verifyActivityFinal(db:Database,invocationRunId:string,requestId:string,receipt:any) {
  const authority=db.query('SELECT * FROM activity_authority WHERE run_id=?').get(invocationRunId) as any;
  if(!authority)return;
  if((receipt.nativeRequestId??receipt.requestId)!==authority.native_request_id || receipt.projectId!==authority.project_id || (receipt.generation!==undefined && String(receipt.generation)!==authority.activity_generation) || (receipt.invocationRunId!==undefined && receipt.invocationRunId!==invocationRunId))throw new DeliveryDenied('activity_final_correlation_denied');
  const lineage=db.query('SELECT * FROM activity_recovery_lineage WHERE invocation_run_id=?').get(invocationRunId) as any;
  const originalRun=receipt.runId??invocationRunId;
  if(originalRun!==invocationRunId && (!lineage || lineage.request_id!==requestId || lineage.original_run_id!==originalRun || lineage.original_step_id!==receipt.stepId || lineage.turn_id!==receipt.receiptId || (lineage.session_id!==null && lineage.session_id!==receipt.sessionId)))throw new DeliveryDenied('unregistered_original_turn_lineage');
  const activity=db.query('SELECT * FROM activity_turns WHERE run_id=?').get(originalRun) as any;
  if(activity&&(receipt.receiptId!==activity.turn_id||receipt.sessionId!==activity.session_id||receipt.stepId!==activity.step_id||originalRun!==activity.run_id))throw new DeliveryDenied('activity_final_lineage_denied');
}
