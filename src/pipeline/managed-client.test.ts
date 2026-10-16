import {expect,test} from "bun:test";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {generateSecretKey,getPublicKey,finalizeEvent} from "nostr-tools";
import {createHash} from "node:crypto";
import {ManagedPipelineClient} from "./managed-client.ts";
test("managed broker client keeps credential local, verifies exact signed receipt and returns only acceptance",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"managed-pipeline-client-")),credentialFile=join(dir,"grant.cap"),key=generateSecretKey();
  writeFileSync(credentialFile,"A".repeat(43),{mode:0o600});
  const config={brokerUrl:"http://127.0.0.1:3600/api/internal/wapps/pipelines",credentialFile,origin:"https://autopilot.example",
    definitionId:"definition",callbackUrl:"https://receiver.example/result",appPubkey:getPublicKey(key)};
  try {
    const client=new ManagedPipelineClient({...config,fetch:(async(url,options)=>{
      expect(String(url)).toBe(config.brokerUrl);
      expect(new Headers(options!.headers).get("authorization")).toBe("Bearer "+"A".repeat(43));
      const envelope=JSON.parse(String(options!.body)),target=config.origin+envelope.path;
      const hash=createHash("sha256").update(envelope.serializedBody).digest("hex");
      const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags:[["u",target],["method","POST"],["payload",hash]]},key);
      return Response.json({response:{runId:"run",terminal:false},httpStatus:202,receipt:{url:target,method:"POST",event,bodyHash:hash}},{status:202});
    }) as typeof fetch});
    const result=await client.submit({requestId:"request",projectId:"project",prompt:"edit"});
    expect(result.accepted).toBe(true);expect(result.runId).toBe("run");
    expect(JSON.stringify(result)).not.toContain("A".repeat(43));
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test("remote managed broker binds the exact hosted installation without exporting app signing custody",async()=>{
  const key=generateSecretKey(),credentialEnv="FREEDOM_TEST_REMOTE_PIPELINE_CAPABILITY",previous=process.env[credentialEnv];
  process.env[credentialEnv]="B".repeat(43);
  const config={brokerUrl:"https://autopilot.example/api/wapps/remote-managed-pipelines",credentialEnv,
    origin:"https://autopilot.example",definitionId:"definition",callbackUrl:"https://byof.example/api/v1/storage/callback",
    appPubkey:getPublicKey(key),installationId:"installation",appId:"freedom-tools",ownerNpub:"npub1owner",clientOrigin:"https://byof.example"};
  try {
    const client=new ManagedPipelineClient({...config,fetch:(async(url,options)=>{
      expect(String(url)).toBe(config.brokerUrl);expect(new Headers(options!.headers).get("authorization")).toBe("Bearer "+"B".repeat(43));
      const envelope=JSON.parse(String(options!.body));
      expect({...envelope,request:undefined}).toEqual({installationId:config.installationId,appId:config.appId,ownerNpub:config.ownerNpub,
        clientOrigin:config.clientOrigin,operation:"pipeline.request",request:undefined});
      const target=config.origin+envelope.request.path,hash=createHash("sha256").update(envelope.request.serializedBody).digest("hex");
      const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags:[["u",target],["method","POST"],["payload",hash]]},key);
      return Response.json({response:{runId:"remote-run",terminal:false},httpStatus:202,receipt:{url:target,method:"POST",event,bodyHash:hash}},{status:202});
    }) as typeof fetch});
    const result=await client.submit({requestId:"request",projectId:"project",prompt:"verify"});
    expect(result.accepted).toBe(true);expect(result.runId).toBe("remote-run");expect(JSON.stringify(result)).not.toContain("B".repeat(43));
  } finally {if(previous===undefined)delete process.env[credentialEnv];else process.env[credentialEnv]=previous;}
});
test("remote managed broker rejects widened origins and missing scoped credentials",()=>{
  const base:any={brokerUrl:"https://autopilot.example/api/wapps/remote-managed-pipelines",credentialEnv:"FREEDOM_TEST_REMOTE_PIPELINE_CAPABILITY",
    origin:"https://autopilot.example",definitionId:"definition",callbackUrl:"https://byof.example/api/v1/storage/callback",appPubkey:"a".repeat(64),
    installationId:"installation",appId:"freedom-tools",ownerNpub:"npub1owner",clientOrigin:"https://other.example"};
  expect(()=>new ManagedPipelineClient(base)).toThrow("managed_remote_binding_denied");
  expect(()=>new ManagedPipelineClient({...base,clientOrigin:"https://byof.example",brokerUrl:"http://autopilot.example/api/wapps/remote-managed-pipelines"})).toThrow("managed_remote_broker_denied");
});
