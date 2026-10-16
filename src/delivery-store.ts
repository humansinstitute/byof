import { verifyActivityFinal } from './activity-store.ts';
import {installAgentPublication} from './agent-publication.ts';
import { confirmedPreSend } from './pre-send-recovery.ts';
import { requireRemoteVersion } from "./storage.ts";
import { readLocalCandidate, promoteLocalCandidate } from "./local-builds.ts";
import { Workshop } from "./workshop.ts";
import { validateGeneratedHtml } from "./pipeline/artifact.ts";
import type { Database } from "bun:sqlite";
import { applyDelivery, DeliveryDenied, type VerifiedDelivery } from "./pipeline/receiver.ts";
import { now } from "./auth.ts";
import { demand, HttpError } from "./errors.ts";
import { limits } from "./config.ts";
export function installDeliveryTables(db: Database) {
  installAgentPublication(db);
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts (delivery_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES requests(id), body_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dispatch_receipts(request_id TEXT PRIMARY KEY REFERENCES requests(id),run_id TEXT NOT NULL,receipt_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS build_receipts(request_id TEXT PRIMARY KEY REFERENCES requests(id),revision_id TEXT NOT NULL REFERENCES revisions(id),receipt_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_recoveries(request_id TEXT PRIMARY KEY REFERENCES requests(id),previous_run TEXT NOT NULL,execution_key TEXT NOT NULL UNIQUE,input_json TEXT NOT NULL,claimed_at INTEGER NOT NULL DEFAULT 0,new_run TEXT,receipt_json TEXT);
    CREATE TABLE IF NOT EXISTS automatic_recovery(request_id TEXT PRIMARY KEY REFERENCES requests(id),attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS delivery_events (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
  repairStaleBuildingRequests(db);
}

export function repairStaleBuildingRequests(db: Database) {
  return db.run(`UPDATE requests
    SET status='execution_uncertain',
        error='Checking the previous build before retrying. Your last saved app is still available.'
    WHERE status='building'
      AND run_id IS NOT NULL
      AND (SELECT d.status
           FROM delivery_receipts d
           WHERE d.request_id=requests.id AND d.run_id=requests.run_id
           ORDER BY d.created_at DESC,d.rowid DESC
           LIMIT 1)='execution_uncertain'`).changes;
}
// Bind only from an accepted server-side dispatch receipt. No browser route accepts run IDs.
export function bindRun(db: Database, requestId: string, runId: string) {
  demand(typeof runId === "string" && runId.length > 0 && runId.length <= 200, 400, "Invalid accepted run");
  const request = db.query("SELECT run_id FROM requests WHERE id=?").get(requestId) as any;
  demand(request && (!request.run_id || request.run_id === runId), 409, "Request/run binding conflict");
  db.run("UPDATE requests SET run_id=? WHERE id=?", [runId, requestId]);
}
export function storeDelivery(db: Database, delivery: VerifiedDelivery, workshop?: Workshop) {
  return db.transaction(() => applyDelivery(delivery, {
    hasEvent: id => !!db.query("SELECT event_id FROM delivery_events WHERE event_id=?").get(id),
    deliveryHash: id => (db.query("SELECT body_hash FROM delivery_receipts WHERE delivery_id=?").get(id) as any)?.body_hash || null,
    requestForRun: runId => { const row = db.query("SELECT id,project_id FROM requests WHERE run_id=?").get(runId) as any; return row ? { requestId: row.id, projectId: row.project_id } : null; },
    apply: verified => {
      const envelope = verified.envelope;
      const request = db.query("SELECT r.*,p.owner FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.run_id=?").get(envelope.runId) as any;
      if (!request) throw new DeliveryDenied("unknown_run");
      const projectScope=db.query("SELECT workshop_id FROM projects WHERE id=?").get(request.project_id) as any;
      if(workshop){workshop=new Workshop(db,workshop.assets,projectScope.workshop_id);}
      if (["succeeded", "failed", "banned", "classifier_error", "cancelled"].includes(request.status)) throw new DeliveryDenied("request_already_terminal");
      const epochMapping = db.query('SELECT * FROM (SELECT * FROM request_epoch_history UNION ALL SELECT * FROM request_epochs) WHERE request_id=? ORDER BY generation DESC LIMIT 1').get(request.id) as any;
      const activeEpoch = db.query('SELECT * FROM builder_epochs WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(request.project_id) as any;
      if (activeEpoch && (activeEpoch.state !== 'active' || (epochMapping ? epochMapping.generation !== activeEpoch.generation : activeEpoch.generation !== 0))) throw new DeliveryDenied('retired_generation_callback');
      const result = envelope.result;
      if (envelope.status === "ok" && ['build_completed','answer_completed','message_completed'].includes(String(result?.action))) {
        if (!workshop) throw new HttpError(503, "Artifact validator unavailable");
        const receipt = result!.nativeReceipt as any;
        if (!receipt || receipt.requestId !== request.id || receipt.projectId !== request.project_id || receipt.invocationRunId !== envelope.runId || !receipt.receiptId || !receipt.nativeSessionId || !receipt.sessionId || (!Number.isInteger(receipt.sequence) || receipt.sequence < 1)) throw new DeliveryDenied("native_receipt_denied");
        verifyActivityFinal(db,envelope.runId,request.id,receipt);
        const activityTurn=db.query('SELECT * FROM activity_turns WHERE run_id=?').get(envelope.runId) as any;
        if(activityTurn && (receipt.receiptId!==activityTurn.turn_id || receipt.sessionId!==activityTurn.session_id || (receipt.stepId!==undefined && receipt.stepId!==activityTurn.step_id) || (receipt.runId!==undefined && receipt.runId!==activityTurn.run_id)))throw new DeliveryDenied('activity_final_lineage_denied');
        const project = db.query("SELECT * FROM projects WHERE id=?").get(request.project_id) as any;
        const prior = db.query("SELECT native_id,sequence FROM conversation_receipts WHERE project_id=?").get(project.id) as any;
        // Upgrade legacy successful builds lazily, without rewriting their receipts.
        const legacy = !prior ? db.query("SELECT b.receipt_json FROM build_receipts b JOIN requests r ON r.id=b.request_id WHERE r.project_id=? AND r.id<>? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1").get(project.id,request.id) as any : null;
        const last = prior || (legacy ? (() => { const r = JSON.parse(legacy.receipt_json); return { native_id:r.nativeSessionId, sequence:r.sequence }; })() : null);
        if (epochMapping) {
          if (!activeEpoch.native_id && last && receipt.nativeSessionId === last.native_id) throw new DeliveryDenied('replacement_lineage_denied');
          if (receipt.generation !== epochMapping.generation || receipt.nativeRequestId !== epochMapping.native_request_id || receipt.contextHash !== epochMapping.context_hash || receipt.conversationKey !== activeEpoch.conversation_key ||
            (activeEpoch.native_id && (receipt.nativeSessionId !== activeEpoch.native_id || receipt.sequence <= activeEpoch.sequence)) || (!activeEpoch.native_id && receipt.sequence !== 1)) throw new DeliveryDenied('replacement_lineage_denied');
        }
        if (!epochMapping && ((last && (receipt.nativeSessionId !== last.native_id || receipt.sequence <= last.sequence)) ||
            (receipt.conversationKey !== undefined && receipt.conversationKey !== project.conversation_id))) throw new DeliveryDenied('conversation_continuity_denied');
        const messageOnly=result!.action==='message_completed';
        const publication=db.query('SELECT * FROM agent_publications WHERE request_id=?').get(request.id) as any;
        if(messageOnly){
          const inputRow=db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(request.id) as any;
          if(!inputRow||JSON.parse(inputRow.input_json).replacementContext?.fileBuild?.publication!=='agent-tool-v1'||result!.source!==undefined||result!.artifactPath!==undefined||result!.remoteStorage!==undefined)throw new DeliveryDenied('message_protocol_denied');
          if(publication){const n=JSON.parse(publication.candidate_json).nativeReceipt;if(['receiptId','sessionId','nativeSessionId','runId','stepId','sequence','generation','contextHash'].some(k=>n[k]!==receipt[k]))throw new DeliveryDenied('publication_final_lineage_denied');}
        }
        const answer = messageOnly || result!.action === 'answer_completed';
        if ((!messageOnly && answer && request.mode === 'build') || (!answer && request.mode === 'answer') ||
            (answer && result!.source !== undefined)) throw new DeliveryDenied('conversation_mode_denied');
        const response = result!.response;
        if ((answer || receipt.conversationKey !== undefined) && (typeof response !== 'string' || !response.trim() || response.length > limits.responseChars)) throw new DeliveryDenied('response_required');
        const owner = workshop.projectOwnerAccess(project.owner);
        let status = 'succeeded', error: string | null = null;
        if(messageOnly&&publication?.status!=='published'&&publication){status='storage_pending';error='Publication needs retry. Your previous version is preserved.';}
        else if(messageOnly&&request.mode==='build'&&publication?.status!=='published'){status='failed';error='The agent finished without publishing an app. Your previous version is preserved; no allowance was charged.';}
        if (owner.state !== 'admitted' || (!answer && owner.allowance <= 0)) { status='failed'; error='Membership changed; result was not applied.'; }
        else if (!answer && project.current_revision !== request.expected_revision) { status='failed'; error='Project changed during build; candidate was not promoted. Your saved version is preserved.'; }
        else if (!answer) {
          let source: string | null = null, local: ReturnType<typeof readLocalCandidate> | undefined;
          const allocation=db.query('SELECT request_id,storage_required FROM local_builds WHERE request_id=?').get(request.id);
          try { if(allocation){local=readLocalCandidate(workshop,request,result);source=local.source;}else source = validateGeneratedHtml(result!.source); } catch { status='failed'; error='The generated app did not pass validation. Your last playable version is preserved; no allowance was charged.'; }
          if (source !== null) {
            const remote=local&&(local.row.storage_required||result!.remoteStorage)?requireRemoteVersion(workshop,request,result,local.hash):null;
            if(local)promoteLocalCandidate(local);
            const hostSubmission=db.query('SELECT actor FROM host_request_audit WHERE request_id=?').get(request.id) as any;
            const revision = workshop.addRevision(project, workshop.assets.put(source), hostSubmission?.actor??project.owner);
            if(remote)db.run('INSERT INTO remote_versions VALUES(?,?,?)',[revision,remote.jobId,JSON.stringify(remote.artifact)]);
            db.run("INSERT INTO build_receipts VALUES(?,?,?)", [request.id, revision, JSON.stringify({...receipt,...(local?{artifact:{path:`v${local.row.version}/index.html`,version:local.row.version,sha256:local.hash,url:`/api/v1/projects/${project.id}/preview?revision=${revision}`,validation:result!.validation,hosting:remote?'tower-private-s3':'authenticated-workshop',...(remote?{remoteStorage:remote.artifact,jobId:remote.jobId}:{})}}:{})})]);
            if(local)db.run("UPDATE local_builds SET status='completed',source_hash=?,revision_id=? WHERE request_id=?",[local.hash,revision,request.id]);
            workshop.charge(project.owner);
          }
        }
        if (epochMapping) db.run('UPDATE builder_epochs SET native_id=?,sequence=? WHERE project_id=? AND generation=?',[receipt.nativeSessionId,receipt.sequence,project.id,epochMapping.generation]);
        db.run('INSERT INTO conversation_receipts VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET native_id=excluded.native_id,sequence=excluded.sequence,receipt_json=excluded.receipt_json', [project.id,receipt.nativeSessionId,receipt.sequence,JSON.stringify(receipt)]);
        db.run("UPDATE requests SET status=?,error=?,response=? WHERE id=?", [status,error,typeof response === 'string' ? response : status === 'succeeded' ? 'Your updated app is ready to play.' : null,request.id]);
        if(messageOnly)db.run('INSERT INTO final_message_receipts VALUES(?,?,?,?,?)',[request.id,envelope.runId,JSON.stringify(receipt),String(response),now()]);
        db.run("INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)", [envelope.deliveryId, envelope.runId, request.id, verified.bodyHash, status, JSON.stringify(envelope), now()]);
        return;
      }
      if(envelope.status==='ok' && result?.action==='builder_abandoned'){
        const recovery=db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(request.id) as any;
        const input=recovery?JSON.parse(recovery.input_json):null,r=result.nativeReceipt as any;
        if(!input?.abandonUncertain || !r || r.status!=='abandoned' || r.requestId!==request.id || r.projectId!==request.project_id || r.nativeRequestId!==input.nativeRequestId || r.conversationKey!==input.conversationKey || r.generation!==input.generation || r.contextHash!==input.contextHash || r.invocationRunId!==envelope.runId || !r.receiptId || !r.sessionId || r.output?.writerStopped!==true || r.output.abandonedReceiptId!==r.receiptId)throw new DeliveryDenied('abandonment_correlation_denied');
        verifyActivityFinal(db,envelope.runId,request.id,r);
        db.run("UPDATE requests SET status='failed',error='Reconnecting with your saved conversation and app. The previous builder has stopped.' WHERE id=?",[request.id]);
        db.run('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)',[envelope.deliveryId,envelope.runId,request.id,verified.bodyHash,'failed',JSON.stringify(envelope),now()]);return;
      }
      if(envelope.status==='ok'&&result?.action==='storage_pending'){
        const job=db.query('SELECT * FROM storage_jobs WHERE id=? AND request_id=?').get(String(result.jobId),request.id) as any;
        if(!job||job.original_run_id!==envelope.runId)throw new DeliveryDenied('storage_pending_correlation_denied');
        const candidate=JSON.parse(job.candidate_json),response=result.response;
        if(typeof response!=='string'||!response.trim()||response.length>limits.responseChars||response!==candidate.response||JSON.stringify(result.nativeReceipt)!==JSON.stringify(candidate.nativeReceipt))throw new DeliveryDenied('storage_pending_response_denied');
        verifyActivityFinal(db,envelope.runId,request.id,result.nativeReceipt);
        db.run("UPDATE requests SET status='storage_pending',error='Your tested build is saved. Private storage needs a retry; the previous version remains playable.',response=? WHERE id=?",[response,request.id]);
        db.run('UPDATE storage_jobs SET error=? WHERE id=?',[String(result.error||'Storage pending'),job.id]);
        db.run('INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)',[envelope.deliveryId,envelope.runId,request.id,verified.bodyHash,'storage_pending',JSON.stringify(envelope),now()]);return;
      }
      const nativeTurn = envelope.result?.turn as any;
      if(nativeTurn)verifyActivityFinal(db,envelope.runId,request.id,nativeTurn);
      const activityTurn=db.query('SELECT * FROM activity_turns WHERE run_id=?').get(envelope.runId) as any;
      if(activityTurn && nativeTurn && (nativeTurn.receiptId!==activityTurn.turn_id || nativeTurn.sessionId!==activityTurn.session_id || (nativeTurn.stepId!==undefined && nativeTurn.stepId!==activityTurn.step_id) || (nativeTurn.runId!==undefined && nativeTurn.runId!==activityTurn.run_id)))throw new DeliveryDenied('activity_final_lineage_denied');
      const recoveryInput=db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(request.id) as any;
      const originalInput=recoveryInput?JSON.parse(recoveryInput.input_json):null;
      const originalProject=db.query('SELECT conversation_id FROM projects WHERE id=?').get(request.project_id) as any;
      const provenMissing = confirmedPreSend(envelope,{requestId:originalInput?.nativeRequestId??request.id,projectId:request.project_id,conversationKey:originalInput?.conversationKey??originalProject.conversation_id});
      const provenPreparation = envelope.error === 'followup_scope_denied' && !envelope.result?.conversationInput && !nativeTurn;
      const executionUncertain = envelope.status !== 'ok' && !provenMissing && !provenPreparation && nativeTurn?.status !== 'completed';
      let status = executionUncertain ? 'execution_uncertain' : "failed", message = envelope.error === "Completed-turn bound session unavailable" ? "Your saved question is waiting for native conversation resume activation. No agent reply or app change was produced; no allowance was charged." : "The agent could not complete this request. Your last saved app is preserved.";
      if (envelope.status === "ok" && result?.action === "ban") {
        if(projectScope.workshop_id===(db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id)db.run("UPDATE members SET state='banned' WHERE pubkey=?", [request.owner]);else db.run("UPDATE workshop_members SET state='banned' WHERE workshop_id=? AND pubkey=?",[projectScope.workshop_id,request.owner]);
        db.run("UPDATE projects SET hidden=1 WHERE owner=? AND workshop_id=?", [request.owner,projectScope.workshop_id]);
        db.run("UPDATE consent SET granted=0,updated_at=? WHERE author=? AND project_id IN (SELECT id FROM projects WHERE workshop_id=?)", [now(), request.owner,projectScope.workshop_id]);
        db.run("UPDATE requests SET status='cancelled',error='Membership banned' WHERE project_id IN (SELECT id FROM projects WHERE owner=? AND workshop_id=?) AND id<>? AND status IN ('accepted','queued','dispatching','dispatch_pending','screening','building')", [request.owner,projectScope.workshop_id,request.id]);
        db.run("INSERT INTO moderation(id,actor,member,action,created_at,workshop_id) VALUES(?,?,?,?,?,?)", [crypto.randomUUID(), "verified-pipeline", request.owner, JSON.stringify(result.policyEvidence), now(),projectScope.workshop_id]);
        status = "banned"; message = "This room access was removed after the verified screening result. The host can review and reverse it.";
      } else if (envelope.status === "ok" && result?.action === "classifier_error") { status = "classifier_error"; message = "Screening unavailable; no builder ran and no ban was applied. Retry after service configuration is restored."; }
      else if (envelope.status === "ok" && result?.action === "build_failed") { message = "Build failed; the last successful version is preserved."; }
      else if (envelope.status === "cancelled") { status = "cancelled"; message = "Pipeline cancelled; last successful version preserved."; }
      if (provenMissing) message = 'Reconnecting your builder. Your request and last saved app are safe; no build allowance was used.';
      if (executionUncertain) message = 'Checking the previous build before retrying. Your last saved app is still available.';
      let response = typeof result?.response === 'string' ? result.response : typeof result?.reply === 'string' ? result.reply : null;
      if(response===null && nativeTurn?.status==='completed' && typeof nativeTurn.reply==='string') {
        response=nativeTurn.reply;
        // Compatibility for already owned receipt-protocol runs only. Active
        // agent-tool requests always deliver the complete prose verbatim.
        if(originalInput?.replacementContext?.fileBuild?.publication!=='agent-tool-v1'){
          try {const parsed=JSON.parse(nativeTurn.reply.trim().replace(/^```(?:json)?\s*\n/,'').replace(/\n```$/,''));if(typeof parsed.response==='string')response=parsed.response;}catch{}
        }
      }
      if (response && response.length > limits.responseChars) throw new DeliveryDenied('response_too_large');
      db.run("UPDATE requests SET status=?,error=?,response=? WHERE id=?", [status, message, response, request.id]);
      db.run("INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)", [envelope.deliveryId, envelope.runId, request.id, verified.bodyHash, status, JSON.stringify(envelope), now()]);
    },
    recordEvent: eventId => { db.run("INSERT INTO delivery_events VALUES(?,?)", [eventId, now()]); },
  }))();
}
