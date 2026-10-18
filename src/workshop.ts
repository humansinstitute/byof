import {neverDispatched} from './queued-recovery.ts';
import {snapshotBuilderEngine,loadBuilderEngine,saveBuilderEngine,requestBuilderEngine,correctNeverDispatchedBuilderEngine} from './builder-engine.ts';
import { currentPreSend,currentAbandoned } from './pre-send-recovery.ts';
import {bindRequestAttachments,requestAttachments} from './chat-attachments.ts';
import { requestActivity } from './activity-store.ts';
import encodeQR from 'qr';
import { newJoinCode } from './invitation-codes.ts';
import { boardSnapshot } from './workshop-board.ts';
import { imageUrl } from './site.ts';
import { loadBuilderPrompt, saveBuilderPrompt, builderPromptMaxChars, agentNameMaxChars, validAgentName } from './builder-prompt.ts';
import { projectConversation } from "./project-routing.ts";
import { unresolvedNativeExecution } from "./native-uncertainty.ts";
import { builderEpoch } from "./builder-lifecycle.ts";
import type { Database } from "bun:sqlite";
import { Assets, sha256 } from "./assets.ts";
import { limits } from "./config.ts";
import { demand, text } from "./errors.ts";
import { now, type Member } from "./auth.ts";
import { starters } from "./starters.ts";
export class Workshop {
  static datasetProviders=new WeakMap<Database,(workshop:Workshop,member:Member)=>Promise<any>>();
  static siteAdminProviders=new WeakMap<Database,(pubkey:string)=>boolean>();
  get datasetDiscovery(){const provider=Workshop.datasetProviders.get(this.db);return provider? (member:Member)=>provider(this,member):undefined;}
  datasetSnapshot?: any;
  storageRequired=false;
  storageReady=true;
  constructor(public db: Database, public assets: Assets, public scopeId?: string) {}
  get id():string { return this.scopeId || (this.db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id; }
  get legacy():boolean { return this.id === (this.db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id; }
  roomRow():any { return this.legacy ? {...this.db.query('SELECT * FROM room WHERE id=1').get() as any,...this.db.query('SELECT owner,tower_id,pictures_json FROM workshops WHERE id=?').get(this.id) as any,id:this.id} : this.db.query('SELECT * FROM workshops WHERE id=?').get(this.id); }
  membership(pubkey:string):any { return this.legacy ? this.db.query('SELECT state,allowance FROM members WHERE pubkey=?').get(pubkey) : this.db.query('SELECT state,allowance FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(this.id,pubkey); }
  isSiteAdmin(pubkey:string):boolean { return Workshop.siteAdminProviders.get(this.db)?.(pubkey)??false; }
  projectOwnerAccess(pubkey:string):any {
    const membership=this.membership(pubkey);
    if(membership?.state==='admitted')return membership;
    if(this.roomRow().owner===pubkey||this.isSiteAdmin(pubkey)){
      const account=this.db.query('SELECT allowance FROM members WHERE pubkey=?').get(pubkey) as any;
      return {state:'admitted',allowance:account?.allowance??20,administrative:true};
    }
    return membership;
  }
  scoped(member:Member):Member { const room=this.roomRow(); demand(room,404,'Workshop not found'); const membership=this.membership(member.pubkey);return {...member,workshopId:this.id,workshopOwner:room.owner===member.pubkey,host:!!member.admin || room.owner===member.pubkey,state:membership?.state||'not-joined',allowance:membership?.allowance||0}; }
  join(member:Member,body:any) {
    return this.db.transaction(()=>{
      const previous=this.membership(member.pubkey);demand(previous?.state!=='banned',403,'Access removed for this workshop');
      if(previous?.state==='admitted')return this.scoped(member);
      const room=this.roomRow();let admitted=member.host||room.admission==='open';
      if(body.invitation){
        const invitation=this.db.query('SELECT status,remaining FROM invitations WHERE hash=? AND workshop_id=?').get(sha256(text(body.invitation,'Invitation',200)),this.id) as any;
        demand(invitation,403,'Invitation is invalid');
        demand(invitation.status!=='stopped',410,'Invitation has been stopped');
        demand(invitation.status==='active'&&invitation.remaining>0,410,'Invitation is exhausted');
        const used=this.db.run("UPDATE invitations SET remaining=remaining-1,status=CASE WHEN remaining=1 THEN 'exhausted' ELSE status END WHERE hash=? AND workshop_id=? AND status='active' AND remaining>0",[sha256(body.invitation.trim()),this.id]);
        demand(used.changes===1,410,'Invitation is no longer admitting people');admitted=true;
      }
      if(previous){if(admitted){if(this.legacy)this.db.run("UPDATE members SET state='admitted' WHERE pubkey=?",[member.pubkey]);else this.db.run("UPDATE workshop_members SET state='admitted' WHERE workshop_id=? AND pubkey=?",[this.id,member.pubkey]);}}
      else {demand(!this.legacy,409,'Legacy membership is created at sign-in');demand((this.db.query('SELECT count(*) n FROM workshop_members WHERE workshop_id=?').get(this.id) as any).n<limits.participants,409,'Workshop capacity reached');this.db.run('INSERT INTO workshop_members VALUES(?,?,?,?,?)',[this.id,member.pubkey,admitted?'admitted':'pending',20,now()]);}
      return this.scoped(member);
    }).immediate();
  }

  charge(pubkey:string) { if(this.legacy||!this.membership(pubkey)&&this.projectOwnerAccess(pubkey)?.administrative)this.db.run('UPDATE members SET allowance=allowance-1 WHERE pubkey=?',[pubkey]);else this.db.run('UPDATE workshop_members SET allowance=allowance-1 WHERE workshop_id=? AND pubkey=?',[this.id,pubkey]); }
  guidance() { if(this.legacy)return loadBuilderPrompt(this.db);const r=this.db.query('SELECT * FROM workshop_prompts WHERE workshop_id=?').get(this.id) as any;return {revision:r.revision,text:r.text,agentName:r.agent_name,updatedAt:r.updated_at}; }

  admitted(member: Member) { demand(member.host || member.state === "admitted", 403, member.state === "banned" ? "Your access is banned in this room" : "Waiting for host admission"); }
  host(member: Member) { demand(member.host, 403, "Host access required"); }
  project(member: Member, id: string, own = false): any {
    this.admitted(member); const project = this.db.query("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(id) as any;
    demand(project && project.workshop_id===this.id && (project.owner === member.pubkey || (!own && member.host)), 404, "Project not found"); return project;
  }
  editableProject(member:Member,id:string):any { return this.project(member,id,!member.host); }
  auditAdminAction(member:Member,project:any,action:string,detail:unknown) {
    if(project.owner===member.pubkey)return;
    this.host(member);
    this.db.run('INSERT INTO project_admin_audit VALUES(?,?,?,?,?,?,?,?)',[crypto.randomUUID(),this.id,project.id,project.owner,member.pubkey,action,JSON.stringify(detail),now()]);
  }
  deleteNapplet(member:Member,id:string,body:any) {
    demand(member.admin,403,'Site administrator access required');
    demand(body&&Object.keys(body).sort().join(',')==='confirmPermanent,confirmTitle,expectedRevisionId',400,'Unexpected deletion confirmation field');
    const project=this.db.query('SELECT * FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(id,this.id) as any;
    demand(project,404,'Napplet not found');
    demand(body.confirmPermanent===true&&body.confirmTitle===project.title,400,`Type ${project.title} and confirm permanent deletion`);
    demand(typeof body.expectedRevisionId==='string'&&body.expectedRevisionId===project.current_revision,409,'Napplet changed; reload before deleting');
    demand(!this.db.query("SELECT id FROM requests WHERE project_id=? AND status IN ('accepted','queued','dispatching','dispatch_pending','screening','building','storage_pending','execution_uncertain')").get(id),409,'An active or uncertain build prevents deletion; reconcile it first');
    demand(!unresolvedNativeExecution(this.db,id),409,'Native execution is uncertain; reconcile it before deleting this Napplet');
    const epoch=this.db.query('SELECT state FROM builder_epochs WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(id) as any;
    demand(epoch?.state!=='deleting',409,'Native builder deletion is active or uncertain; reconcile it before deleting this Napplet');
    const lifecycle=this.db.query("SELECT status FROM builder_deletions WHERE project_id=? AND status IN ('queued','dispatching','dispatch_pending','working','failed') ORDER BY generation DESC LIMIT 1").get(id) as any;
    demand(!lifecycle,409,'Native builder deletion is active or uncertain; reconcile it before deleting this Napplet');
    demand(!this.db.query("SELECT c.snapshot_id FROM publication_claims c JOIN publication_snapshots s ON s.id=c.snapshot_id JOIN json_each(s.body_json,'$.apps') a WHERE c.expires_at>? AND json_extract(a.value,'$.projectId')=? LIMIT 1").get(Date.now(),id),409,'A public publication is active; reconcile it before deleting this Napplet');
    return this.db.transaction(()=>{
      const current=this.db.query('SELECT * FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(id,this.id) as any;
      demand(current,404,'Napplet not found');
      demand(current.current_revision===body.expectedRevisionId,409,'Napplet changed; reload before deleting');
      const stamp=now();
      this.db.run("UPDATE builder_epochs SET state='retired',reason='napplet_deleted',retired_at=COALESCE(retired_at,?) WHERE project_id=? AND state='active'",[stamp,id]);
      this.db.run('UPDATE consent SET granted=0,updated_at=? WHERE project_id=?',[stamp,id]);
      this.db.run(`INSERT INTO hosted_publication_exclusions VALUES(?,?,1,?)
        ON CONFLICT(workshop_id,project_id) DO UPDATE SET excluded=1,updated_at=excluded.updated_at`,[this.id,id,stamp]);
      const localDataDeleted=this.db.run('DELETE FROM napplet_user_data WHERE workshop_id=? AND project_id=?',[this.id,id]).changes;
      const board=this.db.query('SELECT version,objects_json FROM workshop_boards WHERE workshop_id=?').get(this.id) as any;
      let boardObjectRemoved=false;
      if(board){
        let objects:any[]=[];try{const parsed=JSON.parse(board.objects_json);if(Array.isArray(parsed))objects=parsed;}catch{}
        const kept=objects.filter(object=>!(object?.kind==='napplet'&&(object.projectId===id||object.id===id)));
        boardObjectRemoved=kept.length!==objects.length;
        if(boardObjectRemoved)this.db.run('UPDATE workshop_boards SET version=version+1,objects_json=? WHERE workshop_id=? AND version=?',[JSON.stringify(kept),this.id,board.version]);
      }
      demand(this.db.run('UPDATE projects SET hidden=1,shared_revision=NULL,deleted_at=?,deleted_by=? WHERE id=? AND workshop_id=? AND deleted_at IS NULL',[stamp,member.pubkey,id,this.id]).changes===1,409,'Napplet changed; reload before deleting');
      this.db.run('INSERT INTO project_admin_audit VALUES(?,?,?,?,?,?,?,?)',[crypto.randomUUID(),this.id,id,current.owner,member.pubkey,'delete',JSON.stringify({localDataDeleted,boardObjectRemoved,externalArtifactsRetained:true,nativeLifecycleUnchanged:true}),stamp]);
      return {deletedNappletId:id,deletedAt:stamp,localDataDeleted,boardObjectRemoved,externalArtifactsRetained:true,nativeLifecycleUnchanged:true,message:'Napplet deleted from Freedom Tools. This action did not delete external publication artifacts or change the separately audited native lifecycle.'};
    }).immediate();
  }
  room(member: Member) {
    const room = {...this.roomRow(),pictures:JSON.parse(this.roomRow().pictures_json||'[]')};
    if (!member.host && member.state !== "admitted") return { room, projects: [], gallery: [], starters: starters.map(({ source, ...s }) => s) };
    const donationQr=room.lightning?encodeQR('lightning:'+room.lightning,'data-url',{scale:6,border:4,ecc:'medium'}):null;
    return { room, donationQr, board:boardSnapshot(this), projects: this.db.query("SELECT * FROM projects WHERE owner=? AND workshop_id=? AND deleted_at IS NULL ORDER BY created_at DESC").all(member.pubkey,this.id).map((p:any)=>({...p,appVersionUrl:this.versionLink(p.id,p.current_revision)})), gallery: this.db.query("SELECT p.id,p.title,p.description,p.shared_revision,p.origin_project,p.origin_revision,m.name author,p.owner authorPubkey,r.number,r.source_hash FROM projects p JOIN members m ON m.pubkey=p.owner JOIN revisions r ON r.id=p.shared_revision WHERE p.workshop_id=? AND p.hidden=0 AND p.deleted_at IS NULL ORDER BY p.created_at DESC").all(this.id).filter((p:any)=>this.projectOwnerAccess(p.authorPubkey)?.state==='admitted'), starters: starters.map(({ source, ...s }) => s) };
  }
  revision(projectId: string, revisionId: string): any { const revision = this.db.query("SELECT * FROM revisions WHERE id=? AND project_id=?").get(revisionId, projectId) as any; demand(revision, 404, "Revision not found"); return revision; }
  addRevision(project: any, sourceHash: string, actor: string, restoredFrom: string | null = null) {
    const count = (this.db.query("SELECT COUNT(*) n FROM revisions WHERE project_id=?").get(project.id) as any).n;
    demand(count < limits.revisionsPerProject, 409, "Revision capacity reached");
    const id = crypto.randomUUID(); this.db.run("INSERT INTO revisions(id,project_id,number,parent_id,restored_from,source_hash,author,created_at) VALUES(?,?,?,?,?,?,?,?)", [id, project.id, count + 1, project.current_revision || null, restoredFrom, sourceHash, actor, now()]);
    this.db.run("UPDATE projects SET current_revision=? WHERE id=?", [id, project.id]); return id;
  }
  create(member: Member, starterId: string, forkId?: string, additional = false) {
    this.admitted(member);
    demand(!forkId,400,'Use the idempotent fork operation');
    if(!this.legacy&&!this.membership(member.pubkey))this.join(member,{});
    return this.db.transaction(() => {
      const count = (this.db.query("SELECT COUNT(*) n FROM projects WHERE owner=? AND workshop_id=? AND deleted_at IS NULL").get(member.pubkey,this.id) as any).n;
      demand(count < limits.projectsPerMember, 409, "Project capacity reached");
      if (!additional) demand(!this.db.query("SELECT id FROM projects WHERE owner=? AND workshop_id=? AND origin_project IS NULL AND deleted_at IS NULL").get(member.pubkey,this.id), 409, "Open your existing project or fork a shared app");
      const starter = starters.find(s => s.id === starterId); demand(starter, 400, "Unknown starter");
      const hash=this.assets.put(starter.source),id = crypto.randomUUID(); this.db.run("INSERT INTO projects(id,owner,title,description,conversation_id,origin_project,origin_revision,created_at) VALUES(?,?,?,?,?,?,?,?)", [id, member.pubkey, starter.title, starter.description, additional ? projectConversation(member.pubkey, id) : crypto.randomUUID(), null, null, now()]);
      this.db.run('UPDATE projects SET workshop_id=? WHERE id=?',[this.id,id]);
      this.addRevision({ id }, hash, member.pubkey); return this.detail(member, id);
    })();
  }
  fork(member: Member, sourceId: string, idempotencyKey: string) {
    this.admitted(member);
    const key=text(idempotencyKey,'Fork request ID',100);
    demand(/^[a-zA-Z0-9_-]+$/.test(key),400,'Invalid fork request ID');
    return this.db.transaction(()=>{
      const previous=this.db.query('SELECT project_id,source_project FROM project_forks WHERE workshop_id=? AND actor=? AND idempotency_key=?').get(this.id,member.pubkey,key) as any;
      if(previous){demand(previous.source_project===sourceId,409,'Fork request ID was already used for another Napplet');return {...this.detail(member,previous.project_id),idempotent:true};}
      const source=this.db.query('SELECT * FROM projects WHERE id=? AND workshop_id=? AND hidden=0 AND deleted_at IS NULL AND current_revision IS NOT NULL').get(sourceId,this.id) as any;
      demand(source&&this.projectOwnerAccess(source.owner)?.state==='admitted',404,'Napplet is no longer available to fork');
      const revision=this.revision(source.id,source.current_revision);
      const count=(this.db.query('SELECT COUNT(*) n FROM projects WHERE owner=? AND workshop_id=? AND deleted_at IS NULL').get(member.pubkey,this.id) as any).n;
      demand(count<limits.projectsPerMember,409,'Project capacity reached');
      const forkTitle=(number:number)=>{const ending=number===1?' — fork':` — fork (${number})`;return source.title.slice(0,120-ending.length).trimEnd()+ending;};
      let number=1,title=forkTitle(number);
      while(this.db.query('SELECT id FROM projects WHERE workshop_id=? AND deleted_at IS NULL AND lower(title)=lower(?)').get(this.id,title))title=forkTitle(++number);
      const id=crypto.randomUUID(),conversationId=projectConversation(member.pubkey,id);
      this.db.run('INSERT INTO projects(id,owner,title,description,conversation_id,origin_project,origin_revision,created_at) VALUES(?,?,?,?,?,?,?,?)',[id,member.pubkey,title,source.description,conversationId,source.id,revision.id,now()]);
      this.db.run('UPDATE projects SET workshop_id=? WHERE id=?',[this.id,id]);
      this.addRevision({id},revision.source_hash,member.pubkey);
      this.db.run('INSERT INTO project_forks VALUES(?,?,?,?,?,?,?)',[this.id,member.pubkey,key,source.id,revision.id,id,now()]);
      return {...this.detail(member,id),idempotent:false};
    }).immediate();
  }
  detail(member: Member, id: string) {
    const project = this.project(member, id);
    project.appVersionUrl=this.versionLink(project.id,project.current_revision);
    const artifacts=(this.db.query("SELECT version,source_hash,revision_id FROM local_builds WHERE project_id=? AND status='completed' ORDER BY version").all(id) as any[]).map(r=>({version:r.version,sha256:r.source_hash,revisionId:r.revision_id,path:`v${r.version}/index.html`,url:`/api/v1/projects/${id}/preview?revision=${r.revision_id}`,...(() => {const remote=this.db.query('SELECT artifact_json FROM remote_versions WHERE revision_id=?').get(r.revision_id) as any;return remote?{hosting:'tower-private-s3',remoteStorage:JSON.parse(remote.artifact_json)}:{hosting:'authenticated-workshop'};})()}));
    const rows=this.db.query("SELECT * FROM revisions WHERE project_id=? ORDER BY number DESC").all(id) as any[],byId=new Map(rows.map(revision=>[revision.id,revision])),activeLineage=new Set<string>();
    for(let revision=byId.get(project.current_revision);revision&&!activeLineage.has(revision.id);revision=revision.parent_id?byId.get(revision.parent_id):undefined)activeLineage.add(revision.id);
    const revisions=rows.map(revision=>({...revision,lineage_status:revision.id===project.current_revision?'active':activeLineage.has(revision.id)?'ancestor':'abandoned',appVersionUrl:this.versionLink(project.id,revision.id)}));
    return { agentName: this.guidance().agentName, selectedBuilderEngine:loadBuilderEngine(this.db,this.id), permissions:{owner:project.owner===member.pubkey,edit:project.owner===member.pubkey||member.host,consent:project.owner===member.pubkey,administrative:project.owner!==member.pubkey&&member.host}, project, artifacts, builder: builderEpoch(this,project), builderDeletion: this.db.query('SELECT id,generation,status,error,receipt_json FROM builder_deletions WHERE project_id=? ORDER BY generation DESC LIMIT 1').get(id), revisions, builderPromptRevision: this.guidance().revision, requests: this.db.query("SELECT (SELECT revision FROM request_builder_prompts WHERE request_id=r.id) builder_prompt_revision,r.id,r.prompt,r.status,r.error,r.response,r.mode,r.run_id,r.created_at,(SELECT MAX(d.created_at) FROM delivery_receipts d WHERE d.request_id=r.id) response_received_at,EXISTS(SELECT 1 FROM delivery_receipts d WHERE d.request_id=r.id AND json_extract(d.result_json,'$.error')='Completed-turn bound session unavailable') recoverable FROM requests r WHERE r.project_id=? ORDER BY r.created_at,r.rowid").all(id).map((r:any)=>({...r,attachments:requestAttachments(this,r.id),builderEngine:requestBuilderEngine(this.db,r.id),builderEngineCorrected:!!this.db.query('SELECT request_id FROM request_builder_engine_corrections WHERE request_id=?').get(r.id),...(() => {const publication=this.db.query('SELECT status,error,receipt_json FROM agent_publications WHERE request_id=?').get(r.id) as any;const recovery=this.db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(r.id) as any;return {agentPublication:!!recovery&&JSON.parse(recovery.input_json).replacementContext?.fileBuild?.publication==='agent-tool-v1',publicationStatus:publication?.status??'none',publicationError:publication?.error??null,publishedVersion:publication?.receipt_json?JSON.parse(publication.receipt_json).version:null};})(),neverSent:neverDispatched(this.db,{...r,project_id:id}),automaticRetryExhausted:((this.db.query('SELECT attempts FROM automatic_recovery WHERE request_id=?').get(r.id) as any)?.attempts??0)>=4,recoverable:currentPreSend(this.db,{...r,project_id:id}) || currentAbandoned(this.db,r),activity:requestActivity(this.db,r.id)})), consent: this.db.query("SELECT revision_id,granted FROM consent WHERE project_id=?").all(id) };
  }
  versionLink(projectId:string,revisionId:string) {
    const row=this.db.query('SELECT receipt_json FROM agent_publications WHERE revision_id=? AND status=? AND request_id IN (SELECT id FROM requests WHERE project_id=?)').get(revisionId,'published',projectId) as any;
    return row?JSON.parse(row.receipt_json).url:null;
  }
  rename(member: Member, id: string, body: any) {
    return this.db.transaction(()=>{
      const project = this.editableProject(member,id);
      const title = text(body.title, "Napplet title", 120);
      demand(!/[\u0000-\u001f\u007f]/u.test(title), 400, "Napplet title must be a single line");
      demand(!this.db.query('SELECT id FROM projects WHERE workshop_id=? AND deleted_at IS NULL AND id<>? AND lower(title)=lower(?)').get(this.id,project.id,title),409,'Another Napplet already uses that name');
      this.db.run("UPDATE projects SET title=? WHERE id=? AND workshop_id=? AND owner=?", [title, project.id, this.id, project.owner]);
      this.auditAdminAction(member,project,'rename',{title});
      return { project: this.editableProject(member,id) };
    })();
  }
  restore(member: Member, id: string, body: any) {
    return this.db.transaction(() => {
      const project = this.editableProject(member,id); demand(project.current_revision === body.expectedRevisionId, 409, "Project changed; reload before restoring");
      const revision = this.revision(id, body.revisionId); const restored=this.addRevision(project, revision.source_hash, member.pubkey, revision.id);this.auditAdminAction(member,project,'restore',{revisionId:revision.id,restoredRevisionId:restored});return this.detail(member, id);
    })();
  }
  activate(member: Member, id: string, body: any) {
    return this.db.transaction(() => {
      const project=this.editableProject(member,id),expected=text(body.expectedRevisionId,'Expected revision',100),revisionId=text(body.revisionId,'Revision',100);
      demand(project.current_revision===expected,409,'Project changed; reload before activating this version');
      this.revision(id,revisionId);
      demand(this.db.run('UPDATE projects SET current_revision=? WHERE id=? AND current_revision=?',[revisionId,id,expected]).changes===1,409,'Project changed; reload before activating this version');
      this.auditAdminAction(member,project,'activate',{revisionId,previousRevisionId:expected});return this.detail(member,id);
    }).immediate();
  }
  share(member: Member, id: string, body: any) {
    return this.db.transaction(() => {
      const project = this.editableProject(member,id);
      if (body.revisionId === null) { this.db.run("UPDATE projects SET shared_revision=NULL WHERE id=?", [id]); this.db.run("UPDATE consent SET granted=0,updated_at=? WHERE project_id=?", [now(), id]); }
      else { this.revision(id, text(body.revisionId, "Revision", 100)); demand(!project.hidden, 403, "Host has hidden this project"); this.db.run("UPDATE projects SET shared_revision=? WHERE id=?", [body.revisionId, id]); }
      this.auditAdminAction(member,project,'share',{revisionId:body.revisionId});return this.detail(member, id);
    })();
  }
  consent(member: Member, id: string, body: any) {
    const project = this.project(member, id, true); this.revision(id, body.revisionId); demand(typeof body.granted === "boolean", 400, "Consent must be explicit");
    demand(!body.granted || project.shared_revision === body.revisionId, 409, "Share this exact revision before granting public consent");
    this.db.run("INSERT INTO consent VALUES(?,?,?,?,?) ON CONFLICT(project_id,revision_id) DO UPDATE SET granted=excluded.granted,updated_at=excluded.updated_at", [id, body.revisionId, member.pubkey, Number(body.granted), now()]); return this.detail(member, id);
  }
  submitUnavailable(member: Member, id: string, body: any) { return this.request(member, id, body, false); }
  request(member: Member, id: string, body: any, available: boolean, hostOperation = false) {
    if (hostOperation) this.host(member);
    return this.db.transaction(() => {
      demand(!['agent','engine','model','provider','builderRuntime','builderEngine','builderEngineRevision','runtime'].some(k=>Object.hasOwn(body,k)),400,'Builder engine is chosen by the administrator');
      const project = this.project(member, id, !hostOperation), requestId = text(body.requestId, "Request ID", 100);
      const owner = this.projectOwnerAccess(project.owner);
      demand(owner?.state === "admitted", 403, "Project owner must be admitted");
      const hostReason = hostOperation ? text(body.operatorReason, "Host execution reason", 1000) : null;
      text(body.prompt, "Instruction", limits.promptChars);
      // Validate emptiness and size without rewriting the participant's exact instruction.
      const prompt: string = body.prompt;
      const mode = body.mode ?? 'auto'; demand(['auto','answer','build'].includes(mode), 400, 'Unknown conversation mode');
      demand(!unresolvedNativeExecution(this.db,id),409,'Native execution is uncertain; this project is fenced');
      const previous = this.db.query("SELECT * FROM requests WHERE id=?").get(requestId) as any;
      if (previous) {
        if (hostOperation) { const audit = this.db.query("SELECT actor,reason FROM host_request_audit WHERE request_id=?").get(requestId) as any; demand(audit?.actor === member.pubkey && audit.reason === hostReason, 409, "Existing request was not submitted by this host"); }
        demand(previous.project_id === id && previous.prompt === prompt && previous.expected_revision === body.expectedRevisionId && previous.mode === mode, 409, "Request ID already used for different content");bindRequestAttachments(this,member,id,requestId,prompt,body.attachments);return previous; }
      demand(project.current_revision === body.expectedRevisionId, 409, "Project changed; reload before submitting");
      demand(!this.roomRow().paused, 403, "The host has paused building"); demand(mode === "answer" || owner.allowance > 0, 403, "Your build allowance is exhausted");
      demand((this.db.query("SELECT COUNT(*) n FROM requests WHERE project_id=?").get(id) as any).n < limits.requestsPerProject, 409, "Conversation capacity reached");
      demand(!this.db.query("SELECT id FROM requests WHERE project_id=? AND status IN ('queued','dispatching','dispatch_pending','building','storage_pending','execution_uncertain')").get(id), 409, "A request is already running for this project");
      demand(builderEpoch(this,project).state !== 'deleting',409,'Native deletion is pending or uncertain; builder requests are fenced');
      const error = "Execution is awaiting activation for this project. Your instruction is saved; no agent ran and no allowance was charged.";
      this.db.run("INSERT INTO requests(id,project_id,prompt,expected_revision,status,error,created_at,mode) VALUES(?,?,?,?,?,?,?,?)", [requestId, id, prompt, project.current_revision, available ? "queued" : "unavailable", available ? null : error, now(), mode]);
      bindRequestAttachments(this,member,id,requestId,prompt,body.attachments);
      snapshotBuilderEngine(this.db,this.id,requestId);
      const guidance = this.guidance();
      this.db.run('INSERT INTO request_builder_prompts(request_id,revision,text,agent_name) VALUES(?,?,?,?)',[requestId,guidance.revision,guidance.text,guidance.agentName!]);
      if (hostOperation) this.db.run('INSERT INTO host_request_audit VALUES(?,?,?,?,?)',[requestId,member.pubkey,project.owner,hostReason,now()]);
      return this.db.query("SELECT * FROM requests WHERE id=?").get(requestId);
    })();
  }
  builderEngine(member:Member,body?:any){demand(member.admin,403,'Site administrator access required');return body===undefined?loadBuilderEngine(this.db,this.id):saveBuilderEngine(this.db,this.id,body)}
  correctRequestBuilderEngine(member:Member,projectId:string,requestId:string,body:any){demand(member.admin,403,'Site administrator access required');return correctNeverDispatchedBuilderEngine(this.db,this.id,projectId,requestId,member.pubkey,body)}
  builderPrompt(member: Member, body?: any) {
    this.host(member);
    let prompt=this.guidance();
    if(body!==undefined){if(this.legacy)prompt=saveBuilderPrompt(this.db,body);else {demand(typeof body.text==='string'&&!!body.text.trim()&&body.text.length<=builderPromptMaxChars,400,'Invalid builder guidance');const name=body.agentName??prompt.agentName;demand(validAgentName(name),400,'Invalid agent name');demand(this.db.run('UPDATE workshop_prompts SET text=?,agent_name=?,revision=revision+1,updated_at=? WHERE workshop_id=? AND revision=?',[body.text,name,now(),this.id,body.expectedRevision]).changes===1,409,'Builder prompt changed; reload before saving');prompt=this.guidance();}}
    return {prompt,maxChars:builderPromptMaxChars,agentNameMaxChars};
  }

  settings(member: Member, body: any) {
    this.host(member); const title = text(body.title, "Heading", 120), intro = text(body.introduction, "Introduction", 3000);
    const supportLabel = body.support_label === undefined ? this.roomRow().support_label : text(typeof body.support_label === 'string' && !body.support_label.trim() ? 'Support this workshop' : body.support_label, 'Support button label', 120);
    demand(!/[\u0000-\u001f\u007f]/u.test(supportLabel), 400, 'Support button label must be a single line');
    const lightning = typeof body.lightning === "string" ? body.lightning.trim() : "";
    demand(!lightning || /^[a-zA-Z0-9_.+-]{1,64}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(lightning), 400, "Enter a valid Lightning address");
    demand(["open", "invitation", "approval"].includes(body.admission), 400, "Unknown admission policy"); demand(typeof body.paused === "boolean", 400, "Pause must be explicit");
    const pictures=body.pictures??JSON.parse(this.roomRow().pictures_json||'[]'); demand(Array.isArray(pictures)&&pictures.length<=6,400,'Use at most six pictures');const safe=pictures.map(imageUrl).filter(Boolean);
    if(this.legacy)this.db.run("UPDATE room SET title=?,introduction=?,lightning=?,support_label=?,paused=?,admission=? WHERE id=1", [title, intro, lightning, supportLabel, Number(body.paused), body.admission]);
    this.db.run('UPDATE workshops SET title=?,introduction=?,lightning=?,support_label=?,paused=?,admission=?,pictures_json=? WHERE id=?',[title,intro,lightning,supportLabel,Number(body.paused),body.admission,JSON.stringify(safe),this.id]); return this.room(member);
  }
  people(member:Member) {this.host(member);return {members:this.legacy?this.db.query('SELECT * FROM members ORDER BY created_at').all():this.db.query('SELECT m.*,wm.state,wm.allowance FROM members m JOIN workshop_members wm ON wm.pubkey=m.pubkey WHERE wm.workshop_id=? ORDER BY m.created_at').all(this.id),projects:this.db.query('SELECT p.*,m.name author,p.owner authorPubkey FROM projects p JOIN members m ON m.pubkey=p.owner WHERE p.workshop_id=? AND p.deleted_at IS NULL').all(this.id)};}
  moderate(member: Member, pubkey: string, body: any) {
    this.host(member); const self=pubkey===member.pubkey;demand(!self||member.admin&&body.state===member.state&&body.state==='admitted',400,"Administrators may only adjust their own admitted build allowance");
    demand(["admitted", "pending", "banned"].includes(body.state), 400, "Unknown membership state"); demand(Number.isInteger(body.allowance) && body.allowance >= 0 && body.allowance <= 100, 400, "Allowance must be 0–100");
    return this.db.transaction(() => {
      demand((this.legacy?this.db.run("UPDATE members SET state=?,allowance=? WHERE pubkey=?", [body.state, body.allowance, pubkey]):this.db.run('UPDATE workshop_members SET state=?,allowance=? WHERE workshop_id=? AND pubkey=?',[body.state,body.allowance,this.id,pubkey])).changes === 1, 404, "Member not found");
      if (body.state === "banned") { this.db.run("UPDATE projects SET hidden=1 WHERE owner=? AND workshop_id=?", [pubkey,this.id]); this.db.run("UPDATE consent SET granted=0,updated_at=? WHERE author=? AND project_id IN (SELECT id FROM projects WHERE workshop_id=?)", [now(), pubkey,this.id]); }
      this.db.run("INSERT INTO moderation(id,actor,member,action,created_at,workshop_id) VALUES(?,?,?,?,?,?)", [crypto.randomUUID(), member.pubkey, pubkey, body.state, now(),this.id]); return this.people(member);
    })();
  }
  visibility(member: Member, id: string, body: any) { this.host(member); demand(typeof body.hidden === "boolean", 400, "Visibility must be explicit"); demand(this.db.run("UPDATE projects SET hidden=? WHERE id=? AND workshop_id=? AND deleted_at IS NULL", [Number(body.hidden), id,this.id]).changes === 1, 404, "Project not found"); return this.people(member); }
  invitation(member: Member, body: any) {
    this.host(member);demand(Number.isInteger(body.uses)&&body.uses>0&&body.uses<=50,400,'Invitation uses must be 1–50');
    demand(body.shortCode===undefined||typeof body.shortCode==='boolean',400,'Invalid invitation type');
    return this.db.transaction(()=>{
      if(body.shortCode)demand(!this.db.query("SELECT hash FROM invitations WHERE workshop_id=? AND status='active' AND code IS NOT NULL AND remaining>0").get(this.id),409,'A shared invitation is already active');
      const token=body.shortCode?newJoinCode(this.db):`${crypto.randomUUID()}${crypto.randomUUID()}`;
      // Six-digit values are retained only for authorized host redisplay. Their
      // hashes have the same enumerable one-million-value offline search space;
      // long tokens remain hash-only and are never written to the code column.
      this.db.run('INSERT INTO invitations(hash,remaining,expires_at,workshop_id,initial_uses,status,code,created_at) VALUES(?,?,0,?,?,?,?,?)',[sha256(token),body.uses,this.id,body.uses,'active',body.shortCode?token:null,now()]);
      return {token,...(body.shortCode?{code:token,status:'active',limit:body.uses,remaining:body.uses,used:0}:{}),uses:body.uses};
    }).immediate();
  }
  sharedInvitation(member:Member) {
    this.host(member);
    return this.db.transaction(()=>{
      this.db.run("UPDATE invitations SET status='exhausted' WHERE workshop_id=? AND code IS NOT NULL AND status='active' AND remaining<=0",[this.id]);
      const active=this.db.query("SELECT code,status,initial_uses,remaining,created_at,stopped_at FROM invitations WHERE workshop_id=? AND code IS NOT NULL AND status='active' AND remaining>0 ORDER BY created_at DESC,rowid DESC LIMIT 1").get(this.id) as any;
      const latest=active||this.db.query("SELECT code,status,initial_uses,remaining,created_at,stopped_at FROM invitations WHERE workshop_id=? AND code IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(this.id) as any;
      const summary=(row:any,includeCode=false)=>row?{...(includeCode?{code:row.code}:{}),status:row.status,limit:row.initial_uses,remaining:row.remaining,used:row.initial_uses-row.remaining,createdAt:row.created_at,stoppedAt:row.stopped_at}:null;
      return {active:summary(active,true),latest:summary(latest,!!active)};
    }).immediate();
  }
  stopInvitation(member:Member) {
    this.host(member);
    return this.db.transaction(()=>{
      const stopped=this.db.run("UPDATE invitations SET status='stopped',stopped_at=? WHERE workshop_id=? AND code IS NOT NULL AND status='active' AND remaining>0",[now(),this.id]);
      demand(stopped.changes===1,409,'No active shared invitation to stop');
      const latest=this.db.query("SELECT status,initial_uses,remaining,created_at,stopped_at FROM invitations WHERE workshop_id=? AND code IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(this.id) as any;
      return {active:null,latest:{status:latest.status,limit:latest.initial_uses,remaining:latest.remaining,used:latest.initial_uses-latest.remaining,createdAt:latest.created_at,stoppedAt:latest.stopped_at}};
    }).immediate();
  }
  previewRevision(member: Member, id: string, revisionId: string) {
    this.admitted(member); const project = this.db.query("SELECT * FROM projects WHERE id=? AND deleted_at IS NULL").get(id) as any;
    demand(project && project.workshop_id===this.id && (project.owner === member.pubkey || member.host || ((project.current_revision === revisionId || project.shared_revision === revisionId) && !project.hidden && this.projectOwnerAccess(project.owner)?.state === "admitted")), 404, "Preview not found");
    return this.revision(id,revisionId);
  }
  preview(member:Member,id:string,revisionId:string){return this.assets.get(this.previewRevision(member,id,revisionId).source_hash);}
  publicationCandidates(member: Member) { this.host(member); return this.db.query("SELECT p.id,p.title,p.shared_revision,r.number,r.source_hash,m.name author,p.owner authorPubkey,p.origin_project,p.origin_revision FROM projects p JOIN revisions r ON r.id=p.shared_revision JOIN members m ON m.pubkey=p.owner JOIN consent c ON c.project_id=p.id AND c.revision_id=r.id WHERE p.hidden=0 AND p.deleted_at IS NULL AND p.workshop_id=? AND c.granted=1").all(this.id).filter((p:any)=>this.projectOwnerAccess(p.authorPubkey)?.state==='admitted'); }
}
