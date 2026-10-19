import { test, expect, beforeEach, afterEach } from "bun:test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { mkdtempSync, rmSync } from "node:fs";
import { application } from "../src/application.ts";
import { sha256 } from "../src/assets.ts";
import type { Config } from "../src/config.ts";
const origin = "https://workshop.test";
let app: ReturnType<typeof application>, directory: string, config: Config, hostSecret: Uint8Array;
type Account = { cookie: string; csrf: string; member: any; secret: Uint8Array };
async function call(path: string, body?: any, account?: Account, overrides: Record<string,string> = {}) {
  const response = await app.handle(new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type":"application/json", ...(account ? {cookie:account.cookie,"x-csrf-token":account.csrf} : {}), ...overrides }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) }));
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text(); return {response,data};
}
async function login(secret = generateSecretKey(), body: any = {}): Promise<Account> {
  const challenge = (await call("/api/v1/challenge",{})).data;
  const event = finalizeEvent(challenge.event,secret);
  const result = await call("/api/v1/login",{challengeId:challenge.id,event,identityType:"extension",name:"Test participant",...body});
  expect(result.response.status).toBe(200); return {cookie:result.response.headers.get("set-cookie")!.split(";")[0]!,csrf:result.data.csrf,member:result.data.member,secret};
}
async function setup() { const host = await login(hostSecret,{host:true,name:"Test host"}); await call("/api/v1/host/settings",{title:"Test room",introduction:"Our room",lightning:"hello@getalby.com",paused:false,admission:"open"},host); return {host,a:await login(),b:await login()}; }
async function create(account: Account, starterId = "spinner") { const result = await call("/api/v1/projects",{starterId},account); expect(result.response.status).toBe(201); return result.data; }
beforeEach(() => { directory = mkdtempSync("/tmp/liquid-freedom-test-"); hostSecret = generateSecretKey(); config = {dataDir:directory,hostPubkey:getPublicKey(hostSecret),origin,version:"test"}; app = application(config); });
afterEach(() => { app.db.close(); rmSync(directory,{recursive:true,force:true}); });
test("fresh login signature cannot be replayed, forged, or used for another origin or host", async () => {
  const secret = generateSecretKey(), challenge = (await call("/api/v1/challenge",{})).data;
  const body = {challengeId:challenge.id,event:finalizeEvent(challenge.event,secret),identityType:"temporary"};
  expect((await call("/api/v1/login",{...body,host:true})).response.status).toBe(403);
  expect((await call("/api/v1/login",{...body,event:{...body.event,sig:"0".repeat(128)}})).response.status).toBe(401);
  expect((await call("/api/v1/login",body,undefined,{origin:"https://attacker.test"})).response.status).toBe(403);
  expect((await call("/api/v1/login",body)).response.status).toBe(200);
  expect((await call("/api/v1/login",body)).response.status).toBe(401);
});
test("unknown host cannot gain authority, default membership requires admission", async () => {
  const a = await login(); expect(a.member.host).toBe(false); expect(a.member.state).toBe("pending");
  expect((await call("/api/v1/projects",{starterId:"spinner"},a)).response.status).toBe(403);
  expect((await call("/api/v1/host/people",undefined,a)).response.status).toBe(403);
  const host = await login(hostSecret,{host:true});
  expect((await call(`/api/v1/host/members/${a.member.pubkey}`,{state:"admitted",allowance:20},host)).response.status).toBe(200);
  await create(a);
});
test("an admitted member can create 100 Napplet projects but not exceed the documented capacity", async () => {
  const {a} = await setup();
  const member=app.auth.member(a.member.pubkey);
  for (let i=0;i<100;i++) expect(app.workshop.create(member,"spinner",undefined,true).project.id).toBeString();
  expect(()=>app.workshop.create(member,"spinner",undefined,true)).toThrow("Project capacity reached");
});
test("site administrator can raise only their own admitted build allowance within the configured cap", async()=>{
  const host=await login(hostSecret,{host:true});
  const raised=await call(`/api/v1/host/members/${host.member.pubkey}`,{state:'admitted',allowance:50},host);expect(raised.response.status).toBe(200);
  expect(app.auth.member(host.member.pubkey).allowance).toBe(50);
  expect((await call(`/api/v1/host/members/${host.member.pubkey}`,{state:'banned',allowance:0},host)).response.status).toBe(400);
  expect((await call(`/api/v1/host/members/${host.member.pubkey}`,{state:'admitted',allowance:101},host)).response.status).toBe(400);
});
test("invitation is atomic, finite, and never stores plaintext", async () => {
  const host = await login(hostSecret,{host:true}); const invite = (await call("/api/v1/host/invitations",{uses:1},host)).data;
  app.db.run('UPDATE invitations SET expires_at=1 WHERE hash=?',[sha256(invite.token)]);
  const a = await login(generateSecretKey(),{invitation:invite.token}); expect(a.member.state).toBe("admitted");
  const challenge = (await call("/api/v1/challenge",{})).data;
  expect((await call("/api/v1/login",{challengeId:challenge.id,event:finalizeEvent(challenge.event,generateSecretKey()),identityType:"temporary",invitation:invite.token})).response.status).toBe(403);
  expect(JSON.stringify(app.db.query("SELECT * FROM invitations").all())).not.toContain(invite.token);
});
test("builder details remain private; active previews admit participants; mutations require CSRF", async () => {
  const {a,b} = await setup(), d = await create(a), id = d.project.id;
  expect((await call(`/api/v1/projects/${id}`,undefined,b)).response.status).toBe(404);
  expect((await call(`/api/v1/projects/${id}/preview?revision=${d.project.current_revision}`,undefined,b)).response.status).toBe(200);
  expect((await call(`/api/v1/projects/${id}/share`,{revisionId:d.project.current_revision},b)).response.status).toBe(404);
  expect((await call(`/api/v1/projects/${id}/share`,{revisionId:d.project.current_revision},a,{"x-csrf-token":"wrong"})).response.status).toBe(403);
});
test("runnable starters have private SHA256 assets and restrictive preview sandbox", async () => {
  await setup(); const hashes = new Set();
  for (const starterId of ["website","cashu","nostr","spinner","dice","pong"]) {
    const account = await login(), d = await create(account,starterId), revision = d.revisions[0]; hashes.add(revision.source_hash);
    const preview = await call(`/api/v1/projects/${d.project.id}/preview?revision=${revision.id}`,undefined,account);
    expect(preview.response.status).toBe(200); expect(preview.data).toContain("<!doctype html>");
    if (starterId === "website") expect(preview.data).toContain("<h1>Hello world</h1>");
    expect(preview.response.headers.get("content-security-policy")).toContain("sandbox allow-scripts"); expect(preview.response.headers.get("content-security-policy")).toContain("connect-src https: wss:");
    expect((await call(`/objects/${revision.source_hash}`,undefined,account)).response.status).toBe(404);
  }
  expect(hashes.size).toBe(6);
});
test("immutable restore creates a new revision and rejects stale concurrent restores", async () => {
  const {a} = await setup(), d = await create(a), path = `/api/v1/projects/${d.project.id}/restore`, body = {revisionId:d.project.current_revision,expectedRevisionId:d.project.current_revision};
  const results = await Promise.all([call(path,body,a),call(path,body,a)]);
  expect(results.map(r=>r.response.status).sort()).toEqual([200,409]);
  const after = (await call(`/api/v1/projects/${d.project.id}`,undefined,a)).data;
  expect(after.revisions.length).toBe(2); expect(after.revisions[0].source_hash).toBe(d.revisions[0].source_hash); expect(after.revisions[0].restored_from).toBe(d.project.current_revision);
  expect(()=>app.db.run("UPDATE revisions SET source_hash='x' WHERE id=?",[d.project.current_revision])).toThrow("immutable revision");
});
test("activation moves only the durable head with stale and project scope protection while lineage remains immutable", async () => {
  const {a,b}=await setup(),d=await create(a),other=await create(b),id=d.project.id,v1=d.project.current_revision;
  const v2=app.workshop.addRevision(app.workshop.project(app.auth.member(a.member.pubkey),id),app.workshop.assets.put('<html><body>v2</body></html>'),a.member.pubkey);
  const v3=app.workshop.addRevision(app.workshop.project(app.auth.member(a.member.pubkey),id),app.workshop.assets.put('<html><body>v3</body></html>'),a.member.pubkey);
  await call(`/api/v1/projects/${id}/share`,{revisionId:v3},a);
  await call(`/api/v1/projects/${id}/consent`,{revisionId:v3,granted:true},a);
  expect((await call(`/api/v1/projects/${id}/activate`,{revisionId:other.project.current_revision,expectedRevisionId:v3},a)).response.status).toBe(404);
  expect((await call(`/api/v1/projects/${id}/activate`,{revisionId:v2,expectedRevisionId:v1},a)).response.status).toBe(409);
  const concurrent=await Promise.all([call(`/api/v1/projects/${id}/activate`,{revisionId:v2,expectedRevisionId:v3},a),call(`/api/v1/projects/${id}/activate`,{revisionId:v2,expectedRevisionId:v3},a)]);
  expect(concurrent.map(result=>result.response.status).sort()).toEqual([200,409]);
  const active=concurrent.find(result=>result.response.status===200)!.data;
  expect(active.project.current_revision).toBe(v2);expect(active.project.shared_revision).toBe(v3);expect(active.consent).toContainEqual({revision_id:v3,granted:1});
  expect(active.revisions.map((revision:any)=>[revision.id,revision.lineage_status])).toEqual([[v3,'abandoned'],[v2,'active'],[v1,'ancestor']]);
  expect((await call(`/api/v1/projects/${id}/preview?revision=${v3}`,undefined,a)).data).toContain('v3');
  expect(active.revisions).toHaveLength(3);expect(active.revisions.find((revision:any)=>revision.id===v3).parent_id).toBe(v2);
});
test("sharing pins exact revision, forks independent project/conversation, consent is separate", async () => {
  const {host,a,b} = await setup(), d = await create(a), id = d.project.id;
  await call(`/api/v1/projects/${id}/share`,{revisionId:d.project.current_revision},a);
  expect((await call("/api/v1/host/publication",undefined,host)).data.candidates.length).toBe(0);
  await call(`/api/v1/projects/${id}/consent`,{revisionId:d.project.current_revision,granted:true},a);
  expect((await call("/api/v1/host/publication",undefined,host)).data.candidates.length).toBe(1);
  const fork = (await call("/api/v1/projects",{forkProjectId:id,idempotencyKey:'shared-fork'},b)).data;
  expect(fork.project.id).not.toBe(id); expect(fork.project.conversation_id).not.toBe(d.project.conversation_id); expect(fork.project.origin_revision).toBe(d.project.current_revision); expect(fork.requests).toEqual([]);
  const restored = (await call(`/api/v1/projects/${id}/restore`,{revisionId:d.project.current_revision,expectedRevisionId:d.project.current_revision},a)).data;
  expect(restored.project.shared_revision).toBe(d.project.current_revision);
  await call(`/api/v1/projects/${id}/share`,{revisionId:null},a);
  expect((await call("/api/v1/host/publication",undefined,host)).data.candidates).toEqual([]);
  expect((await call(`/api/v1/projects/${fork.project.id}`,undefined,b)).data.project.current_revision).toBe(fork.project.current_revision);
});
test("ban is specific, hides apps/revokes consent, blocks requests; unban preserves other participants", async () => {
  const {host,a,b} = await setup(), d = await create(a), other = await create(b);
  await call(`/api/v1/projects/${d.project.id}/share`,{revisionId:d.project.current_revision},a);
  await call(`/api/v1/host/members/${a.member.pubkey}`,{state:"banned",allowance:20},host);
  expect((await call(`/api/v1/projects/${d.project.id}`,undefined,a)).response.status).toBe(403);
  expect((await call(`/api/v1/projects/${other.project.id}`,undefined,b)).response.status).toBe(200);
  await call(`/api/v1/host/members/${a.member.pubkey}`,{state:"admitted",allowance:20},host);
  expect((await call(`/api/v1/projects/${d.project.id}`,undefined,a)).data.project.hidden).toBe(1);
});
test("unavailable instructions persist idempotently without success or allowance charge; reload survives", async () => {
  const {a} = await setup(), d = await create(a), path = `/api/v1/projects/${d.project.id}/requests`, body = {requestId:crypto.randomUUID(),prompt:"  Make it blue\nKeep this spacing  ",expectedRevisionId:d.project.current_revision};
  expect((await call(path,body,a)).data.request.status).toBe("unavailable"); await call(path,body,a);
  expect((await call(path,{...body,prompt:"Different"},a)).response.status).toBe(409);
  expect((await call("/api/v1/me",undefined,a)).data.member.allowance).toBe(20);
  app.db.close(); app = application(config);
  const after = (await call(`/api/v1/projects/${d.project.id}`,undefined,a)).data;
  expect(after.requests.length).toBe(1); expect(after.requests[0].prompt).toBe(body.prompt); expect(after.project.current_revision).toBe(d.project.current_revision);
});
test("50 simultaneous gated submissions preserve exact private instructions and bounded records", async () => {
  const {a,b} = await setup(), first = await create(a), second = await create(b), start = performance.now();
  const results = await Promise.all(Array.from({length:50},(_,i)=>{const account = i%2?a:b, d = i%2?first:second;return call(`/api/v1/projects/${d.project.id}/requests`,{requestId:crypto.randomUUID(),prompt:`Instruction ${i}`,expectedRevisionId:d.project.current_revision},account);}));
  expect(results.every(r=>r.response.status===200 && r.data.request.status==="unavailable")).toBe(true);
  expect((await call(`/api/v1/projects/${first.project.id}`,undefined,a)).data.requests.length).toBe(25);
  console.log(`Gated submission representative measurement: 50 concurrent handler requests, ${(performance.now()-start).toFixed(1)}ms; no AI builders invoked`);
});
test("database rejects cross-project revision pointers and repeated logins have finite sessions", async()=>{
  const {a,b}=await setup(), first=await create(a), second=await create(b);
  expect(()=>app.db.run('UPDATE projects SET current_revision=? WHERE id=?',[second.project.current_revision,first.project.id])).toThrow();
  expect(()=>app.db.run('INSERT INTO consent(project_id,revision_id,author,granted,updated_at) VALUES(?,?,?,?,?)',[first.project.id,second.project.current_revision,a.member.pubkey,1,Date.now()])).toThrow('consent project mismatch');
  for(let i=0;i<9;i++) await login(a.secret);
  expect((app.db.query('SELECT COUNT(*) AS count FROM sessions WHERE pubkey=?').get(a.member.pubkey) as any).count).toBe(8);
  expect((await call('/api/v1/me',undefined,a)).response.status).toBe(401);
});

test('builder guidance is host-only, bounded, concurrent-save protected and durable; participant payload cannot inject it', async () => {
  const {host,a} = await setup();
  const path='/api/v1/host/builder-prompt';
  expect((await call(path,undefined,a)).response.status).toBe(403);
  expect((await call(path,{text:'Injected',expectedRevision:1},a)).response.status).toBe(403);
  expect((await call(path,undefined)).response.status).toBe(401);
  const initial=(await call(path,undefined,host)).data;
  expect(initial.prompt.text).toContain('NIP-5D');
  expect((await call(path,{text:' ',expectedRevision:1},host)).response.status).toBe(400);
  expect((await call(path,{text:'x'.repeat(16001),expectedRevision:1},host)).response.status).toBe(400);
  expect((await call(path,{text:'Useful saved guidance\n',expectedRevision:1},host,{'x-csrf-token':'bad'})).response.status).toBe(403);
  const results=await Promise.all(['First','Second'].map(text=>call(path,{text,expectedRevision:1},host)));
  expect(results.map(x=>x.response.status).sort()).toEqual([200,409]);
  const saved=(await call(path,undefined,host)).data.prompt;
  const d=await create(a);
  await call(`/api/v1/projects/${d.project.id}/requests`,{requestId:'snapshot',prompt:'Question?',expectedRevisionId:d.project.current_revision,builderPrompt:{revision:999,text:'Injected'}},a);
  expect(app.db.query('SELECT revision,text FROM request_builder_prompts WHERE request_id=?').get('snapshot')).toEqual({revision:2,text:saved.text});
  app.db.close(); app=application(config);
  expect((await call(path,undefined,host)).data.prompt).toEqual(saved);
  expect(()=>app.db.run('UPDATE request_builder_prompts SET text=? WHERE request_id=?',['tamper','snapshot'])).toThrow('immutable');
});

test('administrator messages use the ordinary owner fields while preserving scope, attribution and idempotency',async()=>{
 const {host,a,b}=await setup(),d=await create(a),id=d.project.id;
 const cfg={projectId:id,ownerPubkey:a.member.pubkey,conversationKey:d.project.conversation_id,directory:'/fixed',brokerUrl:'http://127.0.0.1:1',credentialFile:'/missing',origin:'https://autopilot.test',definitionId:'owner-definition',callbackUrl:origin+'/api/v1/pipeline/callback',appPubkey:'c'.repeat(64),approvedRequestId:''};
 config.followup=cfg;
 const body={requestId:'host-one',prompt:'Build the authorized app',expectedRevisionId:d.project.current_revision};
 expect((await call(`/api/v1/host/projects/${id}/requests`,body,b)).response.status).toBe(403);
 expect((await call(`/api/v1/projects/${id}/requests`,body,host)).response.status).toBe(404);
 expect((await call(`/api/v1/host/projects/${id}/requests`,{...body,operatorReason:'No reason field'},host)).response.status).toBe(400);
 const submitted=await call(`/api/v1/host/projects/${id}/requests`,body,host);
 expect(submitted.response.status).toBe(202);
 expect(submitted.data.hostSubmitted).toBe(true);
 const audit=app.db.query('SELECT * FROM host_request_audit WHERE request_id=?').get(body.requestId) as any;
 expect(audit.actor).toBe(host.member.pubkey);expect(audit.project_owner).toBe(a.member.pubkey);expect(audit.reason).toBe('administrator_message');
 expect((await call(`/api/v1/host/projects/${id}/requests`,body,host)).response.status).toBe(202);
 expect((await call(`/api/v1/host/projects/${id}/requests`,{...body,prompt:'different'},host)).response.status).toBe(409);
 expect(app.db.query('SELECT count(*) n FROM requests WHERE project_id=?').get(id)).toEqual({n:1});
 expect(app.workshop.detail(app.auth.member(a.member.pubkey),id).revisions).toHaveLength(1);
 expect(app.auth.member(a.member.pubkey).allowance).toBe(a.member.allowance);
 app.db.run("UPDATE requests SET status='succeeded' WHERE id=?",[body.requestId]);
 const ownBody={requestId:'original',prompt:'Original question',expectedRevisionId:d.project.current_revision};
 app.workshop.request(app.auth.member(a.member.pubkey),id,ownBody,false);
 expect((await call(`/api/v1/host/projects/${id}/requests`,ownBody,host)).response.status).toBe(409);
 const other=await create(b);
 const unavailable=await call(`/api/v1/host/projects/${other.project.id}/requests`,{...body,requestId:'other-project',expectedRevisionId:other.project.current_revision},host);
 expect(unavailable.response.status).toBe(200);expect(unavailable.data.generationAvailable).toBe(false);
 const detail=(await call(`/api/v1/projects/${id}`,undefined,host)).data;
 expect(detail.execution.definition).toBe('https://autopilot.test/pipelines/definitions/owner-definition');
});
test('owner rename persists metadata only and rejects foreign, unsafe and unscoped writes', async () => {
  const {host,a,b} = await setup(), d = await create(a,'dice'), id=d.project.id;
  await call(`/api/v1/projects/${id}/share`,{revisionId:d.project.current_revision},a);
  await call(`/api/v1/projects/${id}/consent`,{revisionId:d.project.current_revision,granted:true},a);
  const before=(await call(`/api/v1/projects/${id}`,undefined,a)).data;
  const path=`/api/v1/projects/${id}/rename`;
  expect((await call(path,{title:'Foreign'},b)).response.status).toBe(404);
  expect((await call(path,{title:'Admin rename'},host)).response.status).toBe(200);
  expect((await call(path,{title:'Wrong admin scope'},host,{'x-workshop-id':crypto.randomUUID()})).response.status).toBe(404);
  expect((await call(`/api/v1/projects/${id}/share`,{revisionId:null},host)).response.status).toBe(200);
  await call(`/api/v1/projects/${id}/share`,{revisionId:d.project.current_revision},a);
  await call(`/api/v1/projects/${id}/consent`,{revisionId:d.project.current_revision,granted:true},a);
  expect((await call(path,{title:'Wrong scope'},a,{'x-workshop-id':crypto.randomUUID()})).response.status).toBe(404);
  expect((await call(path,{title:'CSRF'},a,{'x-csrf-token':'wrong'})).response.status).toBe(403);
  expect((await call(path,{title:'Anonymous'})).response.status).toBe(401);
  for (const title of ['', '   ', 'a'.repeat(121), 42, null, 'Two\nlines', 'Nul\0title']) expect((await call(path,{title},a)).response.status).toBe(400);
  const title='<Game> & "friends"';
  expect((await call(path,{title:'  '+title+'  '},a)).data.project.title).toBe(title);
  expect(app.db.query('SELECT actor,project_owner,action FROM project_admin_audit WHERE project_id=? ORDER BY created_at LIMIT 1').get(id)).toEqual({actor:host.member.pubkey,project_owner:a.member.pubkey,action:'rename'});
  expect((await call('/api/v1/room',undefined,a)).data.projects[0].title).toBe(title);
  expect((await call('/api/v1/room',undefined,b)).data.gallery[0].title).toBe(title);
  const after=(await call(`/api/v1/projects/${id}`,undefined,a)).data;
  expect(after.project).toEqual({...before.project,title});
  for (const key of ['revisions','requests','consent','artifacts','builder']) expect(after[key]).toEqual(before[key]);
  expect((await call(path,{title:'a'.repeat(120)},a)).response.status).toBe(200);
  app.db.close(); app=application(config);
  expect((await call(`/api/v1/projects/${id}`,undefined,a)).data.project.title).toBe('a'.repeat(120));
  await call(`/api/v1/host/members/${a.member.pubkey}`,{state:'banned',allowance:20},host);
  expect((await call(path,{title:'Banned rename'},a)).response.status).toBe(403);
});
