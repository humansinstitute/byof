import { isAbsolute, join, resolve } from 'node:path';
import type { FollowupConfig } from './config.ts';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function projectConversation(owner: string, projectId: string) {
  return `byo:${owner}:project:${projectId}`;
}
export function trustedCreation(owner: string, config?: FollowupConfig): boolean {
  if (config?.additionalScopes?.some(scope => trustedCreation(owner,scope))) return true;
  return !!config?.builderRoot && !config.suspended && /^[a-f0-9]{64}$/.test(owner) && owner === config.ownerPubkey && isAbsolute(config.builderRoot) && resolve(config.builderRoot) === config.builderRoot;
}
/** Legacy scope remains literal; new project identities and directories are derived, never supplied by a browser. */
export function projectRoute(project: any, config?: FollowupConfig): FollowupConfig | undefined {
  if (!config) return;
  // This installation template is supplied by the server after workshop selection.
  // Admission and ownership remain authoritative in Workshop and in preparation.
  if (config.memberWorkshops) {
    const pinned = projectRoute(project, {...config, memberWorkshops:false});
    if (pinned) return pinned;
    if (config.suspended || !config.fileVersions || !config.replacementEnabled || !config.builderRoot || !isAbsolute(config.builderRoot) || resolve(config.builderRoot)!==config.builderRoot || !uuid.test(project.workshop_id) || !uuid.test(project.id) || !/^[a-f0-9]{64}$/.test(project.owner) || !(uuid.test(project.conversation_id) || project.conversation_id===projectConversation(project.owner,project.id))) return;
    return {...config,additionalScopes:undefined,ownerPubkey:project.owner,workshopId:project.workshop_id,projectId:project.id,conversationKey:project.conversation_id,directory:join(config.builderRoot,project.workshop_id,project.id),initialContext:true,nativeDeletion:undefined};
  }
  if (project.owner !== config.ownerPubkey) {
    for (const scope of config.additionalScopes ?? []) { const route=projectRoute(project,scope); if (route) return route; }
    return;
  }
  if (config.suspended) return;
  if(config.workshopId && project.workshop_id!==config.workshopId)return;
  if(config.fileVersions) {
    if(!config.builderRoot || !isAbsolute(config.builderRoot) || resolve(config.builderRoot)!==config.builderRoot || !config.workshopId || !uuid.test(config.workshopId) || !uuid.test(project.id) || project.workshop_id !== config.workshopId) return;
    if(project.id !== config.projectId && project.conversation_id !== projectConversation(project.owner,project.id)) return;
    if(project.id === config.projectId && project.conversation_id !== config.conversationKey) return;
    return {...config,projectId:project.id,conversationKey:project.conversation_id,directory:join(config.builderRoot,config.workshopId,project.id),initialContext:true,nativeDeletion:undefined};
  }
  if (project.id === config.projectId && project.conversation_id === config.conversationKey) return config;
  if (!trustedCreation(project.owner, config) || !uuid.test(project.id) || project.conversation_id !== projectConversation(project.owner, project.id)) return;
  return { ...config, projectId: project.id, conversationKey: project.conversation_id,
    directory: join(config.builderRoot!, project.owner, project.id), initialContext: true, nativeDeletion: undefined };
}

/** All admin-created boards share the installed capable builder; no board switch. */
export function workshopBuilders(config?: FollowupConfig): FollowupConfig | undefined {
  return config?.fileVersions && config.replacementEnabled && config.builderRoot
    ? {...config,memberWorkshops:true} : config;
}

export function additionalProjects(member: {pubkey:string;host:boolean;state:string}, config?:FollowupConfig):boolean {
  return (member.host || member.state==='admitted') && (config?.memberWorkshops ? !config.suspended : trustedCreation(member.pubkey,config));
}
