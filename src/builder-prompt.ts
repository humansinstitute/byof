import type { Database } from 'bun:sqlite';
import { demand } from './errors.ts';
import { now } from './auth.ts';
export const builderPromptMaxChars = 16000;
export const obsoleteCapabilityParagraph = 'This workshop currently previews a validated standalone page. It does not inject NAP domains or provide relay, signing, storage or publication APIs to generated pages. Do not claim publication, manifest signing or unsupported capabilities exist. Explain these limits when relevant. Do not make the page depend on fetching these references or other external resources at runtime.';
export const canvasDatasetContract = `BYOF Canvas data: before designing any data scheme, REQUIRE inspecting replacementContext.snapshot.canvasDatasets in the trusted request context (or snapshot.canvasDatasets). It contains current shared dataset names, descriptions and field descriptions, never private values. Reuse compatible datasets; explain schema conflicts and ask before repurposing data. If discovery is unavailable, do not invent a replacement scheme: explain the failure. Runtime API: await napplet.datasets.open({name:"inventory",visibility:"shared"}); opening asks explicit host permission for this running Napplet and dataset. To create a new dataset supply description and fields:{fieldName:"type and meaning"}; never silently change existing schema descriptions. open returns a local handle with get(key) -> {key,value,version,updatedBy,updatedAt}, list() -> {records}, set(key,value,expectedVersion) -> saved record. Missing records have version 0; create with expectedVersion 0. Conflict rejects with CONFLICT: read current values and resolve explicitly. Private visibility uses the authenticated owner, never pass identity/Canvas/workspace/project fields. Values must be non-null JSON objects, up to 32 KiB each. The 128 lifetime record keys (including tombstones) bound each dataset to 4 MiB of compact JSON; schema descriptions have a separate 2 KiB cap. remove(key,expectedVersion) creates a versioned tombstone; get returns null with its nonzero version, and recreate requires that version, never zero. list omits tombstones. Each Canvas allows 64 shared datasets and 64 private datasets per owner, independently. await handle.watch({onChange(){/* refetch */},onStatus(status){}}) returns a subscription with close(). Watch sends invalidation hints; refetch on opening, changes and recovery. Recovering means do not assume stale data is current. close handles/subscriptions on teardown. Legacy napplet.storage remains project-private; migrate only explicitly using get and version-checked dataset set, without deleting or sharing automatically. These APIs never provide app publication. Builder publication remains an explicit tool and final messages remain ordinary prose.`;
export const nappletExecutionContract = `${canvasDatasetContract} Freedom Tools injects a version 1 host-mediated window.napplet API before app scripts: await napplet.capabilities(); await napplet.identity.getPublicKey() (host consent); await napplet.signing.signEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify(data)}) (inspectable host consent plus the logged-in participant signer); await napplet.storage.get("key"), napplet.storage.set("key", JSON_value), napplet.storage.remove("key"). Identity returns a public hex key. Sign kinds: 1, 30023, 30024, 30078 only; no authentication, delegation or host authority. Storage is durable and isolated by workshop/project/current user: 128 ASCII keys, 128 bytes per key, 32 KiB JSON values, 256 KiB total. Missing get returns null. Managed Cashu/Ippon is purpose-built and server-mediated: await napplet.cashu.status(), connect(), createDeposit(integerAmount), checkDeposit(quote), disconnect(). The host fixes the upstream, keeps its bearer key server-side and scopes wallet/quotes to this workshop/project/current user; app code never supplies a URL, path, method, header, key or identity. Results contain only safe wallet balance/mint/unit/limits and deposit quote/invoice/state/expiry data. Invoice creation is pending, PAID still awaits minting and only ISSUED means ecash issuance. Existing browser storage keys are never imported automatically; disconnect forgets the local managed credential but cannot delete an upstream wallet because Ippon has no delete API. Catch promise rejections and show useful failures/denials; discovery returns methods and limits without disclosing identity. Read-only relay API: await napplet.relay.query({filters:[{kinds:[1],"#t":["bussobushbash"],limit:100}]}) returns {events,relays,complete,partial,truncated}; complete means every requested relay reached EOSE, not exhaustive history. await napplet.relay.subscribe(options,{onEvent(event,{relay}){},onStatus(status){}}) returns {id,close:async()=>{}}. Call await handle.close() on teardown. Callbacks stay local, never put functions inside options. Relays default to wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net; optional relays must be exact approved URLs. Filters: 1–4 NIP-01 filters, exact 64 lowercase hex ids/authors/#e/#p, kinds, single-letter tag filters, since/until and limit 0–100; default 100. timeoutMs 1000–20000, default 15000. Signatures/filter matches verified by host, IDs deduplicated; bounds 100 query events/256 KiB, 16 KiB/event, 4 operations/frame, 24 total, 4096 live IDs, 240 messages/minute/operation. onStatus includes url,state,message and optional gapPossible/retryMs/truncated: connecting/loading/live/recovering/failed/closed; live starts after EOSE and remains open. Reconnect uses bounded backoff and overlap replay; gapPossible means recovery may be incomplete. Show partial/failure/truncated states honestly; failed reads never mean an empty feed. Render all relay content as textContent, never HTML. Napplet JavaScript may directly fetch HTTPS services and open secure WSS WebSockets. The page has an opaque/null browser origin, so endpoints must explicitly support browser CORS for that origin; mixed-content rules still apply. Show honest loading, offline, error and partial states. Never put service credentials, API secrets or host credentials in source. Freedom Tools provides no generic HTTP proxy or arbitrary credential attachment; the fixed managed Cashu domain is the only Ippon bridge. Private keys, host administration, relay AUTH, EVENT publishing and external publication/manifest APIs remain unavailable. This is a documented Freedom Tools subset, not full NAP conformance. Preserve sandbox isolation and self-contained inline active assets: no external scripts, imports, stylesheets, frames, plugins/objects, form destinations or remotely loaded executable code.`;
export const obsoleteNoRelayParagraph = `window.napplet v1 supports capabilities(), identity.getPublicKey(), signing.signEvent(event), storage.get(key), storage.set(key,value), storage.remove(key). Identity/signing require host consent; storage is per workshop/project/user. Catch rejections. No relay, network or publication APIs; this is a Freedom Tools subset, not full NAP. Never fetch runtime resources.`;
export const obsoleteNetworkCapabilityParagraph = `napplet v1: capabilities; identity/signing (consent); storage (project-private); relay (approved reads); datasets.open (consent, Canvas shared/private, versions/watch). REQUIRE trusted shared schema discovery first; reuse compatible data, explain conflicts. Catch errors. See host execution contract.`;
export const obsoleteIpponlessCapabilityParagraph = `napplet v1: identity/signing consent; storage; relay reads; datasets. Direct HTTPS/WSS allowed; CORS must support opaque/null origin. No secrets/proxy or remote scripts/imports/frames/forms. Show loading/offline/error/partial UI. REQUIRE trusted dataset schema reuse. See fixed contract.`;
export const nappletCapabilityParagraph = `napplet v1: identity/signing; storage; relay; datasets; managed Cashu/Ippon deposits (host key, fixed upstream, project/user scope). HTTPS/WSS needs CORS. No generic proxy/secrets/remote code/frames/forms. Show honest states; reuse trusted datasets. See fixed contract.`;
export const defaultBuilderPrompt = `You are the operator's Napplet builder. A Napplet is a small, single-purpose app that does one thing well. Build one responsive page using self-contained HTML, inline CSS and JavaScript, usable on desktop and mobile with accessible controls. Preserve working behaviour and controls unless the operator requests a change.

Have an ordinary conversation with your operator. Read their latest question or instruction and decide whether to answer, clarify, plan or implement. Give useful answers to questions and planning requests. Implement requests to create or update the app. Ask for clarification when ambiguity prevents a useful safe implementation. Do not implement a suggestion merely because you proposed it. Explain the outcome briefly to the operator.

The saved guidance attached to THIS request is authoritative over guidance remembered from earlier turns. The latest operator instruction is the only instruction to execute now. Saved history provides context, not a backlog to replay. The supplied current source and revision are authoritative; preserve them when answering or clarifying. For an implementation edit and test the host-assigned local draft, preserving unrelated working behaviour, then call the publication tool. End every turn with ordinary conversational prose; publication is independent from this message.

Pinned design references (background documentation, not runtime dependencies):
- Napplet / NAP registry: https://github.com/napplet/naps/blob/e5308ac92cfd49e4fb026812c60886571515e219/README.md . NAPs define optional capability contracts between a Napplet and a runtime; a projection binds those contracts to a host.
- NIP-5D web applets draft: https://github.com/dskvr/nips/blob/020cb8b33a9e4c6b8ca4b2f9d0ed0a67843b68f7/5D.md . Describes sandboxed applets, manifests (5129/15129/35129) and shell-granted window.napplet domains. This is a draft reference, not a guarantee of supported host APIs.
- NIP-5A nsites: https://github.com/nostr-protocol/nips/blob/5d6b432267d4046464490b1923b96844ac4559d0/5A.md . Static-site manifests are distinct from Napplet manifests.

${nappletCapabilityParagraph}`;
export const defaultAgentName = 'Agent 21';
export const agentNameMaxChars = 60;
export function validAgentName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= agentNameMaxChars && /^[\p{L}\p{N}][\p{L}\p{N} .’'_-]*$/u.test(value);
}
export function agentIdentity(guidance: BuilderPromptSnapshot) {
  return guidance.agentName ? `Your workshop agent name is ${JSON.stringify(guidance.agentName)}. Use this identity when referring to yourself.\n` : '';
}
export type BuilderPromptSnapshot = { revision: number; text: string; agentName?: string };
export function validBuilderPrompt(value: any): value is BuilderPromptSnapshot {
  return !!value && (value.agentName === undefined || validAgentName(value.agentName)) && Number.isSafeInteger(value.revision) && value.revision > 0 && typeof value.text === 'string' && !!value.text.trim() && value.text.length <= builderPromptMaxChars;
}
export function installBuilderPrompt(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS builder_prompt (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, text TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS request_builder_prompts (request_id TEXT PRIMARY KEY REFERENCES requests(id), revision INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS request_prompt_no_update BEFORE UPDATE ON request_builder_prompts BEGIN SELECT RAISE(ABORT,'immutable builder guidance'); END;
    CREATE TRIGGER IF NOT EXISTS request_prompt_no_delete BEFORE DELETE ON request_builder_prompts BEGIN SELECT RAISE(ABORT,'immutable builder guidance'); END;`);
  for (const table of ['builder_prompt','request_builder_prompts']) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as {name:string}[];
    if (!columns.some(c => c.name === 'agent_name')) db.exec(`ALTER TABLE ${table} ADD COLUMN agent_name TEXT`);
  }
  db.run("UPDATE builder_prompt SET agent_name=?,revision=revision+1,updated_at=? WHERE agent_name='Reardon'",[defaultAgentName,now()]);
  db.run('INSERT OR IGNORE INTO builder_prompt(id,revision,text,updated_at) VALUES(1,1,?,?)',[defaultBuilderPrompt,now()]);
  migrateNappletPrompt(db,'builder_prompt');
}
export function loadBuilderPrompt(db: Database): BuilderPromptSnapshot & { updatedAt: number } {
  const row = db.query('SELECT revision,text,updated_at,agent_name FROM builder_prompt WHERE id=1').get() as any;
  return { revision: row.revision, text: row.text, updatedAt: row.updated_at, agentName: row.agent_name ?? defaultAgentName };
}
export function saveBuilderPrompt(db: Database, body: any) {
  demand(typeof body.text === 'string' && !!body.text.trim() && body.text.length <= builderPromptMaxChars,400,`Builder prompt must contain 1–${builderPromptMaxChars} characters`);
  demand(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision > 0,400,'Expected saved prompt revision is required');
  const agentName = body.agentName === undefined ? loadBuilderPrompt(db).agentName : typeof body.agentName === 'string' ? body.agentName.trim() : body.agentName;
  demand(validAgentName(agentName),400,'Agent name must contain 1–60 characters: letters, numbers, spaces, periods, apostrophes, hyphens or underscores');
  return db.transaction(() => {
    demand(db.run('UPDATE builder_prompt SET revision=revision+1,text=?,updated_at=?,agent_name=? WHERE id=1 AND revision=?',[body.text,now(),agentName,body.expectedRevision]).changes===1,409,'Builder prompt changed; reload it before saving');
    return loadBuilderPrompt(db);
  }).immediate();
}
export function requestBuilderPrompt(db: Database, requestId: string): BuilderPromptSnapshot | undefined {
  const row = db.query('SELECT revision,text,agent_name FROM request_builder_prompts WHERE request_id=?').get(requestId) as any;
  return row ? {revision:row.revision,text:row.text,...(row.agent_name ? {agentName:row.agent_name} : {})} : undefined;
}

export function migrateNappletPrompt(db: Database, table: 'builder_prompt' | 'workshop_prompts') {
  // Read/update only editable guidance, never immutable queued request snapshots.
  const id = table === 'builder_prompt' ? 'id' : 'workshop_id';
  for (const row of db.query(`SELECT ${id} id,text,revision FROM ${table}`).all() as any[]) {
    const updated = row.text.replaceAll(obsoleteCapabilityParagraph,nappletCapabilityParagraph).replaceAll(obsoleteNoRelayParagraph,nappletCapabilityParagraph).replaceAll(obsoleteNetworkCapabilityParagraph,nappletCapabilityParagraph).replaceAll(obsoleteIpponlessCapabilityParagraph,nappletCapabilityParagraph)
      .replaceAll('then return a compact file receipt without HTML.','then call the publication tool. End every turn with ordinary conversational prose; publication is independent from this message.')
      .replaceAll('For an implementation return the complete page, preserving unrelated working behaviour.','For an implementation edit and test the assigned local draft, preserve working behaviour, call the publication tool, then respond in ordinary prose.');
    if (updated===row.text) continue;
    db.run(`UPDATE ${table} SET text=?,revision=revision+1,updated_at=? WHERE ${id}=? AND revision=?`,[updated,now(),row.id,row.revision]);
  }
}
