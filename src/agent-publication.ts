import type {Workshop} from './workshop.ts';
import {demand} from './errors.ts';
import {readLocalCandidate,promoteLocalCandidate,stageRemoteLocalCandidate} from './local-builds.ts';
import {requireRemoteVersion,candidateStorageJob,type StorageConfig} from './storage.ts';
import {verifyActivityFinal} from './activity-store.ts';

export function installAgentPublication(db:Workshop['db']) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_publications(request_id TEXT PRIMARY KEY REFERENCES requests(id),run_id TEXT NOT NULL,
    candidate_json TEXT NOT NULL,status TEXT NOT NULL,error TEXT,revision_id TEXT,receipt_json TEXT,attempts INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS final_message_receipts(request_id TEXT PRIMARY KEY REFERENCES requests(id),run_id TEXT NOT NULL,native_receipt_json TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL);`);
}
export function publicationAuthority(workshop:Workshop,body:any) {
  const db=workshop.db,r=db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(body.requestId,body.projectId) as any;
  const p=r&&db.query('SELECT * FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(r.project_id,workshop.id) as any;
  const n=body.candidate?.nativeReceipt;
  const inputRow=r&&db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(r.id) as any;
  const input=inputRow&&JSON.parse(inputRow.input_json);
  const epoch=p&&db.query('SELECT * FROM builder_epochs WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(p.id) as any;
  const final=r&&db.query('SELECT native_receipt_json FROM final_message_receipts WHERE request_id=? AND run_id=?').get(r.id,r.run_id) as any;
  const finished=final&&JSON.parse(final.native_receipt_json);
  demand(r&&p&&input?.replacementContext?.fileBuild?.publication==='agent-tool-v1'&&n&&n.requestId===r.id&&n.projectId===p.id&&n.invocationRunId===r.run_id&&
    n.runId===r.run_id&&n.nativeRequestId===input.nativeRequestId&&n.generation===input.generation&&n.contextHash===input.contextHash&&n.conversationKey===input.conversationKey&&
    epoch?.state==='active'&&epoch.generation===input.generation&&n.receiptId&&n.sessionId&&n.nativeSessionId&&Number.isInteger(n.sequence)&&
    (epoch.native_id?n.nativeSessionId===epoch.native_id&&(n.sequence===epoch.sequence+1||(finished&&n.sequence===finished.sequence&&n.receiptId===finished.receiptId&&n.sessionId===finished.sessionId&&n.nativeSessionId===finished.nativeSessionId)):n.sequence===1),403,'Publication native authority denied');
  verifyActivityFinal(db,r.run_id,r.id,n);
  const owner=workshop.projectOwnerAccess(p.owner);
  demand(owner.state==='admitted'&&!workshop.roomRow().paused&&r.mode!=='answer',403,'Publication admission denied');
  return {request:r,project:p,nativeReceipt:n};
}
/** App-owned publication intent and retry state, independent of final prose. */
export function beginAgentPublication(workshop:Workshop,body:any,storage?:StorageConfig) {
  const {request:r,project:p}=publicationAuthority(workshop,body),db=workshop.db;
  const previous=db.query('SELECT * FROM agent_publications WHERE request_id=?').get(r.id) as any;
  if(previous){
    demand(previous.run_id===r.run_id&&previous.candidate_json===JSON.stringify(body.candidate),409,'Publication candidate changed');
    if(previous.status==='published')return {status:'published',receipt:JSON.parse(previous.receipt_json)};
    db.run('UPDATE agent_publications SET attempts=attempts+1 WHERE request_id=?',[r.id]);
    return {status:'pending',...(storage?candidateStorageJob(workshop,storage,body):{})};
  }
  demand(r.status==='building'&&p.current_revision===r.expected_revision&&workshop.projectOwnerAccess(p.owner).allowance>0,409,'Publication revision or allowance changed');
  readLocalCandidate(workshop,r,body.candidate);
  db.run('INSERT INTO agent_publications(request_id,run_id,candidate_json,status) VALUES(?,?,?,?)',[r.id,r.run_id,JSON.stringify(body.candidate),'pending']);
  return {status:'pending',...(storage?candidateStorageJob(workshop,storage,body):{})};
}
/** Receive exact bounded bytes from the installation-bound remote builder. */
export function beginRemoteAgentPublication(workshop:Workshop,body:any,storage?:StorageConfig) {
  demand(Object.keys(body).sort().join(',')==='candidate,projectId,requestId,sourceBase64,sourceSha256',400,'Remote publication payload denied');
  const publicationBody={requestId:body.requestId,projectId:body.projectId,candidate:body.candidate};
  const {request}=publicationAuthority(workshop,publicationBody);
  stageRemoteLocalCandidate(workshop,request,body.candidate,body.sourceBase64,body.sourceSha256);
  return beginAgentPublication(workshop,publicationBody,storage);
}
/** Signed app-version webhook. Storage bytes and hash were verified in custody. */
export function registerAgentPublication(workshop:Workshop,body:any) {
  return workshop.db.transaction(()=>{
    const {request:r,project:p}=publicationAuthority(workshop,body),db=workshop.db;
    const publication=db.query('SELECT * FROM agent_publications WHERE request_id=?').get(r.id) as any;
    const candidate=body.candidate;
    demand(publication&&publication.run_id===r.run_id,409,'Publication intent missing');
    const original=JSON.parse(publication.candidate_json);
    demand(JSON.stringify({...candidate,jobId:undefined,remoteStorage:undefined})===JSON.stringify(original),409,'Publication payload changed');
    if(publication.status==='published'){
      const receipt=JSON.parse(publication.receipt_json);
      demand(receipt.sha256===candidate.remoteStorage?.sha256&&receipt.jobId===candidate.jobId&&JSON.stringify(receipt.remoteStorage)===JSON.stringify(candidate.remoteStorage),409,'Publication receipt conflict');
      return receipt;
    }
    demand(['building','storage_pending'].includes(r.status)&&p.current_revision===r.expected_revision&&workshop.projectOwnerAccess(p.owner).allowance>0,409,'Publication revision or allowance changed');
    const local=readLocalCandidate(workshop,r,candidate);
    const remote=requireRemoteVersion(workshop,r,candidate,local.hash);
    promoteLocalCandidate(local);
    const hostSubmission=db.query('SELECT actor FROM host_request_audit WHERE request_id=?').get(r.id) as any;
    const revision=workshop.addRevision(p,workshop.assets.put(local.source),hostSubmission?.actor??p.owner);
    const receipt={status:'published',requestId:r.id,projectId:p.id,runId:r.run_id,version:local.row.version,revisionId:revision,
      sha256:local.hash,jobId:remote.jobId,remoteStorage:remote.artifact,url:`/api/v1/projects/${p.id}/preview?workshop=${workshop.id}&revision=${revision}`};
    db.run('INSERT INTO remote_versions VALUES(?,?,?)',[revision,remote.jobId,JSON.stringify(remote.artifact)]);
    db.run('INSERT INTO build_receipts VALUES(?,?,?)',[r.id,revision,JSON.stringify({...candidate.nativeReceipt,artifact:receipt})]);
    db.run("UPDATE local_builds SET status='completed',source_hash=?,revision_id=? WHERE request_id=?",[local.hash,revision,r.id]);
    db.run("UPDATE agent_publications SET status='published',revision_id=?,receipt_json=?,error=NULL WHERE request_id=?",[revision,JSON.stringify(receipt),r.id]);
    workshop.charge(p.owner);
    if(r.status==='storage_pending')db.run("UPDATE requests SET status='succeeded',error=NULL WHERE id=?",[r.id]);
    return receipt;
  }).immediate();
}
