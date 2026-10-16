import {Database} from 'bun:sqlite';
import {join,isAbsolute} from 'node:path';
import {requestBuilderEngine,equalBuilderRuntime} from '../builder-engine.ts';
/** The pinned preparation module obtains runtime selection from immutable server storage. */
export function authorizeConfigurableBuilder(input:Record<string,any>,dataDir:string){
 if(!isAbsolute(dataDir))throw Error('Builder runtime installation path denied');
 const db=new Database(join(dataDir,'workshop.sqlite'),{readonly:true});
 try{
  const choice=requestBuilderEngine(db,input.requestId);
  const request=db.query('SELECT r.project_id,p.owner,p.workshop_id FROM requests r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(input.requestId) as any;
  if(!choice||!request||request.project_id!==input.projectId||request.owner!==input.ownerPubkey||request.workshop_id!==input.workshopId||choice.revision!==input.builderEngineRevision||!equalBuilderRuntime(choice.runtime,input.builderRuntime)||!equalBuilderRuntime(choice.runtime,input.replacementContext?.builderEngine?.runtime)||choice.revision!==input.replacementContext?.builderEngine?.revision)throw Error('builder_runtime_snapshot_denied');
  return {agent:choice.runtime.agent,model:choice.runtime.model,provider:choice.runtime.provider,revision:choice.revision};
 }finally{db.close()}
}
export function prepareConfigurableBuilder(input:Record<string,any>,prepared:Record<string,any>,dataDir:string){
 return {...prepared,...authorizeConfigurableBuilder(input,dataDir)};
}
