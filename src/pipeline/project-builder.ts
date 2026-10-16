import {typedDecision} from "./operations.ts";

/** Execution readiness is a pinned definition default, never participant input. */
export function persistentDecision(input:Record<string,unknown>) {
  const result=typedDecision(input);
  return {...result,builderAllowed:result.builderAllowed && input.executionEnabled===true};
}
/** A native completion is a candidate; WApp artifact validation/promotion remains mandatory. */
export function completedCandidate(input:Record<string,unknown>) {
  const turn=input.turn as Record<string,unknown>|undefined;
  const invalid=!turn || turn.status!=="completed" || turn.requestId!==input.requestId || turn.projectId!==input.projectId ||
    typeof turn.invocationRunId!=="string" || !turn.invocationRunId || typeof turn.executionId!=="string" || !turn.executionId ||
    (turn.output as Record<string,unknown>)?.executionProfile!=="isolated-codex" ||
    !Array.isArray((turn.output as Record<string,unknown>)?.projectFiles);
  return {requestId:input.requestId,projectId:input.projectId,action:"build_failed",banRequired:false,retryable:invalid,
    code:invalid?"builder_completion_invalid":"artifact_validation_pending",
    ...(invalid?{}:{candidate:{receiptId:turn.receiptId,executionId:turn.executionId,sequence:turn.sequence,
      requestId:turn.requestId,projectId:turn.projectId,invocationRunId:turn.invocationRunId,projectFiles:(turn.output as Record<string,unknown>).projectFiles}})};
}
/** Only server-selected status names may be relayed. Native text/tool/reasoning is excluded. */
export function safeProgress(input:{runId:string;requestId:string;projectId:string;status:unknown},
  mapping:{runId:string;requestId:string;projectId:string}) {
  if(input.runId!==mapping.runId||input.requestId!==mapping.requestId||input.projectId!==mapping.projectId)throw new Error("progress_mapping_denied");
  const statuses=["queued","screening","building","validating","completed","failed","unavailable"];
  if(typeof input.status!=="string"||!statuses.includes(input.status))throw new Error("progress_status_denied");
  return {...mapping,status:input.status};
}
