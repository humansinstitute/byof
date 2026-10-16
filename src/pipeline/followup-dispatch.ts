import { bindActivityAuthority, bindActivityRecovery } from '../activity-store.ts';
import { requestBuilderPrompt } from '../builder-prompt.ts';
import { projectRoute } from "../project-routing.ts";
import { unresolvedNativeExecution } from "../native-uncertainty.ts";
import { dispatchReplacement } from "./replacement-dispatch.ts";
import { builderEpoch } from "../builder-lifecycle.ts";
import type { Workshop } from '../workshop.ts';
import type { Member } from '../auth.ts';
import type { FollowupConfig } from '../config.ts';
import { demand } from '../errors.ts';
import { bindRun } from '../delivery-store.ts';
import { ManagedPipelineClient } from './managed-client.ts';
import { now } from '../auth.ts';
import {preparationFailed} from '../queued-recovery.ts';
import {materializeRequestAttachments} from '../chat-attachments.ts';
export function followupAvailable(project: any, config?: FollowupConfig): boolean {
  return !!projectRoute(project,config);
}
type Submit = (input: any) => Promise<{ runId: string; receipt: unknown }>;
export async function dispatchFollowup(workshop: Workshop, member: Member, projectId: string, requestId: string, config?: FollowupConfig, submit?: Submit) {
  // A durable save is a successful submission even if preparation throws before
  // a dispatch checkpoint. Keep it actionable and let the bounded sweep retry.
  workshop.project(member,projectId,!member.host);
  try {return await prepareFollowup(workshop,member,projectId,requestId,config,submit);}
  catch(error){return preparationFailed(workshop,projectId,requestId,error);}
}
async function prepareFollowup(workshop: Workshop, member: Member, projectId: string, requestId: string, config?: FollowupConfig, submit?: Submit) {
  // Host recovery is an explicit API operation; ordinary browser submissions require ownership.
  const project = workshop.project(member, projectId, !member.host);
  demand(!unresolvedNativeExecution(workshop.db,projectId),409,'Native execution is uncertain; this project is fenced');
  demand(followupAvailable(project, config), 403, 'Follow-up execution is not activated for this owner and project');
  config = projectRoute(project,config)!;
  const attachments=materializeRequestAttachments(workshop,requestId,config.directory!);
  const saved=workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,projectId) as any;
  if(!workshop.storageReady&&saved?.mode==='build'&&!saved.run_id){workshop.db.run("UPDATE requests SET status='unavailable',error='Private storage needs authorization before app changes can run. Your request is saved; questions are still available.' WHERE id=?",[requestId]);return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);}
  const epoch = builderEpoch(workshop,project);
  if (config?.replacementEnabled && (config.initialContext || epoch.generation > 0 || epoch.state === 'retired')) return dispatchReplacement(workshop,member,projectId,requestId,config,submit ? {poll:async()=>{throw Error('Poll unavailable')},submit:async(input)=>submit(input)} : undefined);
  const row = workshop.db.transaction(() => {
    const request = workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId, projectId) as any;
    demand(request, 404, 'Saved request not found');
    if (request.run_id || !['unavailable','queued','dispatch_pending','dispatching'].includes(request.status)) return { request };
    demand(project.current_revision === request.expected_revision, 409, 'Project changed; saved request cannot be replayed');
    const owner = workshop.membership(project.owner);
    demand(owner.state === 'admitted' && (request.mode === 'answer' || owner.allowance > 0), 403, 'Project owner cannot execute requests');
    demand(!workshop.roomRow().paused, 403, 'The host has paused building');
    demand(!workshop.db.query("SELECT id FROM requests WHERE project_id=? AND id<>? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(projectId, requestId), 409, 'A request is already running for this project');
    let outbox = workshop.db.query('SELECT * FROM request_dispatch WHERE request_id=?').get(requestId) as any;
    if (request.status === 'dispatching' && outbox && now() - outbox.claimed_at < 30) return { request };
    if (!outbox) {
      const source = workshop.assets.get(workshop.revision(projectId, request.expected_revision).source_hash);
      const input = { ...(requestBuilderPrompt(workshop.db,requestId) ? {builderPrompt:requestBuilderPrompt(workshop.db,requestId)} : {}), requestId, projectId, workshopId:workshop.id, activityGeneration:'0', nativeRequestId:requestId, ownerPubkey: project.owner, conversationKey: project.conversation_id, prompt: request.prompt, attachments, mode: request.mode, source };
      workshop.db.run('INSERT INTO request_dispatch(request_id,input_json) VALUES(?,?)', [requestId, JSON.stringify(input)]);
      outbox = { input_json: JSON.stringify(input) };
    }
    workshop.db.run("UPDATE requests SET status='dispatching',error=NULL WHERE id=?", [requestId]);
    workshop.db.run('UPDATE request_dispatch SET claimed_at=? WHERE request_id=?', [now(), requestId]);
    return { request, input: JSON.parse(outbox.input_json) };
  }).immediate();
  if (!row.input) return row.request;
  try {
    const dispatchConfig = config!.activityWebhookUrl && (!row.input.workshopId || row.input.activityGeneration===undefined)
      ? {...config!,definitionId:config!.previousDefinitionId!,credentialFile:config!.previousCredentialFile,credentialEnv:config!.previousCredentialEnv,activityWebhookUrl:undefined}
      : config!;
    if (!submit) demand(dispatchConfig.definitionId && (dispatchConfig.credentialFile||dispatchConfig.credentialEnv),409,'Legacy dispatch requires its original managed grant');
    const accepted = await (submit ?? (input => new ManagedPipelineClient(dispatchConfig).submit(input)))(row.input);
    workshop.db.transaction(() => {
      bindRun(workshop.db, requestId, accepted.runId);
      bindActivityAuthority(workshop.db,requestId,accepted.runId,row.input,dispatchConfig);
      workshop.db.run("UPDATE requests SET status='building',error=NULL WHERE id=? AND status IN ('dispatching','dispatch_pending')", [requestId]);
      workshop.db.run('INSERT OR IGNORE INTO dispatch_receipts(request_id,run_id,receipt_json) VALUES(?,?,?)', [requestId, accepted.runId, JSON.stringify(accepted.receipt)]);
    }).immediate();
  } catch {
    // An uncertain HTTP outcome never gets a new request ID or a changed snapshot.
    workshop.db.run("UPDATE requests SET status='dispatch_pending',error='Dispatch needs reconnection. Retry this saved request; it will use the same execution ID.' WHERE id=? AND run_id IS NULL", [requestId]);
  }
  return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);
}


export async function resumeFollowup(workshop: Workshop, member: Member, projectId: string, requestId: string, config?: FollowupConfig,
  transport?: { poll: (id: string) => Promise<any>; submit: (input: any, executionKey: string) => Promise<{ runId: string; receipt: unknown }> }) {
  const project = workshop.project(member, projectId, !member.host);
  demand(!unresolvedNativeExecution(workshop.db,projectId,requestId),409,'Another native execution needs reconciliation first');
  demand(followupAvailable(project, config), 403, 'Follow-up execution is not activated for this owner and project');
  config = projectRoute(project,config)!;
  if (config?.replacementEnabled) return dispatchReplacement(workshop,member,projectId,requestId,config,transport);
  const saved = workshop.db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,projectId) as any;
  demand(saved,404,'Saved request not found');
  let recovery = workshop.db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
  if (!recovery && saved.status !== 'failed') return dispatchFollowup(workshop,member,projectId,requestId,config);
  const client = transport ?? new ManagedPipelineClient(config!);
  if (!recovery) {
    // Poll uses the managed broker's signed receipt and owned run grant. No browser run IDs.
    const previousClient = !transport && config?.previousDefinitionId && (config.previousCredentialFile||config.previousCredentialEnv) ? new ManagedPipelineClient({ ...config,definitionId:config.previousDefinitionId,credentialFile:config.previousCredentialFile,credentialEnv:config.previousCredentialEnv }) : client;
    const original = (await previousClient.poll(saved.run_id)).response;
    const turn = original?.result?.turn;
    demand(original?.runId === saved.run_id && original.status === 'error' &&
      turn?.status === 'preparing' && turn.error === 'Completed-turn bound session unavailable' &&
      turn.requestId === requestId && turn.projectId === projectId && turn.conversationKey === project.conversation_id &&
      !turn.sessionId && !turn.executionId && !turn.nativeSessionId && !turn.reply && !!turn.receiptId,
      409,'This failed request has no verified pre-send recovery; it will not be replayed');
    const outbox = workshop.db.query('SELECT input_json FROM request_dispatch WHERE request_id=?').get(requestId) as any;
    demand(outbox,409,'Original dispatch snapshot is unavailable');
    const input = { ...JSON.parse(outbox.input_json), workshopId:workshop.id, activityGeneration:'0', nativeRequestId:requestId, recoverPreparation: true };
    workshop.db.run('INSERT OR IGNORE INTO request_recoveries(request_id,previous_run,execution_key,input_json) VALUES(?,?,?,?)',
      [requestId,saved.run_id,requestId+':preparation-recovery',JSON.stringify(input)]);
    recovery = workshop.db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
  }
  if (recovery.new_run) return saved;
  const claimed = workshop.db.transaction(() => {
    const current = workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId) as any;
    const entry = workshop.db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
    if (entry.new_run || (current.status === 'dispatching' && now()-entry.claimed_at < 30)) return false;
    demand(current.run_id === entry.previous_run && ['failed','dispatching','dispatch_pending'].includes(current.status),409,'Recovery state changed');
    demand(project.current_revision === current.expected_revision,409,'Project changed; saved request cannot be replayed');
    const owner = workshop.membership(project.owner);
    demand(owner.state === 'admitted' && (current.mode === 'answer' || owner.allowance > 0),403,'Project owner cannot execute requests');
    demand(!workshop.roomRow().paused,403,'The host has paused building');
    demand(!workshop.db.query("SELECT id FROM requests WHERE project_id=? AND id<>? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(projectId,requestId),409,'A request is already running for this project');
    workshop.db.run("UPDATE requests SET status='dispatching',error=NULL WHERE id=?",[requestId]);
    workshop.db.run('UPDATE request_recoveries SET claimed_at=? WHERE request_id=?',[now(),requestId]); return true;
  }).immediate();
  if (!claimed) return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);
  try {
    const accepted = await client.submit(JSON.parse(recovery.input_json),recovery.execution_key);
    workshop.db.transaction(() => {
      demand(workshop.db.run("UPDATE requests SET run_id=?,status='building',error=NULL WHERE id=? AND run_id=?",[accepted.runId,requestId,recovery.previous_run]).changes === 1,409,'Recovery run binding changed');
      bindActivityAuthority(workshop.db,requestId,accepted.runId,JSON.parse(recovery.input_json),config!);
      const previous=workshop.db.query('SELECT result_json FROM delivery_receipts WHERE request_id=? AND run_id=? ORDER BY created_at DESC LIMIT 1').get(requestId,recovery.previous_run) as any;
      bindActivityRecovery(workshop.db,accepted.runId,requestId,JSON.parse(recovery.input_json),previous?JSON.parse(previous.result_json).result?.turn:null);
      workshop.db.run('UPDATE request_recoveries SET new_run=?,receipt_json=? WHERE request_id=?',[accepted.runId,JSON.stringify(accepted.receipt),requestId]);
    }).immediate();
  } catch {
    workshop.db.run("UPDATE requests SET status='dispatch_pending',error='Saved conversation recovery needs reconnection. Retry this same saved request.' WHERE id=? AND run_id=?",[requestId,recovery.previous_run]);
  }
  return workshop.db.query('SELECT * FROM requests WHERE id=?').get(requestId);
}
