import type {Database} from 'bun:sqlite';
import {demand} from './errors.ts';
import {now} from './auth.ts';
import {neverDispatched} from './queued-recovery.ts';
export type BuilderAgent='codex'|'claude'|'goose';
export type BuilderRuntime={agent:'codex'|'claude';provider:'configured';model:null}|{agent:'goose';provider:'openrouter';model:'z-ai/glm-5.3'};
export const builderAgents=['codex','claude','goose'] as const;
export function runtimeForAgent(agent:BuilderAgent):BuilderRuntime{return agent==='goose'?{agent,provider:'openrouter',model:'z-ai/glm-5.3'}:{agent,provider:'configured',model:null}}
export function validBuilderRuntime(value:unknown):value is BuilderRuntime {
 const v=value as any;return !!v&&Object.keys(v).length===3&&builderAgents.includes(v.agent)&&JSON.stringify(runtimeForAgent(v.agent))===JSON.stringify({agent:v.agent,provider:v.provider,model:v.model});
}
export function equalBuilderRuntime(a:unknown,b:unknown):boolean{return validBuilderRuntime(a)&&validBuilderRuntime(b)&&a.agent===b.agent&&a.provider===b.provider&&a.model===b.model}
export function installBuilderEngines(db:Database){db.exec(`CREATE TABLE IF NOT EXISTS builder_engines(workshop_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,agent TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS request_builder_engines(request_id TEXT PRIMARY KEY REFERENCES requests(id),revision INTEGER NOT NULL,runtime_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS request_builder_engine_corrections(request_id TEXT PRIMARY KEY REFERENCES request_builder_engines(request_id),original_revision INTEGER NOT NULL,original_runtime_json TEXT NOT NULL,revision INTEGER NOT NULL,runtime_json TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS request_engine_no_update BEFORE UPDATE ON request_builder_engines BEGIN SELECT RAISE(ABORT,'immutable builder engine'); END;
 CREATE TRIGGER IF NOT EXISTS request_engine_no_delete BEFORE DELETE ON request_builder_engines BEGIN SELECT RAISE(ABORT,'immutable builder engine'); END;
 CREATE TRIGGER IF NOT EXISTS request_engine_correction_no_update BEFORE UPDATE ON request_builder_engine_corrections BEGIN SELECT RAISE(ABORT,'immutable builder engine correction'); END;
 CREATE TRIGGER IF NOT EXISTS request_engine_correction_no_delete BEFORE DELETE ON request_builder_engine_corrections BEGIN SELECT RAISE(ABORT,'immutable builder engine correction'); END;`)}
export function loadBuilderEngine(db:Database,workshopId:string,initial:BuilderAgent='codex'){
 // A Canvas owns its selection. Lazily reading an older Canvas must never copy
 // whatever the primary Canvas happens to use at that moment.
 db.run('INSERT OR IGNORE INTO builder_engines VALUES(?,1,?,?)',[workshopId,initial,now()]);
 const row=db.query('SELECT revision,agent,updated_at FROM builder_engines WHERE workshop_id=?').get(workshopId) as any;
 demand(builderAgents.includes(row.agent),409,'Saved builder engine is unsupported');
 return {revision:row.revision,agent:row.agent as BuilderAgent,runtime:runtimeForAgent(row.agent),updatedAt:row.updated_at};
}
export function saveBuilderEngine(db:Database,workshopId:string,body:any){
 demand(builderAgents.includes(body.agent),400,'Choose Codex, Claude or Goose');
 demand(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>0,400,'Expected saved engine revision is required');
 demand(!['model','provider','runtime','builderRuntime'].some(k=>Object.hasOwn(body,k)),400,'Provider and model are managed by the installation');
 loadBuilderEngine(db,workshopId);
 return db.transaction(()=>{demand(db.run('UPDATE builder_engines SET revision=revision+1,agent=?,updated_at=? WHERE workshop_id=? AND revision=?',[body.agent,now(),workshopId,body.expectedRevision]).changes===1,409,'Builder engine changed; reload before saving');return loadBuilderEngine(db,workshopId)}).immediate();
}
export function snapshotBuilderEngine(db:Database,workshopId:string,requestId:string){const choice=loadBuilderEngine(db,workshopId);db.run('INSERT INTO request_builder_engines VALUES(?,?,?)',[requestId,choice.revision,JSON.stringify(choice.runtime)])}
export function requestBuilderEngine(db:Database,requestId:string):{revision:number;runtime:BuilderRuntime}|undefined {
 const row=db.query(`SELECT COALESCE(c.revision,e.revision) revision,COALESCE(c.runtime_json,e.runtime_json) runtime_json
  FROM request_builder_engines e LEFT JOIN request_builder_engine_corrections c ON c.request_id=e.request_id WHERE e.request_id=?`).get(requestId) as any;if(!row)return;
 const runtime=JSON.parse(row.runtime_json);demand(validBuilderRuntime(runtime),409,'Saved request engine is unsupported');return {revision:row.revision,runtime};
}
export function correctNeverDispatchedBuilderEngine(db:Database,workshopId:string,projectId:string,requestId:string,actor:string,body:any){
 demand(typeof body?.reason==='string'&&!!body.reason.trim()&&body.reason.length<=1000,400,'Correction reason is required');
 demand(Number.isSafeInteger(body.expectedRequestRevision)&&body.expectedRequestRevision>0,400,'Expected request engine revision is required');
 demand(Number.isSafeInteger(body.expectedCanvasRevision)&&body.expectedCanvasRevision>0,400,'Expected Canvas engine revision is required');
 return db.transaction(()=>{
  const request=db.query('SELECT r.* FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND r.project_id=? AND p.workshop_id=?').get(requestId,projectId,workshopId) as any;
  demand(request,404,'Saved request not found');demand(neverDispatched(db,request),409,'Builder selection cannot change after dispatch may have started');
  demand(!db.query('SELECT request_id FROM request_builder_engine_corrections WHERE request_id=?').get(requestId),409,'Saved request engine was already corrected');
  const original=db.query('SELECT revision,runtime_json FROM request_builder_engines WHERE request_id=?').get(requestId) as any;demand(original,409,'Saved request engine snapshot is missing');
  demand(original.revision===body.expectedRequestRevision,409,'Saved request engine changed; reload before correcting');
  const selected=loadBuilderEngine(db,workshopId);demand(selected.revision===body.expectedCanvasRevision,409,'Canvas builder engine changed; reload before correcting');
  const originalRuntime=JSON.parse(original.runtime_json);demand(validBuilderRuntime(originalRuntime),409,'Saved request engine is unsupported');
  demand(!equalBuilderRuntime(originalRuntime,selected.runtime),409,'Saved request already uses the selected Canvas builder');
  db.run('INSERT INTO request_builder_engine_corrections VALUES(?,?,?,?,?,?,?,?)',[requestId,original.revision,original.runtime_json,selected.revision,JSON.stringify(selected.runtime),actor,body.reason.trim(),now()]);
  return requestBuilderEngine(db,requestId)!;
 }).immediate();
}
