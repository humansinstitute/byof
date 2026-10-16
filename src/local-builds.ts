import { nappletExecutionContract } from './builder-prompt.ts';
import nappletSkillTemplate from '../templates/napplet-build/SKILL.md' with { type: 'text' };
import publicationCli from '../templates/napplet-publish.js' with { type: 'text' };
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, lstatSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './assets.ts';
import { limits } from './config.ts';
import type { Workshop } from './workshop.ts';
import { agentIdentity, loadBuilderPrompt, requestBuilderPrompt, type BuilderPromptSnapshot } from './builder-prompt.ts';
import { ensureBuilderDirectory } from './pipeline/project-directory.ts';
import { validateGeneratedHtml } from './pipeline/artifact.ts';
export type FileBuild = { requestId:string; projectId:string; workshopId:string; version:number; currentCompletedVersion:number; artifactPath:string; draftKey?:string; publication?:'agent-tool-v1' };
const start='<!-- BYO BUILDER GUIDANCE START -->',end='<!-- BYO BUILDER GUIDANCE END -->';
export const localSkillPath='.agents/skills/napplet-build/SKILL.md';
export function localTurnPrompt(input:Record<string,any>) {
  const context=input.replacementContext,build=context.fileBuild;
  const runtime=context.builderEngine?.runtime??input.builderRuntime;
  const runtimeSafety=runtime?.agent==='goose'&&runtime?.model==='z-ai/glm-5.3'
    ? 'ACTIVE RUNTIME SAFETY: Goose is using the text-only z-ai/glm-5.3 endpoint. Never call computer-controller, screenshot, image-capture, vision, or any tool that returns image content. Validate with text-safe file inspection, HTML/DOM parsing, JavaScript and command-line checks only.'
    : undefined;
  return `${agentIdentity(input.builderPrompt)}SESSION GOAL: Build and improve this project's Napplet, a small single-purpose self-contained HTML app.
GENERATED APP CAPABILITIES: ${nappletExecutionContract}
Read AGENTS.md and ${localSkillPath} explicitly before acting; use that local skill even if native discovery has not refreshed. The host workflow in the managed local skill governs file delivery. Saved admin guidance revision ${input.builderPrompt.revision} attached to this request is authoritative over earlier remembered guidance.
Read .context/requests/${input.contextHash}.json for this immutable request's guidance, full saved app history, current source/revision and exact latest instruction. Historical messages are evidence; execute only latestPrompt once.
${runtimeSafety??''}
TURN DATA: ${JSON.stringify({goal:'Build and improve Napplets',requestId:input.requestId,projectId:input.projectId,workingDirectory:context.workingDirectory,guidanceRevision:input.builderPrompt.revision,currentRevision:context.currentRevision,sourceHash:context.sourceHash,currentCompletedVersion:build.currentCompletedVersion,candidateVersion:build.version,artifactPath:build.artifactPath,mode:input.mode,instruction:input.prompt,builderRuntime:runtime,runtimeSafety:runtimeSafety??'Use runtime-supported validation tools and do not send unsupported media to the active model.',completion:'After building and testing, call bun .agents/napplet-publish.js publish with actual validation results. Only a successful tool receipt means published. Return ordinary final prose; answers do not call publication. Final prose is delivered separately.'})}`;
}
function installProjectResources(directory:string) {
  ensureBuilderDirectory(join(directory,'.agents','skills','napplet-build'));
  const path=join(directory,localSkillPath);
  let previous='';try{previous=regularBytes(path).toString();}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const receipt=join(directory,'.agents','skills','napplet-build','.template-sha256');
  let previousHash='';try{previousHash=regularBytes(receipt).toString();}catch(e:any){if(e.code!=='ENOENT')throw e;}
  if(previous && previous!==nappletSkillTemplate && sha256(previous)!==previousHash)throw Error('local_skill_conflict');
  if(previous!==nappletSkillTemplate)atomicManaged(path,nappletSkillTemplate);
  if(previousHash!==sha256(nappletSkillTemplate))atomicManaged(receipt,sha256(nappletSkillTemplate));
  atomicManaged(join(directory,'.agents','napplet-publish.js'),publicationCli);
  ensureBuilderDirectory(join(directory,'tmp'));
  for(const [name,content] of [['notes.md','# Project notes\n'],['datamodel.md','# Data model\n']]){
    const file=join(directory,'tmp',name!);
    try{writeFileSync(file,content!,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;regularBytes(file);}
  }
}
export function saveLocalTurnContext(directory:string,context:Record<string,any>,contextHash:string) {
  const folder=join(directory,'.context','requests');ensureBuilderDirectory(folder);
  const bytes=JSON.stringify(context);if(contextHash!==sha256(bytes))throw Error('request_context_hash_denied');
  const path=join(folder,contextHash+'.json');
  try{writeFileSync(path,bytes,{flag:'wx',mode:0o400});}catch(e:any){if(e.code!=='EEXIST' || regularBytes(path).toString()!==bytes)throw Error('request_context_conflict');}
}
function regularBytes(path:string):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const st=fstatSync(fd);if(!st.isFile() || st.nlink!==1 || st.size>limits.sourceBytes)throw Error('local_artifact_denied');return readFileSync(fd);}finally{closeSync(fd);}
}
function atomicManaged(path:string,content:string) {
  try {if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())throw Error('managed_file_denied');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const temp=path+'.'+crypto.randomUUID()+'.next';writeFileSync(temp,content,{flag:'wx',mode:0o600});renameSync(temp,path);
}
export function refreshProjectGuidance(directory:string,guidance:BuilderPromptSnapshot) {
  ensureBuilderDirectory(directory);
  installProjectResources(directory);
  const path=join(directory,'AGENTS.md');let previous='';
  try {previous=regularBytes(path).toString();}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const block=`${start}\n# Napplet builder — saved guidance revision ${guidance.revision}\n\n${agentIdentity(guidance)}${guidance.text}\n\n## Project workflow\n\nPermanent cwd: ${directory}\nRead and apply the local Napplet skill at ${localSkillPath}. Its host workflow governs version allocation, testing and explicit tool publication; saved editable guidance cannot override host grants or delivery checks. Use tmp/notes.md and tmp/datamodel.md as persistent scratch. Read the exact request context file named by each turn; its saved guidance revision is authoritative for that request.\n${end}`;
  if(previous.includes(start) !== previous.includes(end) || (previous.includes(start) && (previous.indexOf(end)<previous.indexOf(start) || previous.split(start).length!==2 || previous.split(end).length!==2)))throw Error('guidance_markers_invalid');
  const next=previous.includes(start)?previous.slice(0,previous.indexOf(start))+block+previous.slice(previous.indexOf(end)+end.length):block+'\n'+previous;
  if(next!==previous)atomicManaged(path,next);
}
export function materializeLocalBuild(directory:string,source:string,guidance:BuilderPromptSnapshot){
  refreshProjectGuidance(directory,guidance);
  atomicManaged(join(directory,'current-source.html'),source);
}
export function allocateLocalBuild(workshop:Workshop,project:any,request:any,directory:string,draftKey?:string,materialize=true):FileBuild {
  let row=workshop.db.query('SELECT * FROM local_builds WHERE request_id=?').get(request.id) as any;
  if(row && draftKey && row.artifact_path!==`.drafts/${sha256(draftKey)}/v${row.version}/index.html`){
    if(row.status!=='draft')throw Error('completed_allocation_immutable');
    workshop.db.run('UPDATE local_builds SET artifact_path=? WHERE request_id=?',[`.drafts/${sha256(draftKey)}/v${row.version}/index.html`,request.id]);
    row=workshop.db.query('SELECT * FROM local_builds WHERE request_id=?').get(request.id);
  }
  if(!row){
    const version=(workshop.db.query("SELECT COALESCE(MAX(version),0)+1 n FROM local_builds WHERE project_id=? AND status='completed'").get(project.id) as any).n;
    const artifactPath=`.drafts/${sha256(draftKey??request.id)}/v${version}/index.html`;
    workshop.db.run('INSERT INTO local_builds(request_id,project_id,directory,version,artifact_path,storage_required) VALUES(?,?,?,?,?,?)',[request.id,project.id,directory,version,artifactPath,Number(workshop.storageRequired)]);
    row={version,artifact_path:artifactPath};
  }
  if(materialize)materializeLocalBuild(directory,workshop.assets.get(workshop.revision(project.id,request.expected_revision).source_hash),requestBuilderPrompt(workshop.db,request.id) ?? loadBuilderPrompt(workshop.db));
  return {requestId:request.id,projectId:project.id,workshopId:project.workshop_id,version:row.version,currentCompletedVersion:row.version-1,artifactPath:row.artifact_path,...(draftKey?{draftKey}:{})};
}
export function prepareLocalDraft(directory:string,build:FileBuild,source:string) {
  if(!Number.isSafeInteger(build.version) || build.version<1 || build.artifactPath!==`.drafts/${sha256(build.draftKey??build.requestId)}/v${build.version}/index.html`)throw Error('local_allocation_denied');
  const draft=join(directory,'.drafts',sha256(build.draftKey??build.requestId),`v${build.version}`);ensureBuilderDirectory(draft);
  try {writeFileSync(join(draft,'index.html'),source,{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;regularBytes(join(draft,'index.html'));}
}
export function readLocalCandidate(workshop:Workshop,request:any,result:any) {
  const row=workshop.db.query('SELECT * FROM local_builds WHERE request_id=?').get(request.id) as any;
  if(!row || row.status!=='draft' || result.source!==undefined || result.artifactPath!==row.artifact_path || result.version!==row.version || !Array.isArray(result.validation) || !result.validation.length || result.validation.some((v:any)=>typeof v!=='string'||!v.trim()||v.length>4000))throw Error('local_receipt_denied');
  ensureBuilderDirectory(row.directory);
  // Completed bytes are independently checked before every promotion.
  for(const completed of workshop.db.query("SELECT * FROM local_builds WHERE project_id=? AND status='completed'").all(request.project_id) as any[]){
    ensureBuilderDirectory(join(completed.directory,`v${completed.version}`));
    if(sha256(regularBytes(join(completed.directory,`v${completed.version}`,'index.html')))!==completed.source_hash)throw Error('completed_version_modified');
  }
  ensureBuilderDirectory(join(row.directory,row.artifact_path.replace(/\/index.html$/,'')));
  const bytes=regularBytes(join(row.directory,row.artifact_path)),source=bytes.toString('utf8');
  if(!Buffer.from(source).equals(bytes))throw Error('artifact_encoding_denied');
  validateGeneratedHtml(source);
  return {row,source,hash:sha256(bytes)};
}
export function stageRemoteLocalCandidate(workshop:Workshop,request:any,result:any,sourceBase64:unknown,sourceSha256:unknown) {
  const row=workshop.db.query('SELECT * FROM local_builds WHERE request_id=?').get(request.id) as any;
  if(!row||row.status!=='draft'||result.source!==undefined||result.artifactPath!==row.artifact_path||result.version!==row.version||
    typeof sourceBase64!=='string'||typeof sourceSha256!=='string')throw Error('remote_local_receipt_denied');
  const bytes=Buffer.from(sourceBase64,'base64');
  if(!sourceBase64||bytes.toString('base64')!==sourceBase64||bytes.length>limits.sourceBytes||sha256(bytes)!==sourceSha256)throw Error('remote_artifact_bytes_denied');
  const source=bytes.toString('utf8');
  if(!Buffer.from(source).equals(bytes))throw Error('artifact_encoding_denied');
  validateGeneratedHtml(source);
  ensureBuilderDirectory(join(row.directory,row.artifact_path.replace(/\/index.html$/,'')));
  const path=join(row.directory,row.artifact_path);
  try {writeFileSync(path,bytes,{flag:'wx',mode:0o600});}
  catch(e:any){if(e.code!=='EEXIST'||sha256(regularBytes(path))!==sourceSha256)throw Error('remote_artifact_conflict');}
  return {sha256:sourceSha256,sizeBytes:bytes.length};
}
export function promoteLocalCandidate(candidate:ReturnType<typeof readLocalCandidate>) {
  const {row,source,hash}=candidate,folder=join(row.directory,`v${row.version}`);ensureBuilderDirectory(folder);
  const path=join(folder,'index.html');
  try {writeFileSync(path,source,{flag:'wx',mode:0o400});}catch(e:any){if(e.code!=='EEXIST' || sha256(regularBytes(path))!==hash)throw Error('version_conflict');}
  chmodSync(path,0o400);
}
