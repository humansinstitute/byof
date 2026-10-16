import { test, expect, beforeEach, afterEach } from 'bun:test';
import { generateSecretKey, finalizeEvent } from 'nostr-tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { application } from '../src/application.ts';

const origin = 'https://workshop.test', alternate = 'http://localhost:41050';
let app: ReturnType<typeof application>, directory: string;
beforeEach(() => {
  directory = mkdtempSync('/tmp/freedom-origin-');
  app = application({ dataDir: directory, hostPubkey: null, origin, version: 'test' });
});
afterEach(() => { app.db.close(); rmSync(directory, { recursive: true, force: true }); });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(alternate + path, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}));

test('managed entry discovery publishes only configured origin, without a session or forwarded-host trust', async () => {
  const response = await app.handle(new Request(alternate + '/api/v1/browser-origin', { headers: {
    origin: 'null', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https',
  } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ origin });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(app.db.query('SELECT COUNT(*) n FROM challenges').get()).toEqual({ n: 0 });
});

test('null, foreign, local, and spoofed proxy origins cannot issue a challenge', async () => {
  for (const supplied of ['null', 'https://attacker.test', alternate, origin + '.attacker.test']) {
    expect((await post('/api/v1/challenge', {}, { origin: supplied, 'x-forwarded-host': 'workshop.test', 'x-forwarded-proto': 'https' })).status).toBe(403);
  }
  expect((await app.handle(new Request(origin + '/api/v1/challenge', { method: 'POST', body: '{}' }))).status).toBe(403);
  expect(app.db.query('SELECT COUNT(*) n FROM challenges').get()).toEqual({ n: 0 });
});

test('exact canonical challenge URL, single tags, one use, and CSRF remain required', async () => {
  const challenge = await (await post('/api/v1/challenge', {})).json();
  expect(challenge.event.tags[0]).toEqual(['u', origin + '/api/v1/login']);
  const secret = generateSecretKey();
  const body = { challengeId: challenge.id, identityType: 'extension', event: finalizeEvent(challenge.event, secret) };
  expect((await post('/api/v1/login', body, { origin: alternate })).status).toBe(403);
  for (const tags of [
    challenge.event.tags.map((tag: string[]) => tag[0] === 'u' ? ['u', alternate + '/api/v1/login'] : tag),
    [...challenge.event.tags, ['u', origin + '/api/v1/login']],
  ]) {
    expect((await post('/api/v1/login', { ...body, event: finalizeEvent({ ...challenge.event, tags }, secret) })).status).toBe(401);
  }
  const login = await post('/api/v1/login', body), session = await login.json();
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  expect(login.headers.get('set-cookie')).toContain('; Secure');
  expect((await post('/api/v1/login', body)).status).toBe(401);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await post('/api/v1/logout', {}, { cookie })).status).toBe(403);
  expect((await post('/api/v1/logout', {}, { cookie, 'x-csrf-token': session.csrf, origin: 'null' })).status).toBe(403);
  expect((await post('/api/v1/logout', {}, { cookie, 'x-csrf-token': session.csrf })).status).toBe(200);
});
