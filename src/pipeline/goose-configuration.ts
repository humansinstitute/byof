import type {FollowupConfig} from '../config.ts';
import {agentPublicationConfiguration} from './publication-configuration.ts';
import {gooseBuilderRuntime} from './builder-runtime.ts';
/** Requires an immutable v69 publication grant; old Codex recovery grants remain untouched. */
export function gooseBuilderConfiguration(current:FollowupConfig,receipt:any,appRoot:string,installationId:string):FollowupConfig {
 const hashes=receipt.grant?.functionHashes??{};
 if(!hashes['freedomtools.agentPublish.v69']||!hashes['freedomtools.followupPrepare.v69']||!hashes['session.completedTurn'])throw Error('Goose v69 pinned grant required');
 const publication=agentPublicationConfiguration(current,receipt,appRoot,installationId);
 function apply(scope:FollowupConfig):FollowupConfig{return {...scope,builderRuntime:gooseBuilderRuntime,nativeDeletion:undefined,additionalScopes:scope.additionalScopes?.map(apply)}}
 return apply(publication);
}
