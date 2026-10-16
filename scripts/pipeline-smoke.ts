import { createHash } from "node:crypto";
import { loadCapabilityClient } from "./autopilot-runtime.ts";

// Signed installation verification only; never wire this session broker into WApp.
const [definitionId, inputFile, evidencePath, callbackUrl] = Bun.argv.slice(2);
if (!definitionId || !inputFile || !evidencePath) throw new Error("Usage: pipeline-smoke.ts definition-id input-file ignored-receipt-file [public-callback-url]");
if (Bun.spawnSync(["git","check-ignore",evidencePath]).exitCode !== 0 ||
    Bun.spawnSync(["git","ls-files","--error-unmatch",evidencePath]).exitCode === 0) throw new Error("Evidence must be ignored and untracked");
const {callCapabilityBroker}=await loadCapabilityClient();
const origin=process.env.WINGMAN_URL;
if (!origin) throw new Error("WINGMAN_URL required");
const input=await Bun.file(inputFile).json();
if (!input.requestId || !input.projectId || typeof input.prompt!=="string") throw new Error("Correlated input required");
const receipts:unknown[]=[];
async function api(path:string,method="GET",payload?:unknown) {
  const url=new URL(path,origin).href,body=payload===undefined?undefined:JSON.stringify(payload);
  const bodyHash=body?createHash("sha256").update(body).digest("hex"):null;
  const auth=await callCapabilityBroker("/api/mcp/capabilities/nip98",{url,method,...(bodyHash?{bodyHash}:{})});
  const event=JSON.parse(Buffer.from(auth.token.replace(/^Nostr /,""),"base64").toString());
  const response=await fetch(url,{method,redirect:"error",headers:{authorization:auth.token,"content-type":"application/json"},...(body?{body}:{})});
  const result=await response.json();
  receipts.push({url,method,body:body??null,bodyHash,event,httpStatus:response.status,result});
  await Bun.write(evidencePath,JSON.stringify({requestId:input.requestId,projectId:input.projectId,definitionId,receipts},null,2)+"\n");
  if (!response.ok) throw new Error(`HTTP ${response.status}; see evidence`);
  return result;
}
const start=await api(`/api/pipelines/definitions/${encodeURIComponent(definitionId)}/runs`,"POST",{
  mode:callbackUrl?"webhook":"poll",idempotencyKey:input.requestId,input,...(callbackUrl?{webhook:{url:callbackUrl}}:{}),
});
const status=await api(`/api/pipelines/runs/${encodeURIComponent(start.runId)}`);
const delivery=await api(`/api/pipelines/runs/${encodeURIComponent(start.runId)}/delivery`);
console.log(JSON.stringify({runId:start.runId,replayed:start.replayed,terminal:status.terminal,
  status:status.status,result:status.terminal?status.result:null,delivery:delivery.delivery,evidencePath},null,2));
