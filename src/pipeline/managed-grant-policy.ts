import { createHash } from "node:crypto";

export type PipelineGrant = {
  appId:string; ownerNpub:string; appRoot:string; appPubkey:string;
  origin:string; definitionId:string; callbackUrl:string; expiresAt:number;
};
export type ScopedHttpRequest = {url:string;method:string;body:string|null};

// Validate inside the MANAGED broker before using callback-only key custody.
// The caller cannot assert grant metadata, app lookup, run ownership or clock.
export function authorizePipelineHttp(grant:PipelineGrant,request:ScopedHttpRequest,context:{
  nowSeconds:number; app:{id:string;ownerNpub:string;root:string;pubkey:string};
  ownsRun:(runId:string,appId:string)=>boolean;
}): {bodyHash:string|null} {
  const {app}=context;
  if (app.id!==grant.appId || app.ownerNpub!==grant.ownerNpub || app.root!==grant.appRoot ||
      app.pubkey!==grant.appPubkey || !Number.isInteger(grant.expiresAt) || grant.expiresAt<=context.nowSeconds) throw new Error("app_grant_denied");
  const url=new URL(request.url),origin=new URL(grant.origin);
  if (url.origin!==origin.origin || url.protocol!=="https:" || url.username || url.password || url.hash || url.search ||
      url.port && url.port!=="443") throw new Error("pipeline_target_denied");
  const start=`/api/pipelines/definitions/${encodeURIComponent(grant.definitionId)}/runs`;
  if (request.method==="POST" && url.pathname===start) {
    if (!request.body || Buffer.byteLength(request.body)>65536) throw new Error("pipeline_body_denied");
    let body:any;
    try {body=JSON.parse(request.body)} catch {throw new Error("pipeline_body_denied")}
    if (!body || Object.keys(body).sort().join(",")!=="idempotencyKey,input,mode,webhook" ||
        body.mode!=="webhook" || body.webhook?.url!==grant.callbackUrl ||
        Object.keys(body.webhook).join(",")!=="url" || typeof body.idempotencyKey!=="string" ||
        !body.idempotencyKey || body.idempotencyKey.length>200 || body.input?.requestId!==body.idempotencyKey ||
        typeof body.input.projectId!=="string" || !body.input.projectId || typeof body.input.prompt!=="string" ||
        !body.input.prompt.trim() || body.input.prompt.length>8000 ||
        Object.keys(body.input).some(k=>!["requestId","projectId","prompt","contextRefs"].includes(k))) throw new Error("pipeline_body_denied");
    return {bodyHash:createHash("sha256").update(request.body).digest("hex")};
  }
  if (request.method!=="GET" || request.body!==null) throw new Error("pipeline_method_denied");
  if (url.pathname==="/api/pipelines/webhook-signer") return {bodyHash:null};
  const run=url.pathname.match(/^\/api\/pipelines\/runs\/([^/]+)(?:\/delivery)?$/);
  if (!run || !context.ownsRun(decodeURIComponent(run[1]),grant.appId)) throw new Error("pipeline_run_denied");
  return {bodyHash:null};
}
