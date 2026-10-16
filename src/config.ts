import type {BuilderRuntime} from './builder-engine.ts';
import { nip19 } from "nostr-tools";
import { join, resolve } from "node:path";
export type PipelineAuthority = { brokerUrl: string; origin: string; definitionId: string; callbackUrl: string; appPubkey: string;
  credentialFile?: string; credentialEnv?: string; installationId?: string; appId?: string; ownerNpub?: string; clientOrigin?: string };
export type OperatorBuildConfig = PipelineAuthority & { activityWebhookUrl?: string; approvedRequestId: string };
export type FollowupConfig = OperatorBuildConfig & { builderRuntime?: BuilderRuntime; selectableBuilder?: boolean; projectId: string; ownerPubkey: string; conversationKey: string; receiptRecovery?: FollowupConfig; agentPublication?: boolean; memberWorkshops?: boolean; remotePreparation?: boolean; localBuilderRoot?: string; suspended?: boolean; replacementEnabled?: boolean; abandonmentEnabled?: boolean; directory?: string; builderRoot?: string; workshopId?: string; fileVersions?: boolean; initialContext?: boolean; additionalScopes?: FollowupConfig[]; failedPreparationDefinitionId?: string; failedPreparationCredentialFile?: string; failedPreparationCredentialEnv?: string; nativeDeletion?: OperatorBuildConfig; previousDefinitionId?: string; previousCredentialFile?: string; previousCredentialEnv?: string };
export type Config = { managedStorage?: import("./storage.ts").StorageConfig; storageTemplates?: import("./storage.ts").StorageConfig[]; workshopStorage?: import("./storage.ts").StorageConfig[]; storage?: import("./storage.ts").StorageConfig; dataDir: string; hostPubkey: string | null; adminPubkeys?: string[]; origin: string | null; version: string; callbackSignerPubkey?: string | null; operatorBuild?: OperatorBuildConfig; followup?: FollowupConfig; };
export function publicKey(value: string): string {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  const decoded = nip19.decode(value);
  if (decoded.type !== "npub") throw new Error("Host identity must be npub or public hex");
  return decoded.data;
}
export function configuration(): Config {
  const dataDir=resolve(process.env.FREEDOM_DATA_DIR || "tmp/runtime");
  const configuredRoot=process.env.FREEDOM_NAPPLET_ROOT;
  const followup:FollowupConfig|undefined=process.env.FREEDOM_FOLLOWUP_CONFIG ? JSON.parse(process.env.FREEDOM_FOLLOWUP_CONFIG) : undefined;
  const applyLocalRoot=(scope:FollowupConfig):void=>{
    if(scope.remotePreparation)scope.localBuilderRoot=join(dataDir,'remote-builds');
    scope.additionalScopes?.forEach(applyLocalRoot);
    if(scope.receiptRecovery)applyLocalRoot(scope.receiptRecovery);
  };
  if(followup)applyLocalRoot(followup);
  if(configuredRoot){
    if(!configuredRoot.startsWith('/') || resolve(configuredRoot)!==configuredRoot)throw Error('Absolute canonical Napplet root required');
    const apply=(scope:FollowupConfig):void=>{if(!scope.workshopId || !scope.fileVersions)throw Error('Run napplet-setup before enabling the Napplet root');scope.builderRoot=configuredRoot;scope.additionalScopes?.forEach(apply);};
    if(followup)apply(followup);
  }
  return { managedStorage: process.env.FREEDOM_MANAGED_STORAGE_CONFIG ? JSON.parse(process.env.FREEDOM_MANAGED_STORAGE_CONFIG) : undefined, storageTemplates: process.env.FREEDOM_STORAGE_TEMPLATES ? JSON.parse(process.env.FREEDOM_STORAGE_TEMPLATES) : undefined, workshopStorage: process.env.FREEDOM_WORKSHOP_STORAGE_CONFIG ? JSON.parse(process.env.FREEDOM_WORKSHOP_STORAGE_CONFIG) : undefined, storage: process.env.FREEDOM_STORAGE_CONFIG ? JSON.parse(process.env.FREEDOM_STORAGE_CONFIG) : undefined, followup, operatorBuild: process.env.FREEDOM_OPERATOR_BUILD_CONFIG ? JSON.parse(process.env.FREEDOM_OPERATOR_BUILD_CONFIG) : undefined, adminPubkeys: (process.env.FREEDOM_ADMIN_NPUBS || "").split(",").map(v => v.trim()).filter(Boolean).map(publicKey), dataDir, hostPubkey: process.env.FREEDOM_HOST_NPUB ? publicKey(process.env.FREEDOM_HOST_NPUB) : null, origin: process.env.FREEDOM_ORIGIN || null, callbackSignerPubkey: process.env.FREEDOM_CALLBACK_SIGNER_PUBKEY ? publicKey(process.env.FREEDOM_CALLBACK_SIGNER_PUBKEY) : null, version: process.env.FREEDOM_VERSION || "0.1.0" };
}
export const limits = { participants: 50, projectsPerMember: 100, revisionsPerProject: 100, requestsPerProject: 200, sourceBytes: 256_000, promptChars: 8_000, bodyBytes: 300_000, attachmentBytes: 8_000_000, attachmentBodyBytes: 10_800_000, callbackBytes: 1_048_576, responseChars: 512_000, socketsPerMember: 4, sessionsPerMember: 8, builders: 2, defaultAllowance: 20 };
