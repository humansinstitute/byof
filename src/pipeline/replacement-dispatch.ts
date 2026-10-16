import {bindBuilderEpoch,runtimeAvailable,sameBuilderRuntime} from './builder-runtime.ts';
import {requestBuilderEngine,equalBuilderRuntime} from '../builder-engine.ts';
import { confirmedPreSend } from '../pre-send-recovery.ts';
import { bindActivityAuthority, bindActivityRecovery } from '../activity-store.ts';
import { allocateLocalBuild } from "../local-builds.ts";
import { join, resolve } from "node:path";
import { sha256 } from "../assets.ts";
import { projectRoute,workshopBuilders } from "../project-routing.ts";
import { unresolvedNativeExecution } from "../native-uncertainty.ts";
import type { Workshop } from '../workshop.ts';
import type { Member } from '../auth.ts';
import type { FollowupConfig } from '../config.ts';
import { builderEpoch, nextEpoch, replacementSnapshot } from '../builder-lifecycle.ts';
import { demand } from '../errors.ts';
import { now } from '../auth.ts';
import {neverDispatched,preparationFailed} from '../queued-recovery.ts';
import { ManagedPipelineClient } from './managed-client.ts';
import {materializeRequestAttachments} from '../chat-attachments.ts';
type Transport={poll:(id:string)=>Promise<any>;submit:(input:any,key:string)=>Promise<any>};
function missingBeforeSend(result:any,requestId:string,projectId:string,key:string) {
  const turn=result?.result?.turn;
  return result?.status==='error' && turn?.status==='preparing' &&
    ['Completed-turn bound session unavailable','No available agent ports. Increase AGENT_MAX or free sessions.'].includes(turn.error) &&
    turn.requestId===requestId && turn.projectId===projectId && turn.conversationKey===key &&
    !turn.sessionId && !turn.executionId && !turn.nativeSessionId && !turn.reply && !!turn.receiptId;
}
export async function dispatchReplacement(workshop:Workshop,member:Member,projectId:string,requestId:string,config:FollowupConfig,transport?:Transport,options:{automatic?:boolean}={}):Promise<any> {
  workshop.project(member,projectId,!member.host);
  try{return await prepareReplacement(workshop,member,projectId,requestId,config,transport,options);}
  catch(error){return preparationFailed(workshop,projectId,requestId,error);}
}
async function prepareReplacement(workshop:Workshop,member:Member,projectId:string,requestId:string,config:FollowupConfig,transport?:Transport,options:{automatic?:boolean}={}):Promise<any> {
  const project=workshop.project(member,projectId,!member.host);
  demand(!unresolvedNativeExecution(workshop.db,projectId,requestId),409,'Native execution is uncertain; this project is fenced');
  config=projectRoute(project,config)!;
  demand(config && config.replacementEnabled && !config.suspended && project.id===config.projectId && project.owner===config.ownerPubkey && project.conversation_id===config.conversationKey,403,'Replacement not activated for this project');
  const db=workshop.db;
  const saved=db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(requestId,projectId) as any;
  demand(saved,404,'Saved request not found');
  if(!workshop.storageReady&&saved.mode==='build'&&!saved.run_id){db.run("UPDATE requests SET status='unavailable',error='Private storage needs authorization before app changes can run. Your request is saved; questions are still available.' WHERE id=?",[requestId]);return db.query('SELECT * FROM requests WHERE id=?').get(requestId);}
  let recovery=db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
  if(config.selectableBuilder){
    const choice=requestBuilderEngine(db,requestId),original=recovery?JSON.parse(recovery.input_json):null;
    if(!choice||(original&&original.builderEngineRevision===undefined)){
      demand(config.receiptRecovery,409,'Saved request requires its original builder recovery grant');
      return dispatchReplacement(workshop,member,projectId,requestId,workshopBuilders(config.receiptRecovery)!,transport,options);
    }
    demand(!original||original.builderEngineRevision===choice.revision&&equalBuilderRuntime(original.builderRuntime,choice.runtime),409,'Saved builder engine snapshot mismatch');
    config={...config,builderRuntime:choice.runtime};
  }
  demand(!config.builderRuntime||runtimeAvailable(config,config.builderRuntime),503,'Saved builder engine is not activated');
  const client=transport ?? new ManagedPipelineClient(config);
  if(!config.selectableBuilder&&config.builderRuntime&&recovery&&!sameBuilderRuntime(JSON.parse(recovery.input_json).builderRuntime)){
    demand(config.receiptRecovery&&!config.receiptRecovery.builderRuntime,409,'Previous native request needs its original Codex recovery pipeline before Goose migration');
    return dispatchReplacement(workshop,member,projectId,requestId,workshopBuilders(config.receiptRecovery)!,transport,options);
  }
  if(config.agentPublication&&config.receiptRecovery&&recovery&&JSON.parse(recovery.input_json).replacementContext?.fileBuild?.publication!=='agent-tool-v1'){
    return dispatchReplacement(workshop,member,projectId,requestId,workshopBuilders(config.receiptRecovery)!,transport,options);
  }
  let proof:any=null,proofKind:'missing'|'preparation'|'unsent'|'reconcile'|'abandoned'|null=null;
  if(['failed','execution_uncertain'].includes(saved.status)) {
    const original=recovery ? JSON.parse(recovery.input_json):null;
    let poller:Transport|ManagedPipelineClient=client;
    if(!transport){
      const acceptance=recovery?.receipt_json ? JSON.parse(recovery.receipt_json):null;
      const failedPreparation=recovery && config.failedPreparationDefinitionId && acceptance?.receipt?.url?.includes(encodeURIComponent(config.failedPreparationDefinitionId));
      if(failedPreparation && (config.failedPreparationCredentialFile||config.failedPreparationCredentialEnv))poller=new ManagedPipelineClient({...config,definitionId:config.failedPreparationDefinitionId!,credentialFile:config.failedPreparationCredentialFile,credentialEnv:config.failedPreparationCredentialEnv});
      else if(config.previousDefinitionId && (config.previousCredentialFile||config.previousCredentialEnv) && (!recovery || acceptance?.receipt?.url?.includes(encodeURIComponent(config.previousDefinitionId))))poller=new ManagedPipelineClient({...config,definitionId:config.previousDefinitionId,credentialFile:config.previousCredentialFile,credentialEnv:config.previousCredentialEnv});
    }
    // The managed client verifies the app-signed owned-run receipt before returning evidence.
    proof=await poller.poll(saved.run_id);
    const failed=proof.response,epoch=builderEpoch(workshop,project);
    demand(failed?.runId===saved.run_id,409,'Failed run evidence mismatch');
    if(missingBeforeSend(failed,original?.nativeRequestId??requestId,projectId,original?.conversationKey??epoch.conversation_key))proofKind='missing';
    else if(confirmedPreSend(failed) && failed.result.turn.requestId===(original?.nativeRequestId??requestId) && failed.result.turn.projectId===projectId && failed.result.turn.conversationKey===(original?.conversationKey??epoch.conversation_key))proofKind='unsent';
    else if(original && failed.status==='error' && ['followup_scope_denied','builder_runtime_snapshot_denied','remote_builder_authority_mismatch'].includes(failed.error) && !failed.result?.conversationInput && !failed.result?.turn && failed.result?.requestId===requestId && failed.result?.projectId===projectId && failed.result?.generation===original.generation && failed.result?.contextHash===original.contextHash && failed.result?.nativeRequestId===original.nativeRequestId && failed.result?.conversationKey===original.conversationKey)proofKind='preparation';
    if(!proofKind && original && failed.status==='error' && ['preparing','sending','uncertain','abandoning'].includes(failed.result?.turn?.status) && !!failed.result.turn.sessionId && failed.result.turn.requestId===original.nativeRequestId && failed.result.turn.projectId===projectId && failed.result.turn.conversationKey===original.conversationKey && failed.result.turn.receiptId && !failed.result.turn.blockedBy)proofKind='reconcile';
    if(!proofKind && original && failed.status==='error' && failed.result?.turn?.status==='preparing' &&
      failed.result.turn.error==='Completed-turn launch outcome uncertain; requires session binding recovery' &&
      failed.result.turn.requestId===original.nativeRequestId && failed.result.turn.projectId===projectId &&
      failed.result.turn.conversationKey===original.conversationKey && failed.result.turn.receiptId &&
      !failed.result.turn.sessionId && !failed.result.turn.executionId && !failed.result.turn.nativeSessionId && !failed.result.turn.reply){
      const previousAttempt=db.query('SELECT receipt_json FROM replacement_attempts WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(requestId) as any;
      const previous=previousAttempt?JSON.parse(previousAttempt.receipt_json):null;
      if(previous?.input===recovery?.input_json && missingBeforeSend(previous?.proof?.response,original.nativeRequestId,projectId,original.conversationKey))proofKind='missing';
    }
    if(!proofKind && original?.abandonUncertain && failed.status==='ok' && failed.result?.action==='builder_abandoned'){
      const r=failed.result.nativeReceipt;
      if(r?.requestId===requestId && r.projectId===projectId && r.nativeRequestId===original.nativeRequestId && r.conversationKey===original.conversationKey && r.generation===original.generation && r.contextHash===original.contextHash && r.invocationRunId===saved.run_id && r.status==='abandoned' && r.receiptId && r.output?.writerStopped===true && r.output.abandonedReceiptId===r.receiptId)proofKind='abandoned';
    }
    if(!proofKind && original?.abandonUncertain && failed.status==='error'){
      const r=failed.result?.turn;
      if(r?.status==='abandoned' && r.requestId===original.nativeRequestId && r.projectId===projectId && r.conversationKey===original.conversationKey && r.invocationRunId===saved.run_id && r.receiptId && r.sessionId && r.output?.writerStopped===true && r.output.abandonedReceiptId===r.receiptId)proofKind='abandoned';
    }
    demand(proofKind,409,'No verified recovery evidence; the saved request will not be replayed');
  }
  if(workshop.datasetDiscovery&&!recovery)workshop.datasetSnapshot=await workshop.datasetDiscovery(member);
  const claimed=db.transaction(()=>{
    const current=db.query('SELECT * FROM requests WHERE id=?').get(requestId) as any;
    // Cancellation/new submission can win while dataset discovery or polling
    // awaits. Never allocate a generation or launch from a terminal request.
    if(!['failed','execution_uncertain','queued','unavailable','dispatch_pending','dispatching'].includes(current.status))return null;
    recovery=db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
    if(!proof&&!recovery)demand(neverDispatched(db,current),409,'Saved request has dispatch evidence; reconcile its original execution');
    if(proof && (!['failed','execution_uncertain'].includes(current.status)||current.run_id!==saved.run_id))return null;
    if(!proof && (recovery?.new_run || current.status==='succeeded'))return null;
    if(recovery && current.status==='dispatching' && now()-recovery.claimed_at<30)return null;
    if(options.automatic)demand(!db.query('SELECT id FROM requests WHERE project_id=? AND rowid>(SELECT rowid FROM requests WHERE id=?) LIMIT 1').get(projectId,requestId),409,'A newer saved instruction supersedes automatic recovery');
    const freshProject=workshop.project(member,projectId,!member.host);
    demand(freshProject.current_revision===current.expected_revision,409,'Project changed; saved request cannot be replayed');
    const owner=workshop.membership(project.owner);
    demand(owner.state==='admitted' && (current.mode==='answer'||owner.allowance>0),403,'Project owner cannot execute requests');
    demand(!workshop.roomRow().paused,403,'The host has paused building');
    demand(!db.query("SELECT id FROM requests WHERE project_id=? AND id<>? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(projectId,requestId),409,'A request is already running');
    let epoch=builderEpoch(workshop,freshProject);
    demand(epoch.state!=='deleting',409,'Native deletion is pending; this builder is fenced');
    if(proof){
      if(recovery){const original=JSON.parse(recovery.input_json);demand(original.generation===epoch.generation && original.conversationKey===epoch.conversation_key,409,'Failed request belongs to a retired generation');}
      db.run('INSERT OR IGNORE INTO replacement_attempts VALUES(?,?,?,?)',[requestId,current.run_id,JSON.stringify({input:recovery?.input_json??null,acceptance:recovery?.receipt_json??null,proof}),now()]);
    }
    const previousAttempts=(db.query('SELECT count(*) n FROM replacement_attempts WHERE request_id=?').get(requestId) as any).n;
    if(proofKind==='reconcile') {
      // Autopilot reconciles the existing send checkpoint. It will never send
      // this uncertain request again or launch a replacement writer.
      db.run('UPDATE request_recoveries SET previous_run=?,execution_key=?,new_run=NULL,receipt_json=NULL,claimed_at=0 WHERE request_id=?',[current.run_id,recovery.execution_key+':reconcile:'+previousAttempts,requestId]);
      if(config.abandonmentEnabled && previousAttempts>=2){
        const input={...JSON.parse(recovery.input_json),abandonUncertain:true};
        db.run('UPDATE request_recoveries SET execution_key=?,input_json=? WHERE request_id=?',[input.nativeRequestId+':abandon:'+previousAttempts,JSON.stringify(input),requestId]);
      }
    } else if(proofKind==='unsent' && recovery && (previousAttempts===1 || proof.response.result.turn.error==='Completed-turn session has unrelated queued prompts')) {
      // Retry the exact immutable native request, not the pipeline run ID.
      db.run('UPDATE request_recoveries SET previous_run=?,execution_key=?,new_run=NULL,receipt_json=NULL,claimed_at=0 WHERE request_id=?',[current.run_id,recovery.execution_key+':clean-resume',requestId]);
      if(config.abandonmentEnabled && previousAttempts>=2){
        const input={...JSON.parse(recovery.input_json),abandonUncertain:true};
        db.run('UPDATE request_recoveries SET execution_key=?,input_json=? WHERE request_id=?',[input.nativeRequestId+':abandon:'+previousAttempts,JSON.stringify(input),requestId]);
      }
    } else if(proofKind==='preparation') {
      db.run('UPDATE request_recoveries SET previous_run=?,execution_key=?,new_run=NULL,claimed_at=0 WHERE request_id=? AND new_run=?',[current.run_id,recovery.execution_key+':preparation:'+previousAttempts,requestId,current.run_id]);
    } else if(!recovery || proofKind==='missing' || proofKind==='unsent' || proofKind==='abandoned') {
      demand(proofKind==='missing' || proofKind==='unsent' || proofKind==='abandoned' || (!current.run_id && ['queued','unavailable'].includes(current.status)),409,'Active or uncertain request cannot replace its builder');
      if(proofKind==='missing' || proofKind==='unsent' || proofKind==='abandoned' || epoch.state==='retired' || (config.fileVersions && !recovery && (epoch.native_id || db.query('SELECT project_id FROM conversation_receipts WHERE project_id=?').get(projectId)) && !(db.query('SELECT request_id FROM local_builds WHERE project_id=? LIMIT 1').get(projectId))))epoch=nextEpoch(workshop,freshProject,proofKind==='abandoned'?'verified_stopped_fresh_context':proofKind==='unsent'?'verified_unsent_fresh_context':proofKind==='missing'?'verified_missing_before_send':config.fileVersions && epoch.state!=='retired'?'project_directory_migration':'owner_retired',proof);
      if(config.builderRuntime)epoch=bindBuilderEpoch(workshop,freshProject,config.builderRuntime);
      demand((epoch.generation>0 || config.initialContext) && epoch.state==='active',409,'Builder has not been retired or verified missing');
      const context=replacementSnapshot(workshop,freshProject,current,config.directory!,epoch),nativeRequestId=requestId+':generation:'+epoch.generation;
      const attachments=materializeRequestAttachments(workshop,requestId,config.directory!);
      (context.snapshot as any).attachments=attachments;
      if(config.fileVersions){
        let localDirectory=config.directory!;
        if(config.remotePreparation){
          demand(!!config.localBuilderRoot&&resolve(config.localBuilderRoot)===config.localBuilderRoot,503,'App-owned remote publication staging is unavailable');
          localDirectory=join(config.localBuilderRoot,workshop.id,freshProject.id);
        }
        (context.snapshot as any).fileBuild=allocateLocalBuild(workshop,freshProject,current,localDirectory,epoch.generation>0?requestId+':generation:'+epoch.generation:undefined,!config.remotePreparation);
        if(config.agentPublication)(context.snapshot as any).fileBuild.publication='agent-tool-v1';
      }
      context.contextHash=sha256(JSON.stringify(context.snapshot));
      const choice=config.selectableBuilder?requestBuilderEngine(db,requestId):undefined;
      const input={...(choice?{builderEngineRevision:choice.revision}:{}),...(config.builderRuntime?{builderRuntime:config.builderRuntime}:{}),...('builderPrompt' in context.snapshot ? {builderPrompt:context.snapshot.builderPrompt}:{}),requestId,projectId,workshopId:workshop.id,activityGeneration:String(epoch.generation),ownerPubkey:project.owner,conversationKey:epoch.conversation_key,prompt:current.prompt,attachments,mode:current.mode,source:context.snapshot.currentSource,generation:epoch.generation,nativeRequestId,contextHash:context.contextHash,replacementContext:context.snapshot};
      const mapping=[requestId,projectId,epoch.generation,nativeRequestId,context.contextHash,JSON.stringify(context.snapshot)];
      db.run('INSERT OR IGNORE INTO request_epochs VALUES(?,?,?,?,?,?)',mapping);
      db.run('INSERT INTO request_epoch_history VALUES(?,?,?,?,?,?)',mapping);
      db.run('INSERT INTO request_recoveries(request_id,previous_run,execution_key,input_json) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET previous_run=excluded.previous_run,execution_key=excluded.execution_key,input_json=excluded.input_json,new_run=NULL,receipt_json=NULL,claimed_at=0',[requestId,current.run_id||'',nativeRequestId,JSON.stringify(input)]);
    }
    recovery=db.query('SELECT * FROM request_recoveries WHERE request_id=?').get(requestId) as any;
    if(proof && config.activityWebhookUrl) {
      // A new authorized invocation adds server-derived correlation to legacy
      // snapshots without changing the native prompt, context hash or request ID.
      const input=JSON.parse(recovery.input_json);
      if(input.workshopId===undefined || input.activityGeneration===undefined) {
        input.workshopId=workshop.id;input.activityGeneration=String(input.generation??0);
        recovery.input_json=JSON.stringify(input);
        db.run('UPDATE request_recoveries SET input_json=? WHERE request_id=?',[recovery.input_json,requestId]);
      }
    }
    demand(current.run_id===(recovery.previous_run||null) && ['failed','execution_uncertain','queued','unavailable','dispatch_pending','dispatching'].includes(current.status),409,'Replacement state changed');
    db.run("UPDATE requests SET status='dispatching',error=NULL WHERE id=?",[requestId]);
    db.run('UPDATE request_recoveries SET claimed_at=? WHERE request_id=?',[now(),requestId]);
    return recovery;
  }).immediate();
  if(claimed)try{
    const accepted=await client.submit(JSON.parse(claimed.input_json),claimed.execution_key);
    db.transaction(()=>{
      demand(db.run("UPDATE requests SET run_id=?,status='building',error=NULL WHERE id=? AND COALESCE(run_id,'')=? AND status IN ('dispatching','dispatch_pending')",[accepted.runId,requestId,claimed.previous_run]).changes===1,409,'Replacement binding changed');
      bindActivityAuthority(db,requestId,accepted.runId,JSON.parse(claimed.input_json),config);
      const originalTurn=proof?.response?.result?.turn,acceptedInput=JSON.parse(claimed.input_json);
      if(originalTurn?.requestId===(acceptedInput.nativeRequestId??requestId))bindActivityRecovery(db,accepted.runId,requestId,acceptedInput,originalTurn);
      db.run('UPDATE request_recoveries SET new_run=?,receipt_json=? WHERE request_id=?',[accepted.runId,JSON.stringify(accepted.receipt),requestId]);
    }).immediate();
  }catch{db.run("UPDATE requests SET status='dispatch_pending',error='Replacement acceptance is uncertain. Reconnect this same saved request.' WHERE id=? AND COALESCE(run_id,'')=? AND status IN ('dispatching','dispatch_pending')",[requestId,claimed.previous_run]);}
  return db.query('SELECT * FROM requests WHERE id=?').get(requestId);
}
