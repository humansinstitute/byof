import type {FollowupConfig} from '../config.ts';
import {publicKey} from '../config.ts';

/** All capable scopes move together; old immutable requests retain their grants. */
export function agentPublicationConfiguration(current:FollowupConfig,receipt:any,appRoot:string,installationId:string):FollowupConfig {
  const grant=receipt.grant;
  const pins=Object.keys(grant?.functionHashes??{}).filter(name=>/^freedomtools\.agentPublish\.v\d+$/.test(name));
  if(pins.length!==1||!receipt.credentialFile||!grant.definitionId||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=Date.now()||grant.appRoot!==appRoot||grant.installationId!==installationId||publicKey(grant.appNpub)!==current.appPubkey||
    grant.origin!==current.origin||grant.callbackUrl!==new URL('/api/v1/pipeline/message',current.callbackUrl).href)throw Error('Publication grant mismatch');
  function apply(scope:FollowupConfig):FollowupConfig {
    if(!scope.fileVersions||!scope.replacementEnabled||scope.suspended||scope.builderRoot!==current.builderRoot||scope.appPubkey!==current.appPubkey||scope.origin!==current.origin)throw Error('Capable scope changed; review before activation');
    return {...scope,agentPublication:true,receiptRecovery:{...scope,additionalScopes:undefined},previousDefinitionId:scope.definitionId,previousCredentialFile:scope.credentialFile,
      definitionId:grant.definitionId,credentialFile:receipt.credentialFile,callbackUrl:grant.callbackUrl,activityWebhookUrl:new URL('/api/v1/pipeline/activity',scope.callbackUrl).href,
      additionalScopes:scope.additionalScopes?.map(apply)};
  }
  return apply(current);
}
