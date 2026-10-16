import { createHash } from "node:crypto";
import { loadCapabilityClient } from "./autopilot-runtime.ts";

// Operator/implementation CLI only. The deployed WApp uses its own app broker.
const { callCapabilityBroker } = await loadCapabilityClient();
const origin = process.env.WINGMAN_URL;
if (!origin) throw new Error("WINGMAN_URL required");
const evidencePath = process.argv[2];
if (!evidencePath) throw new Error("Supply a verified ignored evidence path");
const ignored = Bun.spawnSync(["git","check-ignore",evidencePath]);
const tracked = Bun.spawnSync(["git","ls-files","--error-unmatch",evidencePath]);
if (ignored.exitCode !== 0 || tracked.exitCode === 0) throw new Error("Evidence must be ignored and untracked");
const receipts: unknown[]=[];
async function api(path: string, method="GET", payload?: unknown) {
  const url = new URL(path,origin).href;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const signed = await callCapabilityBroker("/api/mcp/capabilities/nip98", {url,method,
    ...(body ? {bodyHash:createHash("sha256").update(body).digest("hex")} : {})});
  const response = await fetch(url,{method,headers:{authorization:signed.token,"content-type":"application/json"},...(body?{body}:{})});
  const result=await response.json();
  receipts.push({url,method,status:response.status,bodyHash:body?createHash("sha256").update(body).digest("hex"):null,result});
  await Bun.write(evidencePath,JSON.stringify(receipts,null,2)+"\n");
  if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
  return result;
}
const root=await api("/api/pipelines/root");
for (const operation of ["screen","decision","gatedBuilder","terminal"]) {
  const bundle=await Bun.build({entrypoints:[`pipelines/${operation}.v1.ts`],target:"bun",format:"esm",minify:false});
  if (!bundle.success || bundle.outputs.length !== 1) throw new Error("Function bundle failed");
  await api("/api/docs/file","POST",{directory:root.userFunctions,name:`freedomtools-${operation}.v1.mjs`,content:await bundle.outputs[0].text()});
}
const definitions=await api("/api/pipelines/definitions");
const existing=definitions.definitions.find((d:any)=>d.name==="Freedom Tools project build");
if (!existing) await api("/api/docs/file","POST",{directory:root.userDefinitions,name:"freedomtools-build.v1.json",content:await Bun.file("pipelines/freedomtools-build.v1.json").text()});
const catalog=await api("/api/pipelines/definitions");
const definition=catalog.definitions.find((d:any)=>d.name==="Freedom Tools project build");
const functions=await api("/api/pipelines/functions");
const names=["screen","decision","gatedBuilder","terminal"].map(n=>`freedomtools.${n}.v1`);
for (const name of names) if (!functions.functions.some((f:any)=>f.name===name && f.status==="ok")) throw new Error(`Function unavailable: ${name}`);
console.log(JSON.stringify({definition,functions:names,evidencePath},null,2));
