import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { application } from '../src/application.ts';
import { ipponBaseUrl } from '../src/ippon.ts';

type Account = { cookie: string; csrf: string };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(options: { timeoutMs?: number } = {}) {
  const directory = mkdtempSync(tmpdir() + '/ippon-capability-'); directories.push(directory);
  const ownerKey = generateSecretKey(), calls: { url: string; init: RequestInit }[] = [];
  let mode = 'ok', created = 0;
  const secret = 'server_only_secret_' + 'a'.repeat(40), invoice = 'lnbc1' + 'q'.repeat(40), quote = 'quote_abcdefgh';
  const wallet = (key = secret) => ({ name: 'Managed', access_key: key, mint: 'https://mint.minibits.cash/Bitcoin', unit: 'sat', balance: 0, pending_balance: 0, limits: null, unexpected: 'must not cross' });
  const upstream = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (mode === 'timeout') return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('includes ' + secret)), { once: true }));
    if (mode === 'non2xx') return new Response(JSON.stringify({ error: secret, authorization: 'Bearer ' + secret }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (mode === 'malformed') return new Response('{not-json', { headers: { 'content-type': 'application/json' } });
    if (mode === 'oversized') return new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
    const parsed = new URL(url), auth = new Headers(init.headers).get('authorization');
    if (parsed.pathname === '/v1/wallet' && init.method === 'POST') { created++; return Response.json(wallet(secret + created)); }
    if (auth !== `Bearer ${secret}1`) return Response.json({ error: secret }, { status: 401 });
    if (parsed.pathname === '/v1/wallet' && init.method === 'GET') return Response.json(wallet(secret + '1'));
    if (parsed.pathname === '/v1/wallet/deposit' && init.method === 'POST') return Response.json({ quote, request: invoice, state: 'UNPAID', expiry: null, access_key: secret, unexpected: { secret } });
    if (parsed.pathname === `/v1/wallet/deposit/${quote}` && init.method === 'GET') return Response.json({ quote, request: invoice, state: 'ISSUED', expiry: 123456, access_key: secret, unexpected: { secret } });
    return Response.json({ error: 'missing' }, { status: 404 });
  };
  const config={ dataDir: directory, origin: null, hostPubkey: getPublicKey(ownerKey), version: 'test', ipponBaseUrl: 'https://ippon.test' },fixtures={ ipponFetch: upstream, ipponTimeoutMs: options.timeoutMs };
  let app = application(config,fixtures);
  const origin = 'http://workshop.test';
  async function call(path: string, body?: any, account?: Account, scope?: string) {
    const response = await app.handle(new Request(origin + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie, 'x-csrf-token': account.csrf } : {}), ...(scope ? { 'x-workshop-id': scope } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const raw = await response.text(); return { status: response.status, raw, data: response.headers.get('content-type')?.includes('text/html') ? { documentId: raw.match(/documentId:\s*"([a-f0-9-]{36})"/)?.[1] } : JSON.parse(raw), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  async function login(key: Uint8Array) { const challenge = await call('challenge', {}), result = await call('login', { challengeId: challenge.data.id, event: finalizeEvent(challenge.data.event, key), identityType: 'extension' }); return { cookie: result.cookie, csrf: result.data.csrf }; }
  async function open(project: any, account: Account, scope?: string) { const preview = await call(`projects/${project.id}/preview?revision=${project.current_revision}`, undefined, account, scope); return call('napplet/open', { projectId: project.id, revisionId: project.current_revision, documentId: preview.data.documentId }, account, scope); }
  return { get app(){return app;}, call, login, open, ownerKey, calls, secret, invoice, quote, setMode: (value: string) => { mode = value; }, created: () => created, restart:()=>{app.db.close();app=application(config,fixtures);} };
}

test('managed Ippon flow fixes the upstream contract, strips secrets and persists one scoped wallet', async () => {
  const f = fixture();
  try {
    const account = await f.login(f.ownerKey), project = (await f.call('projects', { starterId: 'cashu' }, account)).data.project, token = (await f.open(project, account)).data.token;
    expect((await f.call('napplet/cashu', { token, method: 'status' }, account)).data).toEqual({ connected: false, state: 'none' });
    const connected = await f.call('napplet/cashu', { token, method: 'connect' }, account);
    expect(connected.status).toBe(200); expect(connected.raw).not.toContain(f.secret); expect(connected.data.wallet).toEqual({ name: 'Managed', mint: 'https://mint.minibits.cash/Bitcoin', unit: 'sat', balance: 0, pendingBalance: 0, limits: null });
    expect((await f.call('napplet/cashu', { token, method: 'connect' }, account)).status).toBe(200); expect(f.created()).toBe(1);
    const deposit = await f.call('napplet/cashu', { token, method: 'createDeposit', amount: 21 }, account);
    expect(deposit.data).toEqual({ quote: f.quote, invoice: f.invoice, state: 'UNPAID', expiry: null }); expect(deposit.raw).not.toContain(f.secret);
    const issued = await f.call('napplet/cashu', { token, method: 'checkDeposit', quote: f.quote }, account);
    expect(issued.data.state).toBe('ISSUED'); expect(issued.raw).not.toContain(f.secret);
    const status = await f.call('napplet/cashu', { token, method: 'status' }, account);
    expect(status.data.deposit).toEqual(issued.data); expect(status.raw).not.toContain(f.secret);
    f.restart();expect((await f.call('napplet/cashu',{token,method:'status'},account)).status).toBe(403);const reopened=(await f.open(project,account)).data.token,reloaded=await f.call('napplet/cashu',{token:reopened,method:'status'},account);expect(reloaded.data.connected).toBe(true);expect(reloaded.data.deposit).toEqual(issued.data);expect(f.created()).toBe(1);
    const saved = f.app.db.query('SELECT access_key FROM ippon_wallets').get() as any; expect(saved.access_key).toBe(f.secret + '1');
    for (const call of f.calls) {
      expect(new URL(call.url).origin).toBe('https://ippon.test');
      expect(['/v1/wallet', '/v1/wallet/deposit', `/v1/wallet/deposit/${f.quote}`]).toContain(new URL(call.url).pathname);
      const headers=new Headers(call.init.headers),headerNames:string[]=[];headers.forEach((_,name)=>headerNames.push(name));
      expect(headerNames.sort()).toEqual(call.init.method==='POST'?new URL(call.url).pathname==='/v1/wallet'?['accept','content-type']:['accept','authorization','content-type']:['accept','authorization']);
      expect(headers.get('authorization')).toBe(new URL(call.url).pathname==='/v1/wallet'&&call.init.method==='POST'?null:`Bearer ${f.secret}1`);
    }
    for(const file of ['public/napplet.d.ts','public/napplet-host.js','templates/napplet-client.js','src/starters.ts'])expect(await Bun.file(file).text()).not.toContain(f.secret);
    expect(await Bun.file('public/napplet-host.js').text()).not.toContain('ipponBaseUrl');
  } finally { f.app.db.close(); }
});

test('wallet and quote authority is isolated by participant, project, workshop and live document token', async () => {
  const f = fixture();
  try {
    const a = await f.login(f.ownerKey); f.app.db.run("UPDATE room SET admission='open' WHERE id=1"); const b = await f.login(generateSecretKey());
    const project = (await f.call('projects', { starterId: 'cashu' }, a)).data.project, token = (await f.open(project, a)).data.token;
    const forked = await f.call('projects', { forkProjectId: project.id, idempotencyKey: 'ippon-isolation' }, a), otherProject = forked.data.project ?? forked.data, otherProjectToken = (await f.open(otherProject, a)).data.token;
    await f.call('napplet/cashu', { token, method: 'connect' }, a); await f.call('napplet/cashu', { token, method: 'createDeposit', amount: 21 }, a);
    const otherUser = (await f.open(project, b)).data.token; expect((await f.call('napplet/cashu', { token: otherUser, method: 'status' }, b)).data).toEqual({ connected: false, state: 'none' });
    expect((await f.call('napplet/cashu', { token: otherProjectToken, method: 'status' }, a)).data).toEqual({ connected: false, state: 'none' });
    expect((await f.call('napplet/cashu', { token: otherProjectToken, method: 'checkDeposit', quote: f.quote }, a)).status).toBe(409);
    expect((await f.call('napplet/cashu', { token: 'forged', method: 'status' }, a)).status).toBe(403);
    const callsBeforeForgery=f.calls.length;expect((await f.call('napplet/cashu', { token, method: 'status', project: project.id, url: 'https://evil.test', path: '/admin', headers: { authorization: 'steal' } }, a)).status).toBe(400);expect(f.calls.length).toBe(callsBeforeForgery);
    const workshop = (await f.call('site/workshops', { title: 'Other' }, a)).data; expect((await f.call('napplet/cashu', { token, method: 'status' }, a, workshop.id)).status).toBe(403);
    const closed = (await f.open(project, a)).data.token; await f.call('napplet/data', { token: closed, method: 'close' }, a); expect((await f.call('napplet/cashu', { token: closed, method: 'status' }, a)).status).toBe(403);
    const expiring = (await f.open(project, a)).data.token, originalNow = Date.now; try { Date.now = () => originalNow() + 3_600_001; expect((await f.call('napplet/cashu', { token: expiring, method: 'status' }, a)).status).toBe(403); } finally { Date.now = originalNow; }
  } finally { f.app.db.close(); }
});

test('managed Ippon validates inputs and maps timeout, non-2xx, malformed and oversized responses without leaking bodies', async () => {
  const f = fixture({ timeoutMs: 5 });
  try {
    const account = await f.login(f.ownerKey), project = (await f.call('projects', { starterId: 'cashu' }, account)).data.project, token = (await f.open(project, account)).data.token;
    await f.call('napplet/cashu', { token, method: 'connect' }, account);
    const before = f.calls.length;
    for (const amount of [0, 1.5, 100001, '21']) expect((await f.call('napplet/cashu', { token, method: 'createDeposit', amount }, account)).status).toBe(400);
    expect((await f.call('napplet/cashu', { token, method: 'checkDeposit', quote: 'unknown_quote' }, account)).status).toBe(404); expect(f.calls.length).toBe(before);
    const logged:unknown[]=[],originalError=console.error;console.error=(...values:unknown[])=>{logged.push(values)};
    try { for (const [mode, status, message] of [['timeout', 504, 'timed out'], ['non2xx', 502, 'unavailable'], ['malformed', 502, 'malformed JSON'], ['oversized', 502, 'safe size limit']] as const) {
      f.setMode(mode); const result = await f.call('napplet/cashu', { token, method: 'status' }, account); expect(result.status).toBe(status); expect(result.data.error).toContain(message); expect(result.raw).not.toContain(f.secret);
    }} finally {console.error=originalError;}
    expect(JSON.stringify(logged)).not.toContain(f.secret);expect(logged).toEqual([]);
  } finally { f.app.db.close(); }
});

test('Ippon base URL accepts only a deployment-controlled HTTPS origin', () => {
  expect(ipponBaseUrl()).toBe('https://ippon.minibits.cash'); expect(ipponBaseUrl('https://ippon.example:8443')).toBe('https://ippon.example:8443');
  for (const value of ['http://ippon.example', 'https://user:pass@ippon.example', 'https://ippon.example/v1', 'https://ippon.example?next=x', 'not a url']) expect(() => ipponBaseUrl(value)).toThrow();
});
