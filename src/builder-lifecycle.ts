import {requestBuilderEngine} from './builder-engine.ts';
import { requestBuilderPrompt } from './builder-prompt.ts';
import { unresolvedNativeExecution } from "./native-uncertainty.ts";
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { demand } from './errors.ts';
import { now } from './auth.ts';
import { sha256 } from './assets.ts';
import {materializeRequestAttachments,requestAttachments} from './chat-attachments.ts';
export function builderEpoch(workshop: Workshop, project: any): any {
  workshop.db.run('INSERT OR IGNORE INTO builder_epochs(project_id,generation,conversation_key,state,reason,created_at) VALUES(?,0,?,\'active\',\'original\',?)',[project.id,project.conversation_id,now()]);
  return workshop.db.query('SELECT * FROM builder_epochs WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(project.id);
}
export function retireBuilder(workshop: Workshop, member: Member, projectId: string, generation: number) {
  return workshop.db.transaction(() => {
    const project=workshop.project(member,projectId,true), epoch=builderEpoch(workshop,project);
    demand(!unresolvedNativeExecution(workshop.db,projectId),409,'Native execution is uncertain; builder lifecycle is fenced');
    demand(epoch.state !== 'deleting',409,'Native deletion is pending or uncertain; builder lifecycle is fenced');
    demand(Number.isInteger(generation) && generation===epoch.generation,409,'Builder generation changed; reload');
    demand(!workshop.db.query("SELECT id FROM requests WHERE project_id=? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(projectId),409,'Active or uncertain request prevents builder deletion');
    workshop.db.run("UPDATE builder_epochs SET state='retired',reason='owner_retired',retired_at=? WHERE project_id=? AND generation=? AND state='active'",[now(),projectId,generation]);
    return {generation,state:'retired',nativeStorageDeleted:false,appHistoryPreserved:true,reason:'Builder association retired. Native runtime/history deletion is unavailable without scoped lifecycle authority.'};
  }).immediate();
}
export function nextEpoch(workshop:Workshop,project:any,reason:string,evidence:unknown):any {
  const old=builderEpoch(workshop,project);
  workshop.db.run("UPDATE builder_epochs SET state='retired',retired_at=? WHERE project_id=? AND generation=?",[now(),project.id,old.generation]);
  const generation=old.generation+1, key=project.conversation_id+':generation:'+generation;
  workshop.db.run("INSERT INTO builder_epochs(project_id,generation,conversation_key,state,reason,evidence_json,created_at) VALUES(?,?,?,'active',?,?,?)",[project.id,generation,key,reason,JSON.stringify(evidence),now()]);
  return builderEpoch(workshop,project);
}
export function replacementSnapshot(workshop:Workshop,project:any,request:any,directory:string,epoch:any) {
  demand(directory.startsWith('/'),409,'Exact builder working directory is required');
  const rows=workshop.db.query('SELECT id,prompt,response,status,error,mode,expected_revision,created_at FROM requests WHERE project_id=? ORDER BY created_at,rowid').all(project.id) as any[];
  const messages=rows.flatMap(r=>[{role:'user',content:r.prompt,attachments:requestAttachments(workshop,r.id),requestId:r.id,status:r.status,mode:r.mode,revision:r.expected_revision,...(r.error?{error:r.error}:{})},...(r.response?[{role:'assistant',content:r.response,requestId:r.id,status:r.status}]:[])]);
  const revision=workshop.revision(project.id,project.current_revision);
  const snapshot={...(requestBuilderEngine(workshop.db,request.id)?{builderEngine:requestBuilderEngine(workshop.db,request.id)}:{}),...(workshop.datasetSnapshot?{canvasDatasets:workshop.datasetSnapshot}:{}),schema:'byo-replacement-context-v1',ownerPubkey:project.owner,projectId:project.id,generation:epoch.generation,conversationKey:epoch.conversation_key,workingDirectory:directory,messages,currentRevision:revision.id,sourceHash:revision.source_hash,currentSource:workshop.assets.get(revision.source_hash),...(requestBuilderPrompt(workshop.db,request.id) ? {builderPrompt:requestBuilderPrompt(workshop.db,request.id)} : {}),latestPrompt:{requestId:request.id,content:request.prompt,attachments:materializeRequestAttachments(workshop,request.id,directory),mode:request.mode},historyPolicy:'Historical messages and statuses are evidence only. Execute ONLY latestPrompt, once.'};
  const json=JSON.stringify(snapshot);
  demand(Buffer.byteLength(json)<220000,409,'Saved context exceeds native limit; no truncated replacement will be sent');
  return {snapshot,contextHash:sha256(json)};
}
