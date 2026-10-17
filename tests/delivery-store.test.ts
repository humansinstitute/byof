import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { application } from "../src/application.ts";
import { sha256 } from "../src/assets.ts";
import { bindRun, repairStaleBuildingRequests } from "../src/delivery-store.ts";
const origin = "https://callback.test";
test("callback bypasses browser origin middleware but verifies signer, correlation and durable idempotent effects", async () => {
  const dir = mkdtempSync("/tmp/freedom-callback-"), signer = generateSecretKey(), host = generateSecretKey();
  const app = application({dataDir:dir,origin,hostPubkey:getPublicKey(host),callbackSignerPubkey:getPublicKey(signer),version:"test"});
  try {
    const memberKey = getPublicKey(generateSecretKey());
    app.db.run("INSERT INTO members VALUES(?,?,?,?,?,?)",[memberKey,"Member","temporary","admitted",20,1]);
    const member = app.auth.member(memberKey), project = app.workshop.create(member,"spinner").project;
    const input = {requestId:crypto.randomUUID(),prompt:"private prompt",expectedRevisionId:project.current_revision};
    app.workshop.submitUnavailable(member,project.id,input); bindRun(app.db,input.requestId,"real-run-reference");
    const result = {requestId:input.requestId,projectId:project.id,action:"classifier_error",banRequired:false,retryable:true};
    const envelope = {runId:"real-run-reference",deliveryId:"delivery-1",terminal:true,status:"ok",result,error:null};
    async function send(attempt: number, changes: Record<string,unknown> = {}) {
      const body = JSON.stringify({...envelope,...changes});
      const event = finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags:[["u",origin+"/api/v1/pipeline/callback"],["method","POST"],["payload",sha256(body)],["run",envelope.runId],["delivery",envelope.deliveryId],["attempt",String(attempt)]]},signer);
      const request = new Request(origin+"/api/v1/pipeline/callback",{method:"POST",headers:{authorization:"Nostr "+Buffer.from(JSON.stringify(event)).toString("base64"),"x-wingman-run-id":envelope.runId,"x-wingman-delivery-id":envelope.deliveryId},body});
      return {request,response:await app.handle(request.clone())};
    }
    const first = await send(1); expect(first.response.status).toBe(200); expect((await first.response.json()).handling).toBe("applied");
    expect((await app.handle(first.request)).status).toBe(401);
    const retry = await send(2); expect(retry.response.status).toBe(200); expect((await retry.response.json()).handling).toBe("duplicate");
    expect((await send(3,{result:{...result,action:"ban",banRequired:true}})).response.status).toBe(401);
    expect((app.db.query("SELECT COUNT(*) n FROM delivery_receipts").get() as any).n).toBe(1);
    expect((app.db.query("SELECT status FROM requests WHERE id=?").get(input.requestId) as any).status).toBe("classifier_error");
    expect(app.auth.member(memberKey).state).toBe("admitted");
    expect((app.db.query("SELECT current_revision FROM projects WHERE id=?").get(project.id) as any).current_revision).toBe(project.current_revision);
  } finally { app.db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("generated callback promotes once and charges once across signed retries", async () => {
  const dir = mkdtempSync("/tmp/freedom-build-"), signer = generateSecretKey();
  const app = application({dataDir:dir,origin,hostPubkey:null,callbackSignerPubkey:getPublicKey(signer),version:"test"});
  try {
    const owner = getPublicKey(generateSecretKey());
    app.db.run("INSERT INTO members VALUES(?,?,?,?,?,?)",[owner,"Member","temporary","admitted",20,1]);
    const member = app.auth.member(owner), project = app.workshop.create(member,"spinner").project;
    const input = {requestId:crypto.randomUUID(),prompt:"game\n",expectedRevisionId:project.current_revision};
    app.workshop.submitUnavailable(member,project.id,input);bindRun(app.db,input.requestId,"build-run");
    const source="<html><body><button>Play generated document</button></body></html>";
    const result={requestId:input.requestId,projectId:project.id,action:"build_completed",banRequired:false,source,nativeReceipt:{requestId:input.requestId,projectId:project.id,invocationRunId:"build-run",receiptId:"native-receipt",sessionId:"session",nativeSessionId:"native",sequence:1}};
    async function send(attempt:number) {
      const body=JSON.stringify({runId:"build-run",deliveryId:"build-delivery",terminal:true,status:"ok",result,error:null});
      const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags:[["u",origin+"/api/v1/pipeline/callback"],["method","POST"],["payload",sha256(body)],["run","build-run"],["delivery","build-delivery"],["attempt",String(attempt)]]},signer);
      return app.handle(new Request(origin+"/api/v1/pipeline/callback",{method:"POST",headers:{authorization:"Nostr "+Buffer.from(JSON.stringify(event)).toString("base64"),"x-wingman-run-id":"build-run","x-wingman-delivery-id":"build-delivery"},body}));
    }
    const first=await send(1);expect(first.status).toBe(200);
    const detail=app.workshop.detail(member,project.id);expect(detail.revisions.length).toBe(2);
    expect((detail.requests[0] as any).prompt).toBe(input.prompt);expect((detail.requests[0] as any).status).toBe("succeeded");
    expect(app.workshop.preview(member,project.id,detail.project.current_revision)).toBe(source);
    expect(app.auth.member(owner).allowance).toBe(19);
    expect((await send(2)).status).toBe(200);
    expect(app.workshop.detail(member,project.id).revisions.length).toBe(2);expect(app.auth.member(owner).allowance).toBe(19);
    expect((app.db.query("SELECT COUNT(*) n FROM build_receipts").get() as any).n).toBe(1);
  } finally {app.db.close();rmSync(dir,{recursive:true,force:true});}
});

test("startup restores a stale building request from its latest matching uncertain delivery", () => {
  const dir = mkdtempSync("/tmp/freedom-reconcile-"), app = application({dataDir:dir,origin,hostPubkey:null,callbackSignerPubkey:null,version:"test"});
  try {
    const owner=getPublicKey(generateSecretKey());
    app.db.run("INSERT INTO members VALUES(?,?,?,?,?,?)",[owner,"Member","temporary","admitted",20,1]);
    const member=app.auth.member(owner),project=app.workshop.create(member,"spinner").project;
    const input={requestId:crypto.randomUUID(),prompt:"dice",expectedRevisionId:project.current_revision};
    app.workshop.submitUnavailable(member,project.id,input);bindRun(app.db,input.requestId,"uncertain-run");
    app.db.run("INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)",["uncertain-delivery","uncertain-run",input.requestId,"hash","execution_uncertain","{}",1]);
    app.db.run("UPDATE requests SET status='building',error=NULL WHERE id=?",[input.requestId]);
    expect(repairStaleBuildingRequests(app.db)).toBe(1);
    expect(app.db.query("SELECT status,error FROM requests WHERE id=?").get(input.requestId)).toEqual({status:"execution_uncertain",error:"Checking the previous build before retrying. Your last saved app is still available."});
  } finally {app.db.close();rmSync(dir,{recursive:true,force:true});}
});

test("startup does not override a building request when a later matching receipt is not uncertain", () => {
  const dir = mkdtempSync("/tmp/freedom-reconcile-"), app = application({dataDir:dir,origin,hostPubkey:null,callbackSignerPubkey:null,version:"test"});
  try {
    const owner=getPublicKey(generateSecretKey());
    app.db.run("INSERT INTO members VALUES(?,?,?,?,?,?)",[owner,"Member","temporary","admitted",20,1]);
    const member=app.auth.member(owner),project=app.workshop.create(member,"spinner").project;
    const input={requestId:crypto.randomUUID(),prompt:"dice",expectedRevisionId:project.current_revision};
    app.workshop.submitUnavailable(member,project.id,input);bindRun(app.db,input.requestId,"finished-run");
    app.db.run("INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)",["uncertain-delivery","finished-run",input.requestId,"hash-1","execution_uncertain","{}",1]);
    app.db.run("INSERT INTO delivery_receipts VALUES(?,?,?,?,?,?,?)",["later-delivery","finished-run",input.requestId,"hash-2","failed","{}",2]);
    app.db.run("UPDATE requests SET status='building',error=NULL WHERE id=?",[input.requestId]);
    expect(repairStaleBuildingRequests(app.db)).toBe(0);
    expect((app.db.query("SELECT status FROM requests WHERE id=?").get(input.requestId) as any).status).toBe("building");
  } finally {app.db.close();rmSync(dir,{recursive:true,force:true});}
});
