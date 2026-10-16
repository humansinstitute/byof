import {expect,test} from "bun:test";
import {authorizePipelineHttp,type PipelineGrant} from "./managed-grant-policy.ts";
const grant:PipelineGrant={appId:"app",ownerNpub:"owner",appRoot:"/managed/app",appPubkey:"public",
  origin:"https://autopilot.example",definitionId:"user:app:build",callbackUrl:"https://receiver.example/result",expiresAt:200};
const context={nowSeconds:100,app:{id:"app",ownerNpub:"owner",root:"/managed/app",pubkey:"public"},ownsRun:(id:string,appId:string)=>id==="own"&&appId==="app"};
const payload={mode:"webhook",idempotencyKey:"request",input:{requestId:"request",projectId:"project",prompt:"edit"},webhook:{url:grant.callbackUrl}};
const start={url:grant.origin+"/api/pipelines/definitions/"+encodeURIComponent(grant.definitionId)+"/runs",method:"POST",body:JSON.stringify(payload)};
test("managed policy permits only fixed pipeline/callback and owned reads",()=>{
  expect(authorizePipelineHttp(grant,start,context).bodyHash).toMatch(/^[0-9a-f]{64}$/);
  for(const path of ["/api/pipelines/runs/own","/api/pipelines/runs/own/delivery","/api/pipelines/webhook-signer"])
    expect(authorizePipelineHttp(grant,{url:grant.origin+path,method:"GET",body:null},context)).toEqual({bodyHash:null});
});
test("app drift, expiry, foreign runs/definitions, redirects and arbitrary bodies denied",()=>{
  for(const app of [{...context.app,id:"other"},{...context.app,ownerNpub:"other"},{...context.app,root:"/changed"},{...context.app,pubkey:"other"}])
    expect(()=>authorizePipelineHttp(grant,start,{...context,app})).toThrow("app_grant_denied");
  expect(()=>authorizePipelineHttp(grant,start,{...context,nowSeconds:200})).toThrow();
  for(const request of [{...start,url:start.url.replace("autopilot.example","foreign.example")},
    {...start,url:start.url+"?arbitrary=true"},{...start,method:"DELETE"},
    {url:grant.origin+"/api/pipelines/runs/foreign",method:"GET",body:null},
    {...start,body:JSON.stringify({...payload,webhook:{url:"https://other.example/result"}})},
    {...start,body:JSON.stringify({...payload,input:{...payload.input,requestId:"changed"}})},
    {...start,body:JSON.stringify({...payload,input:{...payload.input,directory:"/host"}})},
    {...start,body:JSON.stringify({...payload,mode:"poll"})}]) expect(()=>authorizePipelineHttp(grant,request,context)).toThrow();
});
