import { expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { createHash } from "node:crypto";
import { applyDelivery, verifyDelivery, type DeliveryTransaction } from "./receiver.ts";

const key = generateSecretKey(); // Synthetic test identity only.
const now = 1791687000;
const url = "https://receiver.example/api/pipeline/result";
const envelope = {runId:"run",deliveryId:"delivery",terminal:true,status:"ok",error:null,
  result:{requestId:"request",projectId:"project",action:"classifier_error",banRequired:false,retryable:true}};
function signed(body=JSON.stringify(envelope), attempt=1, changes: Record<string,unknown>={}) {
  const event = finalizeEvent({kind:27235,created_at:now,content:"",tags:[
    ["u",url],["method","POST"],["payload",createHash("sha256").update(body).digest("hex")],
    ["delivery","delivery"],["run","run"],["attempt",String(attempt)],
  ],...changes},key);
  return {body,authorization:"Nostr "+Buffer.from(JSON.stringify(event)).toString("base64"),
    publicUrl:url,signerPubkey:getPublicKey(key),deliveryHeader:"delivery",runHeader:"run",nowSeconds:now};
}
function transaction(): DeliveryTransaction {
  const events = new Set<string>(), deliveries = new Map<string,string>();
  return {hasEvent:id=>events.has(id),deliveryHash:id=>deliveries.get(id)??null,
    requestForRun:id=>id==="run"?{requestId:"request",projectId:"project"}:null,
    recordEvent:id=>{events.add(id)}, apply:receipt=>{deliveries.set(receipt.envelope.deliveryId,receipt.bodyHash)}};
}
test("exact signed terminal request accepted; auth replay denied and fresh retry deduplicated",()=>{
  const first = verifyDelivery(signed()); const tx = transaction();
  expect(applyDelivery(first,tx)).toBe("applied");
  expect(()=>applyDelivery(first,tx)).toThrow("auth_replay");
  expect(applyDelivery(verifyDelivery(signed(undefined,2)),tx)).toBe("duplicate");
});
test("forgery, wrong URL/body/header/signer, duplicate tags and stale signatures denied",()=>{
  const valid = signed();
  for (const changes of [{publicUrl:url+"/evil"},{body:valid.body+" "},{runHeader:"foreign"},
    {deliveryHeader:"foreign"},{signerPubkey:getPublicKey(generateSecretKey())},{nowSeconds:now+61},
    {nowSeconds:now-16},{authorization:null}]) expect(()=>verifyDelivery({...valid,...changes})).toThrow();
  expect(()=>verifyDelivery(signed(undefined,1,{content:"evil"}))).toThrow();
  expect(()=>verifyDelivery(signed(undefined,1,{kind:1}))).toThrow();
  expect(()=>verifyDelivery(signed(undefined,0))).toThrow();
  const forged = JSON.parse(Buffer.from(valid.authorization.slice(6),"base64").toString()); forged.sig="0".repeat(128);
  expect(()=>verifyDelivery({...valid,authorization:"Nostr "+Buffer.from(JSON.stringify(forged)).toString("base64")})).toThrow();
  expect(()=>verifyDelivery(signed(undefined,1,{tags:[["u",url],["u",url]]}))).toThrow();
});
test("unknown run and request correlation cannot create an effect",()=>{
  const tx = transaction(); tx.requestForRun=()=>null;
  expect(()=>applyDelivery(verifyDelivery(signed()),tx)).toThrow("unknown_run");
  const body = JSON.stringify({...envelope,result:{...envelope.result,projectId:"other"}});
  expect(()=>applyDelivery(verifyDelivery(signed(body)),transaction())).toThrow("request_correlation_denied");
});
test("delivery mutation and unsupported moderation results denied",()=>{
  const tx=transaction(); applyDelivery(verifyDelivery(signed()),tx);
  expect(()=>applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,error:"changed"}),2)),tx)).toThrow("delivery_payload_conflict");
  for (const result of [{...envelope.result,action:"ban",banRequired:true},
    {...envelope.result,banRequired:true},{...envelope.result,action:"unknown"}]) {
    expect(()=>applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,result}))),transaction())).toThrow();
  }
});
test("ban requires finite independent threshold evidence",()=>{
  const result={requestId:"request",projectId:"project",action:"ban",banRequired:true,
    policyEvidence:{model:"jev-test",policyVersion:"freedomtools-screen-v1",threshold:0.95,injectionProbability:0.95,privateExtractionProbability:0}};
  expect(applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,result}))),transaction())).toBe("applied");
  result.policyEvidence.injectionProbability=0.9499;
  expect(()=>applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,result}))),transaction())).toThrow("invalid_ban_evidence");
});
test("candidate files require the authoritative enclosing run before artifact validation",()=>{
 const result={requestId:"request",projectId:"project",action:"build_failed",banRequired:false,code:"artifact_validation_pending",
  candidate:{requestId:"request",projectId:"project",invocationRunId:"run",projectFiles:[]}};
 expect(applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,result}))),transaction())).toBe("applied");
 result.candidate.invocationRunId="foreign";
 expect(()=>applyDelivery(verifyDelivery(signed(JSON.stringify({...envelope,result}))),transaction())).toThrow("candidate_correlation_denied");
});
