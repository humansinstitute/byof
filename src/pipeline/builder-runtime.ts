import {builderEpoch,nextEpoch} from '../builder-lifecycle.ts';
import type {Workshop} from '../workshop.ts';
import type {FollowupConfig} from '../config.ts';
import {runtimeForAgent,validBuilderRuntime,equalBuilderRuntime} from '../builder-engine.ts';
export const gooseBuilderRuntime=runtimeForAgent('goose');
export function sameBuilderRuntime(value:unknown):boolean{return equalBuilderRuntime(value,gooseBuilderRuntime)}
export function runtimeAvailable(config:FollowupConfig|undefined,runtime:unknown):boolean{return !!config&&!config.suspended&&(config.selectableBuilder===true&&validBuilderRuntime(runtime)||equalBuilderRuntime(config.builderRuntime??runtimeForAgent('codex'),runtime))}
/** Called only inside the fenced request transaction. Native transcripts stay separate;
 * prior visible history/current source are seeded by replacementSnapshot. */
export function bindBuilderEpoch(workshop:Workshop,project:any,desired:unknown):any {
 if(!validBuilderRuntime(desired))throw Error('Unsupported builder runtime');
 let epoch=builderEpoch(workshop,project);if(epoch.state!=='active')throw Error('Builder runtime requires an active generation');
 const evidence=epoch.evidence_json?JSON.parse(epoch.evidence_json):{},bound=evidence?.builderRuntime??runtimeForAgent('codex');
 const hasNative=epoch.native_id||(epoch.generation===0&&workshop.db.query('SELECT project_id FROM conversation_receipts WHERE project_id=?').get(project.id));
 if(!equalBuilderRuntime(bound,desired)&&(hasNative||evidence?.builderRuntime))epoch=nextEpoch(workshop,project,'native_agent_change',{previousGeneration:epoch.generation,historyPreserved:true,filesPreserved:true});
 const saved=epoch.evidence_json?JSON.parse(epoch.evidence_json):{};
 workshop.db.run('UPDATE builder_epochs SET evidence_json=? WHERE project_id=? AND generation=?',[JSON.stringify({...saved,builderRuntime:desired}),project.id,epoch.generation]);
 return builderEpoch(workshop,project);
}
export function bindGooseBuilderEpoch(workshop:Workshop,project:any,desired:unknown):any {if(!sameBuilderRuntime(desired))throw Error('Unsupported builder runtime');return bindBuilderEpoch(workshop,project,desired)}
