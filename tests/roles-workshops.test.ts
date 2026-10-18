import { test, expect, beforeEach, afterEach } from 'bun:test';
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { application } from '../src/application.ts';
import { Workshop } from '../src/workshop.ts';
import { storageBinding, installStorageTables, verifyForwarded } from '../src/storage.ts';
import { type Config } from '../src/config.ts';
const origin = 'https://workshop.test';
let app: ReturnType<typeof application>, dir: string, config: Config, secret: Uint8Array;
type Account = {
    cookie: string;
    csrf: string;
    member: any;
    secret: Uint8Array;
};
async function call(path: string, body?: any, a?: Account, scope = '', headers: Record<string, string> = {}) { const r = await app.handle(new Request(origin + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(a ? { cookie: a.cookie, 'x-csrf-token': a.csrf } : {}), ...(scope?{'x-workshop-id':scope}:{}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })); return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; }
async function login(key = generateSecretKey()): Promise<Account> { const c = (await call('challenge', {})).data, r = await app.handle(new Request(origin + '/api/v1/login', { method: 'POST', headers: { origin }, body: JSON.stringify({ challengeId: c.id, event: finalizeEvent(c.event, key), identityType: 'extension', name: 'Synthetic user' }) })); expect(r.status).toBe(200); const data = await r.json(); return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: data.csrf, member: data.member, secret: key }; }
async function setup() { const admin = await login(secret), owner = await login(), user = await login(); const w = (await call('site/workshops', { title: 'Workshop A', introduction: 'A', owner: owner.member.pubkey }, admin)).data; const other = (await call('site/workshops', { title: 'Workshop B', introduction: 'B' }, admin)).data; return { admin, owner, user, w, other }; }
const settings = { title: 'Workshop A', introduction: 'Owner introduction\nsecond line', pictures: ['https://images.example.com/workshop.jpg'], admission: 'open', paused: false, lightning: '' };
beforeEach(() => { dir = mkdtempSync('/tmp/freedom-roles-'); secret = generateSecretKey(); config = { dataDir: dir, hostPubkey: getPublicKey(secret), origin, version: 'test' }; app = application(config); });
afterEach(() => { app.db.close(); rmSync(dir, { recursive: true, force: true }); });
test('profiles are self-owned, exact identity, bounded, CSRF protected and survive reload without relay claims', async () => { const a = await login(), b = await login(); expect((await call('profile', undefined, a)).data.npub).toBe(nip19.npubEncode(a.member.pubkey)); const body = { name: 'Actual display name', picture: 'https://images.example.com/avatar.png', about: 'About me\nsecond line', pubkey: b.member.pubkey }; expect((await call('profile', body, a, '', { 'x-csrf-token': 'wrong' })).status).toBe(403); expect((await call('profile', body, a, '', { origin: 'https://evil.test' })).status).toBe(403); for (const picture of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'http://example.com/a.jpg', 'https://x.test/a.svg'])
    expect((await call('profile', { ...body, picture }, a)).status).toBe(400); const saved = (await call('profile', body, a)).data; expect(saved.pubkey).toBe(a.member.pubkey); expect(saved.storage).toBe('app-local'); expect((await call('profile', undefined, b)).data.name).toBe('Synthetic user'); app.db.close(); app = application(config); expect((await call('profile', undefined, a)).data).toEqual(saved); });
test('site admin bootstraps from config; workshop ownership cannot create workshops or manage Towers', async () => { const { admin, owner, user, w, other } = await setup(); expect((await call('site/towers', undefined, owner, w.id)).status).toBe(403); expect((await call('site/workshops', { title: 'Denied' }, owner, w.id)).status).toBe(403); expect((await call('site/towers', { label: 'Remote', origin: 'https://tower.example.com' }, user, w.id)).status).toBe(403); expect((await call('host/settings', settings, owner, w.id)).status).toBe(200); expect((await call('host/settings', settings, owner, other.id)).status).toBe(403); expect((await call('host/settings', settings, owner, w.id, { 'x-csrf-token': 'no' })).status).toBe(403); app.db.close(); app = application(config); expect((await call('room', undefined, owner, w.id)).data.room.pictures).toEqual(settings.pictures); expect((await call('room', undefined, owner, w.id)).data.room.introduction).toBe(settings.introduction); expect((await call('site/workshops', { title: 'Owner default', introduction: 'Hello' }, admin)).data.owner).toBe(admin.member.pubkey); });
test('membership, gallery, fork, private project, requests, previews, moderation and prompt snapshots stay in their workshop', async () => { const { admin, owner, user, w, other } = await setup(); await call('host/settings', settings, owner, w.id); await call('host/settings', { ...settings, title: 'B' }, admin, other.id); await call('workshops/join', {}, user, w.id); await call('workshops/join', {}, user, other.id); const a = (await call('projects', { starterId: 'spinner' }, user, w.id)).data, b = (await call('projects', { starterId: 'dice' }, user, other.id)).data; expect(a.project.workshop_id).toBe(w.id); expect(b.project.workshop_id).toBe(other.id); await call(`projects/${a.project.id}/share`, { revisionId: a.project.current_revision }, user, w.id); expect((await call('room', undefined, user, w.id)).data.gallery).toHaveLength(1); expect((await call('room', undefined, user, other.id)).data.gallery).toHaveLength(0); for (const who of [admin, owner, user]) {
    expect([403, 404]).toContain((await call(`projects/${a.project.id}`, undefined, who, other.id)).status);
    expect([403, 404]).toContain((await call(`projects/${a.project.id}/preview?revision=${a.project.current_revision}`, undefined, who, other.id)).status);
    expect([403, 404]).toContain((await call(`projects/${a.project.id}/requests`, { requestId: crypto.randomUUID(), prompt: 'wrong workshop', expectedRevisionId: a.project.current_revision }, who, other.id)).status);
} expect((await call('projects', { forkProjectId: a.project.id, idempotencyKey:'wrong-workshop' }, user, other.id)).status).toBe(404); expect((await call(`host/projects/${b.project.id}`, { hidden: true }, owner, w.id)).status).toBe(404); await call('host/builder-prompt', { text: 'Only workshop A', agentName: 'Ada', expectedRevision: 1 }, owner, w.id); const saved = await call(`projects/${a.project.id}/requests`, { requestId: 'scoped-request', prompt: 'Build it', expectedRevisionId: a.project.current_revision }, user, w.id); expect(saved.data.generationAvailable).toBe(false); expect(app.db.query('SELECT text,agent_name FROM request_builder_prompts WHERE request_id=?').get('scoped-request')).toEqual({ text: 'Only workshop A', agent_name: 'Ada' }); await call(`host/members/${user.member.pubkey}`, { state: 'banned', allowance: 0 }, owner, w.id); expect((await call(`projects/${a.project.id}`, undefined, user, w.id)).status).toBe(403); expect((await call(`projects/${b.project.id}`, undefined, user, other.id)).status).toBe(200); expect((await call(`host/requests/scoped-request/receipts`, undefined, admin, other.id)).status).toBe(404); expect(() => app.db.run('UPDATE projects SET workshop_id=? WHERE id=?', [other.id, a.project.id])).toThrow('immutable project workshop'); });
test('Tower registration is not readiness; selection actually gates storage routing and exact signed origin/actor', async () => { const admin = await login(secret); const registered = await call('site/towers', { label: 'Remote Tower', origin: 'https://remote-tower.example.com' }, admin); expect(registered.status).toBe(201); const t = registered.data.towers[0]; expect(t.status).toBe('registered'); expect(t.connected).toBe(false); const w = (await call('site/workshops', { title: 'Remote workshop', introduction: 'Remote', towerId: t.id }, admin)).data; const status = (await call('host/storage', undefined, admin, w.id)).data; expect(status.configured).toBe(false); expect(status.binding).toBe(null); expect(status.selectedTowerId).toBe(t.id); expect(status.activationRequirement).toContain('installation-wide storage worker'); expect((await call('host/storage/setup', { operation: 'bind' }, admin, w.id)).status).toBe(503); const e = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', 'https://remote-tower.example.com/api/v4/flightdeck-pg/workspaces'], ['method', 'GET']] }, secret); expect(() => verifyForwarded(e, admin.member.pubkey, 'https://other.example.com/api/v4/flightdeck-pg/workspaces', 'GET')).toThrow(); expect(() => verifyForwarded(e, 'f'.repeat(64), 'https://remote-tower.example.com/api/v4/flightdeck-pg/workspaces', 'GET')).toThrow(); const scope = new Workshop(app.db, app.workshop.assets, w.id); installStorageTables(scope); expect(storageBinding(scope)).toBe(null); expect(() => storageBinding(scope, { workshopId: app.site.legacy() } as any)).toThrow('workshop mismatch'); });
test('legacy migration preserves all original records, UUID, bindings, immutable revisions and scopes across repeated starts', async () => { const admin = await login(secret); await call('host/settings', { ...settings, admission: 'open' }, admin); const user = await login(), d = (await call('projects', { starterId: 'spinner' }, user)).data; await call(`projects/${d.project.id}/requests`, { requestId: 'legacy-request', prompt: 'Legacy instruction', expectedRevisionId: d.project.current_revision }, user); await call(`host/members/${user.member.pubkey}`, { state: 'banned', allowance: 11 }, admin); const id = app.site.legacy(), tables = ['members', 'projects', 'requests', 'revisions', 'consent', 'workshop_identity', 'request_builder_prompts', 'builder_epochs', 'storage_binding', 'local_builds']; const before = Object.fromEntries(tables.map(t => [t, app.db.query(`SELECT * FROM ${t}`).all()])); app.db.close(); app = application(config); expect(app.site.legacy()).toBe(id); for (const table of tables)
    expect(app.db.query(`SELECT * FROM ${table}`).all()).toEqual(before[table]); const room = (await call('room', undefined, admin)).data; expect(room.room.title).toBe(settings.title); expect((await call('me', undefined, user)).data.member.state).toBe('banned'); expect((await call(`projects/${d.project.id}`, undefined, admin)).data.requests[0].prompt).toBe('Legacy instruction'); });
test('pre-workshop SQLite schema migrates additively without changing legacy rows or storage authority', async () => {
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const { Database } = await import('bun:sqlite');
    const old = new Database(dir + '/workshop.sqlite');
    const legacy = crypto.randomUUID(), pubkey = getPublicKey(secret);
    old.exec(`CREATE TABLE room(id INTEGER PRIMARY KEY,title TEXT,introduction TEXT,lightning TEXT,paused INTEGER,admission TEXT);
 CREATE TABLE members(pubkey TEXT PRIMARY KEY,name TEXT,identity_type TEXT,state TEXT,allowance INTEGER,created_at INTEGER);
 CREATE TABLE invitations(hash TEXT PRIMARY KEY,remaining INTEGER,expires_at INTEGER);
 CREATE TABLE moderation(id TEXT PRIMARY KEY,actor TEXT,member TEXT,action TEXT,created_at INTEGER);
 CREATE TABLE workshop_identity(id INTEGER PRIMARY KEY,workshop_id TEXT UNIQUE);
 CREATE TABLE storage_binding(id INTEGER PRIMARY KEY,installation_id TEXT,workshop_id TEXT,target_json TEXT,local_root TEXT,status TEXT,probe_job_id TEXT,connected_actor TEXT,namespace_json TEXT);`);
    old.run('INSERT INTO room VALUES(1,?,?,?,?,?)', ['Legacy title', 'Legacy introduction', '', 1, 'invitation']);
    old.run('INSERT INTO members VALUES(?,?,?,?,?,?)', [pubkey, 'Legacy name', 'extension', 'banned', 7, 123]);
    old.run('INSERT INTO invitations VALUES(?,?,?)', ['old-hash', 4, 9999999999]);
    old.run('INSERT INTO moderation VALUES(?,?,?,?,?)', ['old-audit', pubkey, pubkey, 'banned', 123]);
    old.run('INSERT INTO workshop_identity VALUES(1,?)', [legacy]);
    const target = { towerUrl: 'https://legacy-tower.example.com', workspaceId: crypto.randomUUID(), workspaceOwnerNpub: nip19.npubEncode(pubkey), appNpub: nip19.npubEncode('f'.repeat(64)) };
    const binding = [1, 'legacy-install', legacy, JSON.stringify(target), '/fixed-legacy-root', 'ready', null, pubkey, '{"schema_name":"preserved"}'];
    old.run('INSERT INTO storage_binding VALUES(?,?,?,?,?,?,?,?,?)', binding);
    old.close();
    config.storage = { installationId: 'legacy-install', workshopId: legacy, towerOrigin: target.towerUrl, appNpub: target.appNpub, appPubkey: 'f'.repeat(64), localRoot: '/fixed-legacy-root', pipeline: {} as any };
    app = application(config);
    expect(app.site.legacy()).toBe(legacy);
    expect(app.db.query('SELECT state,allowance,name FROM members WHERE pubkey=?').get(pubkey)).toEqual({ state: 'banned', allowance: 7, name: 'Legacy name' });
    expect(app.db.query('SELECT * FROM room').get()).toEqual({ id: 1, title: 'Legacy title', introduction: 'Legacy introduction', lightning: '', support_label: 'Support this workshop', paused: 1, admission: 'invitation' });
    expect(app.db.query('SELECT workshop_id,remaining,initial_uses,status,code FROM invitations').get()).toEqual({workshop_id:legacy,remaining:4,initial_uses:4,status:'stopped',code:null});
    expect((app.db.query('SELECT * FROM moderation').get() as any).workshop_id).toBe(legacy);
    const after = app.db.query('SELECT * FROM storage_binding').get() as any;
    expect(after.target_json).toBe(binding[3]);
    expect(after.status).toBe('ready');
    expect(storageBinding(app.workshop, config.storage)?.target).toEqual(target);
});
test('separate provisioned storage uses the selected Tower and fences jobs from every other workshop', async () => {
    const admin = await login(secret), tower = (await call('site/towers', { label: 'Remote', origin: 'https://remote.example.com' }, admin)).data.towers[0];
    const a = (await call('site/workshops', { title: 'A', towerId: tower.id }, admin)).data, b = (await call('site/workshops', { title: 'B' }, admin)).data;
    const cfg = { workshopId: a.id, towerOrigin: tower.origin, installationId: 'synthetic-installed', localRoot: '/synthetic/root', appNpub: nip19.npubEncode('f'.repeat(64)), appPubkey: 'f'.repeat(64), pipeline: {} as any };
    config.workshopStorage = [cfg];
    expect(app.site.storage(a.id)).toBe(cfg);
    expect(app.site.storage(b.id)).toBeUndefined();
    const target = { towerUrl: tower.origin, workspaceId: crypto.randomUUID(), workspaceOwnerNpub: nip19.npubEncode(admin.member.pubkey), appNpub: cfg.appNpub };
    app.db.run('INSERT INTO workshop_storage_bindings(workshop_id,installation_id,target_json,local_root,status,connected_actor) VALUES(?,?,?,?,?,?)', [a.id, cfg.installationId, JSON.stringify(target), cfg.localRoot, 'ready', admin.member.pubkey]);
    const scope = new Workshop(app.db, app.workshop.assets, a.id), other = new Workshop(app.db, app.workshop.assets, b.id);
    const { createStorageJob, getStorageJob } = await import('../src/storage.ts');
    const job = createStorageJob(scope, 'probe', target, 'fixture.html', Buffer.from('<!doctype html>'));
    expect(getStorageJob(scope, cfg, job).target.towerUrl).toBe(tower.origin);
    expect(() => getStorageJob(other, { ...cfg, workshopId: b.id }, job)).toThrow('not found');
    expect((await call('host/storage', undefined, admin, a.id)).data.binding.status).toBe('ready');
    expect((await call('host/storage', undefined, admin, b.id)).data.binding).toBe(null);
    config.workshopStorage = [{ ...cfg, towerOrigin: 'https://wrong.example.com' }];
    expect(app.site.storage(a.id)).toBeUndefined();
});

test('registered Tower connect forwards only the exact actor/origin signature and never claims verified storage',async()=>{
 const admin=await login(secret),tower=(await call('site/towers',{label:'Signed Tower',origin:'https://signed-tower.example.com'},admin)).data.towers[0];
 const selected=(await call('site/workshops',{title:'Signed workshop',towerId:tower.id},admin)).data;config.workshopStorage=[...(config.workshopStorage||[]),{workshopId:selected.id,towerOrigin:tower.origin,installationId:'test',appNpub:nip19.npubEncode(getPublicKey(secret)),appPubkey:getPublicKey(secret),localRoot:dir,pipeline:{} as any}];
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',tower.origin+'/api/v4/flightdeck-pg/workspaces'],['method','GET']]},secret);
 const saved=globalThis.fetch,requests:any[]=[];
 try{globalThis.fetch=(async(input:any,options:any)=>{requests.push({url:String(input),authorization:options.headers.authorization,redirect:options.redirect});return Response.json({workspaces:[]});}) as typeof fetch;
 expect((await call('site/towers/'+tower.id+'/connect',{event:{...event,pubkey:'a'.repeat(64)}},admin,selected.id)).status).toBe(401);expect(requests).toHaveLength(0);
 const connected=await call('site/towers/'+tower.id+'/connect',{event},admin,selected.id);expect(connected.status).toBe(200);expect(connected.data.status).toBe('connected-unprobed');expect(requests).toEqual([{url:tower.origin+'/api/v4/flightdeck-pg/workspaces',authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),redirect:'error'}]);expect((await call('site/towers',undefined,admin)).data.towers[0].connected).toBe(true);expect((await call('site/towers',undefined,admin)).data.towers[0].status).toBe('registered');
 }finally{globalThis.fetch=saved;}
});

test('explicit empty/invalid/conflicting workshop selections fail and omitted legacy links remain valid',async()=>{
 const admin=await login(secret),d=(await call('projects',{starterId:'spinner'},admin)).data;
 expect((await call('projects/'+d.project.id,undefined,admin)).status).toBe(200);
 expect((await call('room',undefined,admin,'',{'x-workshop-id':''})).status).toBe(400);
 expect((await call('room?workshop=',undefined,admin)).status).toBe(400);
 expect((await call('room?workshop=wrong',undefined,admin)).status).toBe(400);
 expect((await call('room?workshop='+crypto.randomUUID(),undefined,admin,app.site.legacy())).status).toBe(400);
 expect(()=>app.site.selection(new Request(origin+'/api/v1/events?workshop='))).toThrow('valid workshop UUID');
});

test('same-destination storage internal routes, callbacks and namespace receipts resolve the durable workshop instead of caller scope',async()=>{
 const {createStorageJob,getStorageJob}=await import('../src/storage.ts'),{sha256}=await import('../src/assets.ts');
 const admin=await login(secret),tower=(await call('site/towers',{label:'Shared destination',origin:'https://same-tower.example.com'},admin)).data.towers[0];
 const a=(await call('site/workshops',{title:'A',towerId:tower.id},admin)).data,b=(await call('site/workshops',{title:'B',towerId:tower.id},admin)).data;
 const appKey=generateSecretKey(),callbackKey=generateSecretKey();config.callbackSignerPubkey=getPublicKey(callbackKey);
 const base={towerOrigin:tower.origin,localRoot:'/synthetic/root',appPubkey:getPublicKey(appKey),appNpub:nip19.npubEncode(getPublicKey(appKey)),pipeline:{} as any};
 const cfgA={...base,workshopId:a.id,installationId:'installation-A'},cfgB={...base,workshopId:b.id,installationId:'installation-B'};config.workshopStorage=[cfgA,cfgB];
 const target={towerUrl:tower.origin,workspaceId:crypto.randomUUID(),workspaceOwnerNpub:nip19.npubEncode(admin.member.pubkey),appNpub:base.appNpub};
 const scopeA=new Workshop(app.db,app.workshop.assets,a.id),scopeB=new Workshop(app.db,app.workshop.assets,b.id);
 const bytes=Buffer.from('<!doctype html><html><body>Probe</body></html>');
 const probeA=createStorageJob(scopeA,'probe',target,'probe-A.html',bytes),probeB=createStorageJob(scopeB,'probe',target,'probe-B.html',bytes);
 const artifact={objectId:crypto.randomUUID(),workspaceId:target.workspaceId,towerUrl:target.towerUrl,contentUrl:'',sha256:sha256(bytes),sizeBytes:bytes.length,isPublic:false};artifact.contentUrl=target.towerUrl+'/api/v4/storage/'+artifact.objectId+'/content';
 for(const [cfg,probe]of [[cfgA,probeA],[cfgB,probeB]] as const){app.db.run('INSERT INTO workshop_storage_bindings(workshop_id,installation_id,target_json,local_root,status,probe_job_id,connected_actor) VALUES(?,?,?,?,?,?,?)',[cfg.workshopId,cfg.installationId,JSON.stringify(target),cfg.localRoot,'probing',probe,admin.member.pubkey]);app.db.run("UPDATE storage_jobs SET status='verified',artifact_json=?,run_id=? WHERE id=?",[JSON.stringify(artifact),'run-'+probe,probe]);}
 const jobUrl=origin+'/api/v1/internal/storage/jobs/'+probeA;
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',jobUrl],['method','GET']]},appKey);
 const internal=await app.handle(new Request(jobUrl,{headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),'x-workshop-id':b.id}}));expect(internal.status).toBe(200);const resolved=await internal.json();expect(resolved.workshopId).toBe(a.id);expect(resolved.installationId).toBe(cfgA.installationId);expect(()=>getStorageJob(scopeB,cfgB,probeA)).toThrow('not found');
 async function callback(runId:string){const envelope={runId,deliveryId:crypto.randomUUID(),status:'ok',terminal:true,error:null,result:{jobId:probeA,action:'storage_ready',remoteStorage:artifact}},raw=JSON.stringify(envelope),url=origin+'/api/v1/storage/callback';const signed=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',sha256(raw)],['run',runId],['delivery',envelope.deliveryId],['attempt','1']]},callbackKey);return app.handle(new Request(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(signed)).toString('base64'),'x-wingman-run-id':runId,'x-wingman-delivery-id':envelope.deliveryId,'x-workshop-id':b.id},body:raw}));}
 expect((await callback('run-'+probeB)).status).toBe(403);expect((await callback('run-'+probeA)).status).toBe(200);
 expect(storageBinding(scopeA,cfgA)?.status).toBe('ready');expect(storageBinding(scopeB,cfgB)?.status).toBe('probing');
 const pa=(await call('projects',{starterId:'spinner'},admin,a.id)).data.project,pb=(await call('projects',{starterId:'dice'},admin,b.id)).data.project;
 const candidate=(p:any)=>({nativeReceipt:{projectId:p.id},version:1});
 for(const [scope,p]of [[scopeA,pa],[scopeB,pb]] as const){const id=createStorageJob(scope,'build',target,'version.html',bytes,candidate(p));app.db.run("UPDATE storage_jobs SET object_id=?,artifact_json=?,status='verified' WHERE id=?",[crypto.randomUUID(),JSON.stringify(artifact),id]);app.db.run('INSERT INTO remote_versions VALUES(?,?,?)',[p.current_revision,id,JSON.stringify(artifact)]);}
 app.db.run("UPDATE workshop_storage_bindings SET status='ready' WHERE workshop_id=?",[b.id]);const requestId=crypto.randomUUID();app.db.run("INSERT INTO requests(id,project_id,prompt,expected_revision,status,run_id,created_at) VALUES(?,?,?,?,?,?,?)",[requestId,pa.id,'Synthetic',pa.current_revision,'building','native-run-A',1]);
 const crossed={requestId,projectId:pb.id,candidate:{action:'build_completed',nativeReceipt:{requestId,projectId:pa.id,invocationRunId:'native-run-A'}}},rawCrossed=JSON.stringify(crossed),candidateUrl=origin+'/api/v1/internal/storage/candidates';const candidateEvent=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',candidateUrl],['method','POST'],['payload',sha256(rawCrossed)]]},appKey);
 const denied=await app.handle(new Request(candidateUrl,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(candidateEvent)).toString('base64'),'x-workshop-id':a.id},body:rawCrossed}));expect(denied.status).toBe(403);
 const namespace=createStorageJob(scopeA,'namespace',target,'namespace',new Uint8Array());const receipts=getStorageJob(scopeA,cfgA,namespace).namespaceReceipts;expect(receipts).toHaveLength(1);expect(receipts[0].project_id).toBe(pa.id);
});
test('signed profile imports are self-owned, validated and monotonic; known owner choices require site admin',async()=>{
 const admin=await login(secret),a=await login(),b=await login();
 const signed=(key:Uint8Array,name:string,created_at=Math.floor(Date.now()/1000)-2)=>finalizeEvent({kind:0,created_at,tags:[],content:JSON.stringify({display_name:name,picture:'https://images.example.com/avatar.png',about:'Relay bio'})},key);
 const valid=signed(a.secret,'Relay Alice');
 expect((await call('profile/nostr',{event:signed(b.secret,'Wrong')},a)).status).toBe(400);
 expect((await call('profile/nostr',{event:{...valid,content:'{}'}},a)).status).toBe(400);
 expect((await call('profile/nostr',{event:valid},a,'',{'x-csrf-token':'wrong'})).status).toBe(403);
 expect((await call('profile/nostr',{event:valid},a)).data.event.id).toBe(valid.id);
 expect((await call('profile/nostr',{event:signed(a.secret,'Old',valid.created_at-10)},a)).data.event.id).toBe(valid.id);
 expect((await call('me',undefined,a)).data.member.name).toBe('Relay Alice');
 expect((await call('site/people',undefined,a)).status).toBe(403);
 const known=(await call('site/people',undefined,admin)).data.people;expect(known.find((p:any)=>p.pubkey===a.member.pubkey).event.id).toBe(valid.id);
 expect(known.find((p:any)=>p.pubkey===b.member.pubkey).event).toBeNull();
});

test('Site Admin system prompts retain primary and existing workshop scopes, revision fencing, queued snapshots and project guidance refresh',async()=>{
 const {requestBuilderPrompt}=await import('../src/builder-prompt.ts'),{readFileSync,realpathSync}=await import('node:fs');
 const {admin,owner,w}=await setup(),legacy=app.site.legacy();
 expect((await call('site/builder-prompt',undefined,owner,w.id)).status).toBe(403);
 const initial=(await call('site/builder-prompt',undefined,admin,legacy)).data;expect(initial.scope).toBe('site');expect(initial.workshopId).toBe(legacy);
 const perWorkshop=(await call('site/builder-prompt',undefined,admin,w.id)).data;expect(perWorkshop.scope).toBe('workshop');
 const p=app.workshop.create(app.auth.member(admin.member.pubkey),'spinner').project;
 config.followup={ownerPubkey:p.owner,projectId:p.id,conversationKey:p.conversation_id,builderRoot:realpathSync(dir)+'/napplets',workshopId:legacy,fileVersions:true} as any;
 const requestId=crypto.randomUUID();app.workshop.request(app.auth.member(p.owner),p.id,{requestId,prompt:'Saved request',expectedRevisionId:p.current_revision},false);
 const snapshot=requestBuilderPrompt(app.db,requestId);
 const body={agentName:'Prompt editor agent',text:'Saved site instruction',expectedRevision:initial.prompt.revision};
 expect((await call('site/builder-prompt',body,admin,legacy,{'x-csrf-token':'bad'})).status).toBe(403);
 const saved=await call('site/builder-prompt',body,admin,legacy);expect(saved.status).toBe(200);expect(saved.data.prompt.text).toBe(body.text);expect(saved.data.prompt.agentName).toBe(body.agentName);
 expect((await call('site/builder-prompt',body,admin,legacy)).status).toBe(409);
 expect((await call('site/builder-prompt',undefined,admin,w.id)).data.prompt).toEqual(perWorkshop.prompt);expect(requestBuilderPrompt(app.db,requestId)).toEqual(snapshot);
 expect(readFileSync(dir+'/napplets/'+legacy+'/'+p.id+'/AGENTS.md','utf8')).toContain(body.text);
 const localBody={...body,text:'Existing additional workshop instruction',expectedRevision:perWorkshop.prompt.revision};
 expect((await call('site/builder-prompt',localBody,admin,w.id)).status).toBe(200);expect((await call('site/builder-prompt',undefined,admin,legacy)).data.prompt).toEqual(saved.data.prompt);
 app.db.close();app=application(config);expect((await call('site/builder-prompt',undefined,admin,legacy)).data.prompt).toEqual(saved.data.prompt);
});

test('metadata rename stays inside an existing workshop even for an owner in both',async()=>{
 const admin=await login(secret);
 const first=(await call('site/workshops',{title:'First rename workshop'},admin)).data;
 const second=(await call('site/workshops',{title:'Second rename workshop'},admin)).data;
 const d=(await call('projects',{starterId:'dice'},admin,first.id)).data;
 const path=`projects/${d.project.id}/rename`;
 expect((await call(path,{title:'Wrong workshop'},admin,second.id)).status).toBe(404);
 expect((await call(path,{title:'Scoped title'},admin,first.id)).status).toBe(200);
 expect((await call('room',undefined,admin,first.id)).data.projects[0].title).toBe('Scoped title');
 expect((await call('room',undefined,admin,second.id)).data.projects).toEqual([]);
 expect((await call(`projects/${d.project.id}`,undefined,admin,first.id)).data.revisions).toHaveLength(1);
});


test('Napplet settings allow scoped administrators without transferring ownership or public consent', async () => {
 const {admin,owner,user,w,other}=await setup();
 await call('host/settings',settings,owner,w.id);await call('workshops/join',{},user,w.id);
 const d=(await call('projects',{starterId:'dice'},user,w.id)).data,id=d.project.id,path=`projects/${id}/rename`;
 expect((await call(path,{title:'Workshop owner managed'},owner,w.id)).status).toBe(200);
 expect((await call(path,{title:'Participant rename'},user,w.id)).status).toBe(200);
 expect((await call(path,{title:'Admin rename'},admin,w.id)).status).toBe(200);
 expect((await call(path,{title:'Cross workshop'},admin,other.id)).status).toBe(404);
 expect((await call(path,{title:'CSRF'},admin,w.id,{'x-csrf-token':'wrong'})).status).toBe(403);
 expect((await call(`projects/${id}/restore`,{revisionId:d.project.current_revision,expectedRevisionId:d.project.current_revision},admin,w.id)).status).toBe(200);
 expect((await call(`projects/${id}/consent`,{revisionId:d.project.current_revision,granted:true},admin,w.id)).status).toBe(404);
 const after=(await call(`projects/${id}`,undefined,admin,w.id)).data;
 expect(after.project).toMatchObject({id,owner:user.member.pubkey,title:'Admin rename'});
 expect(after.project.owner).toBe(user.member.pubkey);expect(after.revisions).toHaveLength(d.revisions.length+1);
 for(const key of ['requests','consent','artifacts','builder'])expect(after[key]).toEqual(d[key]);
 expect(app.db.query('SELECT count(*) n FROM project_admin_audit WHERE project_id=?').get(id)).toEqual({n:3});
});

test('member forks stay independent while workshop and site administrators can view and edit them in scope',async()=>{
 const {admin,owner,user,w,other}=await setup(),forker=await login(),pending=await login();
 await call('host/settings',settings,owner,w.id);
 for(const account of [user,forker])await call('workshops/join',{},account,w.id);
 const source=(await call('projects',{starterId:'dice'},user,w.id)).data;
 const fork=(await call('projects',{forkProjectId:source.project.id,idempotencyKey:'participant-fork'},forker,w.id)).data;
 expect(fork.project).toMatchObject({owner:forker.member.pubkey,origin_project:source.project.id,origin_revision:source.project.current_revision});
 expect(fork.project.conversation_id).not.toBe(source.project.conversation_id);expect(fork.requests).toEqual([]);
 expect((await call(`projects/${fork.project.id}/requests`,{requestId:'participant-first-edit',prompt:'Change only my fork',expectedRevisionId:fork.project.current_revision},forker,w.id)).status).toBe(200);
 expect((await call(`projects/${source.project.id}`,undefined,user,w.id)).data.requests).toEqual([]);
 expect((await call(`projects/${fork.project.id}`,undefined,user,w.id)).status).toBe(404);

 expect(app.db.query('SELECT * FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(w.id,owner.member.pubkey)).toBeNull();
 const hostFork=(await call('projects',{forkProjectId:source.project.id,idempotencyKey:'owner-fork'},owner,w.id)).data;
 expect(app.db.query('SELECT * FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(w.id,owner.member.pubkey)).toBeNull();
 expect((await call(`projects/${hostFork.project.id}/requests`,{requestId:'owner-first-edit',prompt:'Change my fork',expectedRevisionId:hostFork.project.current_revision},owner,w.id)).status).toBe(200);
 expect(app.db.query('SELECT * FROM workshop_members WHERE workshop_id=? AND pubkey=?').get(w.id,owner.member.pubkey)).toBeNull();

 for(const administrator of [owner,admin]){
   const room=(await call('room',undefined,administrator,w.id)).data;
   expect(room.board.napplets.map((p:any)=>p.id)).toContain(fork.project.id);
   const opened=(await call(`projects/${fork.project.id}/edit`,undefined,administrator,w.id));expect(opened.status).toBe(200);expect(opened.data.permissions).toMatchObject({edit:true,consent:false,administrative:true});
 }
 expect((await call(`projects/${fork.project.id}/rename`,{title:'Owner managed participant fork'},owner,w.id)).status).toBe(200);
 expect((await call(`projects/${fork.project.id}/rename`,{title:'Site admin managed participant fork'},admin,w.id)).status).toBe(200);
 const scoped=new Workshop(app.db,app.workshop.assets,w.id),latest=scoped.addRevision(app.db.query('SELECT * FROM projects WHERE id=?').get(fork.project.id),app.workshop.assets.put('<!doctype html><html><body>Admin activation fixture</body></html>'),forker.member.pubkey);
 expect((await call(`projects/${fork.project.id}/activate`,{revisionId:fork.project.current_revision,expectedRevisionId:latest},admin,w.id)).status).toBe(200);
 expect((await call(`projects/${fork.project.id}/share`,{revisionId:fork.project.current_revision},owner,w.id)).status).toBe(200);
 expect((await call(`projects/${fork.project.id}/consent`,{revisionId:fork.project.current_revision,granted:true},owner,w.id)).status).toBe(404);
 expect((await call(`projects/${fork.project.id}`,undefined,forker,w.id)).data.project.owner).toBe(forker.member.pubkey);
 expect((app.db.query('SELECT action FROM project_admin_audit WHERE project_id=?').all(fork.project.id) as any[]).map(row=>row.action)).toEqual(expect.arrayContaining(['rename','activate','share']));

 config.followup={projectId:fork.project.id,ownerPubkey:forker.member.pubkey,conversationKey:fork.project.conversation_id,directory:'/fixed',builderRoot:dir+'/napplets',fileVersions:true,replacementEnabled:true,brokerUrl:'http://127.0.0.1:1',credentialFile:'/missing',origin:'https://autopilot.test',definitionId:'fork-admin-test',callbackUrl:origin+'/api/v1/pipeline/callback',appPubkey:'c'.repeat(64),approvedRequestId:''};
 for(const [administrator,requestId] of [[owner,'owner-admin-edit'],[admin,'site-admin-edit']] as const){
   const response=await call(`host/projects/${fork.project.id}/requests`,{requestId,prompt:'Audited administrator change',operatorReason:'Administrator support requested',expectedRevisionId:fork.project.current_revision},administrator,w.id);
   expect(response.status).toBe(202);expect(response.data.hostSubmitted).toBe(true);
   expect(app.db.query('SELECT actor,project_owner FROM host_request_audit WHERE request_id=?').get(requestId)).toEqual({actor:administrator.member.pubkey,project_owner:forker.member.pubkey});
   app.db.run("UPDATE requests SET status='succeeded' WHERE id=?",[requestId]);
 }

 expect((await call('projects',{forkProjectId:source.project.id,idempotencyKey:'pending-denied'},pending,w.id)).status).toBe(403);
 await call(`host/members/${forker.member.pubkey}`,{state:'banned',allowance:0},owner,w.id);
 expect((await call('projects',{forkProjectId:source.project.id,idempotencyKey:'banned-denied'},forker,w.id)).status).toBe(403);
 await call(`host/projects/${source.project.id}`,{hidden:true},owner,w.id);
 const admitted=await login();await call('workshops/join',{},admitted,w.id);
 expect((await call('projects',{forkProjectId:source.project.id,idempotencyKey:'hidden-denied'},admitted,w.id)).status).toBe(404);
 expect([403,404]).toContain((await call('projects',{forkProjectId:source.project.id,idempotencyKey:'cross-denied'},admitted,other.id)).status);
 expect((await call(`projects/${source.project.id}/edit`,undefined,admin,other.id)).status).toBe(404);
 expect((await call(`projects/${source.project.id}/edit`,undefined,admin,w.id)).status).toBe(200);
});

test('workshop list includes only admitted memberships and owned workshops; administrators see every workshop', async () => {
    const { admin, owner, user, w, other } = await setup();
    const ids = async (account: Account) => (await call('workshops', undefined, account)).data.workshops.map((row: any) => row.id);
    expect(await ids(user)).toEqual([]);
    expect(await ids(owner)).toEqual([w.id]);
    expect(await ids(admin)).toContain(w.id);
    expect(await ids(admin)).toContain(other.id);
    // Approval requests do not confer admitted access.
    await call('workshops/join', {}, user, w.id);
    expect(await ids(user)).toEqual([]);
    await call(`host/members/${user.member.pubkey}`, { state: 'admitted', allowance: 20 }, owner, w.id);
    expect(await ids(user)).toEqual([w.id]);
    await call('host/settings', { ...settings, admission: 'open' }, admin);
    await call('workshops/join', {}, user);
    expect(await ids(user)).toContain(app.site.legacy());
    await call(`host/members/${user.member.pubkey}`, { state: 'banned', allowance: 0 }, owner, w.id);
    expect(await ids(user)).not.toContain(w.id);
    expect((await call('room', undefined, user, other.id)).status).toBe(200);
    expect((await call('room', undefined, user, other.id)).data.member.state).toBe('not-joined');
});
