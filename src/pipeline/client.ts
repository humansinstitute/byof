import { createHash, randomUUID } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";

export type AppSigner = (event: {
  kind: number; created_at: number; content: string; tags: string[][];
}, request: { url: string; method: string; body: string | null }) => Promise<Event>;
export type RequestReceipt = { url: string; method: string; body: string | null; event: Event;
  httpStatus: number; response: unknown };

// Supply a managed APP-only broker signer, never the implementation session signer.
export class PipelineClient {
  constructor(private readonly config: {origin:string; definitionId:string; callbackUrl:string;
    appPubkey:string; signer:AppSigner; fetch?:typeof fetch; receipt?:(receipt:RequestReceipt)=>Promise<void>}) {
    for (const value of [config.origin,config.callbackUrl]) {
      const url=new URL(value);
      if (url.protocol!=="https:" || url.username || url.password || url.hash || (url.port && url.port!=="443")) throw new Error("public_https_required");
    }
    if (!/^[0-9a-f]{64}$/.test(config.appPubkey) || !config.definitionId) throw new Error("app_configuration_required");
  }
  private async request(path:string,method:string,payload?:unknown) {
    const url=new URL(path,this.config.origin).href;
    const body=payload===undefined?undefined:JSON.stringify(payload);
    const tags=[["u",url],["method",method],["nonce",randomUUID()]];
    if (body) tags.push(["payload",createHash("sha256").update(body).digest("hex")]);
    const unsigned={kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags};
    const event=await this.config.signer(unsigned,{url,method,body:body??null});
    if (event.pubkey!==this.config.appPubkey || !verifyEvent(JSON.parse(JSON.stringify(event))) ||
        event.kind!==unsigned.kind || event.created_at!==unsigned.created_at || event.content!=="" ||
        JSON.stringify(event.tags)!==JSON.stringify(tags)) throw new Error("app_signer_binding_denied");
    const response=await (this.config.fetch??fetch)(url,{method,redirect:"error",
      signal:AbortSignal.timeout(15000),headers:{authorization:"Nostr "+Buffer.from(JSON.stringify(event)).toString("base64"),
        ...(body?{"content-type":"application/json"}:{})},...(body?{body}:{})});
    const result=await response.json();
    await this.config.receipt?.({url,method,body:body??null,event,httpStatus:response.status,response:result});
    if (!response.ok) throw new Error(`pipeline_http_${response.status}`);
    return result;
  }
  async submit(input:{requestId:string;projectId:string;prompt:string;contextRefs?:unknown}) {
    const result=await this.request(`/api/pipelines/definitions/${encodeURIComponent(this.config.definitionId)}/runs`,"POST",{
      mode:"webhook",idempotencyKey:input.requestId,input,webhook:{url:this.config.callbackUrl},
    });
    if (typeof result.runId!=="string" || !result.runId || typeof result.terminal!=="boolean") throw new Error("malformed_acceptance");
    // Caller atomically stores runId against the already-durable request before
    // processing callbacks. Acceptance never promotes revisions or applies bans.
    return {runId:result.runId,accepted:true as const};
  }
  async poll(runId:string) {
    if (!runId) throw new Error("stored_run_required");
    return this.request(`/api/pipelines/runs/${encodeURIComponent(runId)}`,"GET");
  }
  async signerDiscovery() { return this.request("/api/pipelines/webhook-signer","GET"); }
}
