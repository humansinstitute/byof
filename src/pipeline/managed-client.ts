import {readFileSync,lstatSync} from "node:fs";
import {createHash} from "node:crypto";
import {verifyEvent} from "nostr-tools";
import type {PipelineAuthority} from "../config.ts";

/** Server-only client of the installation-scoped local pipeline broker. */
export class ManagedPipelineClient {
  private readonly remote:boolean;
  constructor(private readonly config:PipelineAuthority&{fetch?:typeof fetch}) {
    const url=new URL(config.brokerUrl);
    this.remote=typeof config.credentialEnv==="string";
    if(this.remote){
      const remote=config;
      if(url.protocol!=="https:" || url.pathname!=="/api/wapps/remote-managed-pipelines" || url.origin!==config.origin ||
        url.username || url.password || url.hash || url.search || config.credentialFile!==undefined)throw new Error("managed_remote_broker_denied");
      const clientOrigin=new URL(remote.clientOrigin!);
      if(clientOrigin.protocol!=="https:" || clientOrigin.origin!==remote.clientOrigin || clientOrigin.username || clientOrigin.password ||
        new URL(remote.callbackUrl).origin!==remote.clientOrigin || !/^[A-Z][A-Z0-9_]{2,80}$/.test(remote.credentialEnv!))throw new Error("managed_remote_binding_denied");
      for(const value of [remote.installationId,remote.appId,remote.ownerNpub])if(!value||typeof value!=="string")throw new Error("managed_remote_binding_denied");
    } else if(!config.credentialFile || config.installationId!==undefined || config.appId!==undefined || config.ownerNpub!==undefined || config.clientOrigin!==undefined ||
      url.protocol!=="http:" || url.hostname!=="127.0.0.1" || url.pathname!=="/api/internal/wapps/pipelines" ||
      url.username || url.password || url.hash || url.search)throw new Error("managed_loopback_broker_required");
  }
  async request(path:string,method:"POST"|"GET",payload?:unknown) {
    let token:string;
    if(this.remote){
      token=process.env[this.config.credentialEnv!]?.trim()??"";
    }else{
      const file=lstatSync(this.config.credentialFile!);
      if(!file.isFile() || file.isSymbolicLink() || (file.mode&0o077)!==0 || file.uid!==process.getuid?.())throw new Error("managed_credential_file_denied");
      token=readFileSync(this.config.credentialFile!,"utf8").trim();
    }
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error("managed_credential_invalid");
    const serializedBody=payload===undefined?undefined:JSON.stringify(payload);
    const brokerRequest={path,method,...(serializedBody?{serializedBody}:{})};
    const body=this.remote?JSON.stringify({installationId:this.config.installationId,
      appId:this.config.appId,ownerNpub:this.config.ownerNpub,
      clientOrigin:this.config.clientOrigin,operation:"pipeline.request",request:brokerRequest}):JSON.stringify(brokerRequest);
    const response=await (this.config.fetch??fetch)(this.config.brokerUrl,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
      body});
    const envelope=await response.json();
    if(!response.ok)throw new Error(`managed_pipeline_http_${response.status}`);
    const receipt=envelope.receipt,event=receipt?.event,url=new URL(path,this.config.origin).href;
    const bodyHash=serializedBody?createHash("sha256").update(serializedBody).digest("hex"):null;
    const tag=(name:string)=>{const tags=event?.tags?.filter((value:string[])=>value[0]===name);
      return tags?.length===1 && tags[0].length===2 ? tags[0][1] : undefined};
    const now=Math.floor(Date.now()/1000);
    if(!event || !verifyEvent(JSON.parse(JSON.stringify(event))) || event.pubkey!==this.config.appPubkey ||
      event.kind!==27235 || event.content!=="" || !Number.isInteger(event.created_at) || event.created_at<now-60 || event.created_at>now+15 ||
      receipt.url!==url || receipt.method!==method || receipt.bodyHash!==bodyHash || envelope.httpStatus!==response.status ||
      tag("u")!==url || tag("method")!==method || (bodyHash?tag("payload")!==bodyHash:event.tags.some((value:string[])=>value[0]==="payload")))throw new Error("managed_pipeline_receipt_denied");
    return envelope;
  }
  async submit(input:{requestId:string;projectId:string;prompt:string;contextRefs?:unknown;source?:string},executionKey=input.requestId) {
    const receipt=await this.request(`/api/pipelines/definitions/${encodeURIComponent(this.config.definitionId)}/runs`,"POST",{
      mode:"webhook",idempotencyKey:executionKey,input,webhook:{url:this.config.callbackUrl}});
    if(typeof receipt.response.runId!=="string" || !receipt.response.runId)throw new Error("managed_pipeline_acceptance_invalid");
    return {accepted:true as const,runId:receipt.response.runId,receipt};
  }
  poll(storedRunId:string){return this.request(`/api/pipelines/runs/${encodeURIComponent(storedRunId)}`,"GET")}
}
