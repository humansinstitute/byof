// Install the pinned official client into the ignored evidence directory first.
// This test creates only a disposable client identity; it never opens the service key.
import { openPersistentSession } from '../tmp/docs/handoffs/cordn-client/node_modules/@cordn/cli/dist/lib/index.js';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

process.umask(0o077);
const root = resolve(import.meta.dirname, '..');
const evidenceRoot = resolve(root, 'tmp/docs/handoffs');
const ignored = spawnSync('git', ['check-ignore', evidenceRoot], { cwd: root });
assert.equal(ignored.status, 0, 'Evidence must be ignored');
const identityCommand = () => {
  const r = spawnSync('bun', ['scripts/cordn.ts', 'identity'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, 'Public identity validation failed');
  return JSON.parse(r.stdout);
};
const identity = identityCommand();
const testRoot = resolve(evidenceRoot, `cordn-smoke-${Date.now()}`);
mkdirSync(testRoot, { mode: 0o700 });
const stateFile = resolve(testRoot, 'sender.json');
const options = { serverPubkey: identity.pubkey, relays: identity.relays, transportEncryption: 'required' };
const deadline = setTimeout(() => { console.error('Cordn smoke test timed out'); process.exit(1); }, 180_000);
const content = `Cordn persistence verification ${new Date().toISOString()}`;
let sender;
let receiver;
try {
  sender = await openPersistentSession({ ...options, stateFile });
  console.error('Client opened');
  await sender.session.generateKeyPackage('smoke');
  await sender.session.publishKeyPackage('smoke');
  console.error('KeyPackage published over relays');
  await sender.session.createGroup('smoke', { keyPackageAlias: 'smoke' });
  await sender.persist();
  // Both receiver snapshots predate the message. Neither has cached plaintext or a fetched cursor.
  for (const stage of ['before', 'after']) {
    for (const suffix of ['', '.key']) {
      const destination = resolve(testRoot, `${stage}.json${suffix}`);
      copyFileSync(`${stateFile}${suffix}`, destination); chmodSync(destination, 0o600);
    }
  }
  const posted = await sender.session.sendMessage('smoke', content);
  console.error('Message posted');
  await sender.close(); sender = undefined;
  const results = [];
  for (const stage of ['before', 'after']) {
    if (stage === 'after') {
      const restart = spawnSync('bun', ['scripts/cordn.ts', 'restart'], { cwd: root, encoding: 'utf8' });
      assert.equal(restart.status, 0, 'Scoped restart failed');
      assert.equal(identityCommand().pubkey, identity.pubkey);
      const started = spawnSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', 'freedomtools-cordn-coordinator'], { encoding: 'utf8' });
      assert.equal(started.status, 0);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const logs = spawnSync('docker', ['logs', '--since', started.stdout.trim(), 'freedomtools-cordn-coordinator'], { encoding: 'utf8' });
        if ((logs.stdout + logs.stderr).includes('Connected to Nostr relays')) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.ok(ready, 'Coordinator must reconnect before fetching');
    }
    receiver = await openPersistentSession({ ...options, stateFile: resolve(testRoot, `${stage}.json`) });
    const received = await receiver.session.syncGroup('smoke');
    console.error(`Fetched ${stage} restart`);
    const match = received.find(message => message.id === posted.id && message.content === content);
    assert.ok(match, `${stage}: message must be fetched and decrypted from coordinator`);
    assert.equal(match.cursor, posted.cursor);
    results.push({ stage, messageId: match.id, cursor: match.cursor, contentMatched: true });
    await receiver.close(); receiver = undefined;
  }
  const relayChecks = [];
  for (const relay of identity.relays) {
    receiver = await openPersistentSession({ ...options, relays: [relay], stateFile });
    const available = await receiver.session.listAvailableKeyPackages();
    assert.ok(available.length > 0, 'Published KeyPackages must be reachable through each relay');
    relayChecks.push({ relay, keyPackageFetch: true });
    await receiver.close(); receiver = undefined;
    console.error(`Verified relay ${relay}`);
  }
  const started = spawnSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', 'freedomtools-cordn-coordinator'], { encoding: 'utf8' });
  assert.equal(started.status, 0);
  const logs = spawnSync('docker', ['logs', '--since', started.stdout.trim(), 'freedomtools-cordn-coordinator'], { encoding: 'utf8' });
  assert.equal(logs.status, 0);
  const connected = (logs.stdout + logs.stderr).split('\n').flatMap(line => {
    try { const entry = JSON.parse(line); return entry.msg === 'ContextVM MLS coordinator server connected' ? [entry] : []; }
    catch { return []; }
  }).at(-1);
  assert.equal(connected?.serverPubkey, identity.pubkey, 'Running process must use the same identity after restart');
  assert.equal(connected?.storageBackend, 'sqlite');
  assert.equal(connected?.announced, false);
  const report = { time: new Date().toISOString(), clientVersion: '0.9.0', ...identity,
    transportEncryption: 'required', groupCreated: true, keyPackagePublished: true, scopedRestart: true,
    freshPreSendSnapshots: true, results, relayChecks,
    runningServer: { pubkey: connected.serverPubkey, storageBackend: connected.storageBackend, announced: connected.announced } };
  writeFileSync(resolve(testRoot, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ evidence: resolve(testRoot, 'result.json'), ...report }, null, 2));
} finally {
  await sender?.close(); await receiver?.close(); clearTimeout(deadline);
}
