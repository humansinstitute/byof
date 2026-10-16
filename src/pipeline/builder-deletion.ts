import type {FollowupScope} from './followup.ts';
export function prepareBuilderDeletion(input:any,scope:FollowupScope){
  if(input.ownerPubkey!==scope.ownerPubkey||input.projectId!==scope.projectId||!Number.isSafeInteger(input.generation)||input.generation<0||input.conversationKey!==(input.generation===0?scope.conversationKey:scope.conversationKey+':generation:'+input.generation)||typeof input.requestId!=='string'||!input.requestId||!input.expectedNativeSessionId||!input.expectedWingmanSessionId)throw Error('builder_deletion_scope_denied');
  return {conversationKey:input.conversationKey,projectId:scope.projectId,directory:scope.directory,requestId:input.requestId,confirmation:'delete_native_transcript'};
}
export function builderDeletionCandidate(input:any){
  const r=input.deletion;
  if(r?.status!=='deleted'||r.requestId!==input.requestId||r.projectId!==input.projectId||r.conversationKey!==input.conversationKey||r.sessionId!==input.expectedWingmanSessionId||r.nativeSessionId!==input.expectedNativeSessionId||r.runtimeStorageDeleted!==true||typeof r.nativeTranscriptDeleted!=='boolean'||r.nativeStorageDeleted!==false||r.metadataIndexesPreserved!==true||!r.receiptId)throw Error('builder_deletion_receipt_denied');
  return {action:'builder_storage_deleted',requestId:input.requestId,projectId:input.projectId,generation:input.generation,deletionReceipt:r};
}
