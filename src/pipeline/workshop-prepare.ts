import { Database } from 'bun:sqlite';
import { join, isAbsolute, resolve } from 'node:path';
import { projectRoute } from '../project-routing.ts';
import type { FollowupConfig } from '../config.ts';
import { prepareFollowup, type TrustedOwnerScope } from './followup.ts';

export type WorkshopFollowupAuthority = {
  scope: {projectId:string;ownerPubkey:string;conversationKey:string;directory:string};
  baseConversationKey: string;
  storageReady: boolean;
};

/** Installation-pinned database, never a browser-supplied authority or path. */
export function authorizeWorkshopFollowup(input: Record<string, any>, scope: TrustedOwnerScope & { dataDir: string }):WorkshopFollowupAuthority {
  if (!isAbsolute(scope.dataDir) || resolve(scope.dataDir)!==scope.dataDir) throw Error('workshop_installation_denied');
  const db = new Database(join(scope.dataDir,'workshop.sqlite'), {readonly:true});
  try {
    const project = db.query('SELECT * FROM projects WHERE id=?').get(input.projectId) as any;
    const request = db.query('SELECT * FROM requests WHERE id=? AND project_id=?').get(input.requestId,input.projectId) as any;
    const legacy = (db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any)?.workshop_id;
    const room = project?.workshop_id===legacy ? db.query('SELECT * FROM room WHERE id=1').get() as any : db.query('SELECT * FROM workshops WHERE id=?').get(project?.workshop_id ?? '') as any;
    const member = project?.workshop_id===legacy ? db.query('SELECT state,allowance FROM members WHERE pubkey=?').get(project?.owner ?? '') as any : db.query('SELECT state,allowance FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(project?.workshop_id ?? '',project?.owner ?? '') as any;
    const saved = db.query('SELECT input_json FROM request_recoveries WHERE request_id=?').get(input.requestId) as any;
    const snapshot = saved && JSON.parse(saved.input_json);
    if (!project || !request || project.owner!==input.ownerPubkey || project.workshop_id!==input.workshopId || !room || room.paused || member?.state!=='admitted' || (request.mode!=='answer' && !(member.allowance>0)) || request.expected_revision!==project.current_revision || !['dispatching','building','dispatch_pending'].includes(request.status) || request.prompt!==input.prompt || request.mode!==input.mode || !snapshot || ['contextHash','nativeRequestId','generation','conversationKey'].some(k=>snapshot[k]!==input[k])) throw Error('workshop_membership_denied');
    const config = {...scope.legacy,ownerPubkey:scope.ownerPubkey,builderRoot:scope.builderRoot,workshopId:scope.workshopId,fileVersions:true,replacementEnabled:true,memberWorkshops:true} as FollowupConfig;
    const route = projectRoute(project,config);
    if (!route || input.replacementContext?.fileBuild?.workshopId!==project.workshop_id) throw Error('workshop_scope_denied');
    const binding=(project.workshop_id===legacy?db.query('SELECT status,namespace_json FROM storage_binding WHERE id=1').get():db.query('SELECT status,namespace_json FROM workshop_storage_bindings WHERE workshop_id=?').get(project.workshop_id)) as any;
    const storageReady=!room.tower_id&&!binding||binding?.status==='ready'&&!!binding.namespace_json;
    return {scope:{projectId:route.projectId,ownerPubkey:route.ownerPubkey,conversationKey:snapshot.conversationKey,directory:route.directory!},baseConversationKey:route.conversationKey,storageReady};
  } finally { db.close(); }
}

/** Co-hosted compatibility path. Remote installations authorize over the signed internal API. */
export function prepareWorkshopFollowup(input: Record<string, any>, scope: TrustedOwnerScope & { dataDir: string }) {
  const authority=authorizeWorkshopFollowup(input,scope);
  const prepared=prepareFollowup(input,{...authority.scope,conversationKey:authority.baseConversationKey});
  return {...prepared,storageReady:authority.storageReady,mode:authority.storageReady?prepared.mode:'answer',prompt:authority.storageReady?prepared.prompt:prepared.prompt+'\nSTORAGE AUTHORITY: Private publication storage is not ready. This turn is answer-only. Discuss the question or explain that requested app changes must wait for administrator authorization. Do not build, edit app files or call publication.'};
}
