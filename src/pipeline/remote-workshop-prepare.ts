import {isAbsolute,join,resolve} from 'node:path';
import {prepareFollowup} from './followup.ts';
import {ensureBuilderDirectory,seedBuilderSource} from './project-directory.ts';
import {materializeLocalBuild} from '../local-builds.ts';
import {managedStorageTransport,type ManagedStorageScope} from './managed-storage-transport.ts';

export type RemoteWorkshopScope=ManagedStorageScope&{builderRoot:string};

/** Remote Autopilot preparation: re-authorize live WApp state, then prepare only its pinned project directory. */
export async function prepareRemoteWorkshopFollowup(input:Record<string,any>,scope:RemoteWorkshopScope){
 if(!isAbsolute(scope.builderRoot)||resolve(scope.builderRoot)!==scope.builderRoot)throw Error('remote_builder_root_denied');
 const request=await managedStorageTransport(scope,null,undefined,undefined,{body:input});
 const response=await request(scope.appOrigin+'/api/v1/internal/builder/prepare','POST',input);
 if(!response.ok)throw Error(`remote_builder_preparation_denied:${response.status}`);
 const authority=await response.json() as any;
 const expectedDirectory=join(scope.builderRoot,input.workshopId,input.projectId);
 if(authority?.scope?.projectId!==input.projectId||authority.scope.ownerPubkey!==input.ownerPubkey||authority.scope.conversationKey!==input.conversationKey||authority.scope.directory!==expectedDirectory||
    typeof authority.baseConversationKey!=='string'||input.conversationKey!==(input.generation===0?authority.baseConversationKey:authority.baseConversationKey+':generation:'+input.generation)||
    authority?.runtime?.agent!==input.builderRuntime?.agent||authority.runtime.model!==input.builderRuntime?.model||authority.runtime.provider!==input.builderRuntime?.provider||authority.runtime.revision!==input.builderEngineRevision)throw Error('remote_builder_authority_mismatch');
 const prepared=prepareFollowup(input,{...authority.scope,conversationKey:authority.baseConversationKey});
 ensureBuilderDirectory(prepared.directory);
 materializeLocalBuild(prepared.directory,input.source,input.builderPrompt);
 if(!input.replacementContext?.fileBuild)seedBuilderSource(prepared.directory,input.source);
 return {...prepared,...authority.runtime,storageReady:authority.storageReady,mode:authority.storageReady?prepared.mode:'answer',prompt:authority.storageReady?prepared.prompt:prepared.prompt+'\nSTORAGE AUTHORITY: Private publication storage is not ready. This turn is answer-only. Discuss the question or explain that requested app changes must wait for administrator authorization. Do not build, edit app files or call publication.'};
}
