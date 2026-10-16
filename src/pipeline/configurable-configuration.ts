import type {FollowupConfig} from '../config.ts';
import {agentPublicationConfiguration} from './publication-configuration.ts';
/** Platform readiness is checked by the managed activation script; original grants stay valid. */
export function configurableBuilderConfiguration(current:FollowupConfig,receipt:any,appRoot:string,installationId:string,version=70):FollowupConfig {
 const hashes=receipt.grant?.functionHashes??{};
 // Built-in operations are pinned by the complete definition hash, not functionHashes.
 if(!Number.isSafeInteger(version)||version<70||!hashes[`freedomtools.agentPublish.v${version}`]||!hashes[`freedomtools.followupPrepare.v${version}`]||!(/^[a-f0-9]{64}$/.test(receipt.grant?.definitionHash??'')))throw Error(`Configurable v${version} pinned grant required`);
 const publication=agentPublicationConfiguration(current,receipt,appRoot,installationId);
 function apply(scope:FollowupConfig):FollowupConfig{return {...scope,selectableBuilder:true,builderRuntime:undefined,nativeDeletion:undefined,additionalScopes:scope.additionalScopes?.map(apply)}}
 return apply(publication);
}
