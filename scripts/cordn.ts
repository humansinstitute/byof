import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

// This independent service never reads the Freedom Tools .env or owner keys.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, 'tmp/cordn-service');
const secret = resolve(runtime, 'service.env');
const data = resolve(runtime, 'data');
const name = 'freedomtools-cordn-coordinator';
const label = 'studio.otherstuff.freedomtools.cordn';
const config = resolve(root, 'ops/cordn/runtime.env');
const imageFile = resolve(root, 'ops/cordn/image.txt');
const action = process.argv[2];
function docker(args: string[], quiet = false): string {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} failed (details withheld; inspect only scoped public diagnostics)`);
  const output = result.stdout.toString().trim();
  if (!quiet && output) console.log(output);
  return output;
}
function publicIdentity() {
  const content = readFileSync(secret, 'utf8').trim();
  if (!/^CORDN_SERVER_PRIVATE_KEY=[a-f0-9]{64}$/.test(content)) throw new Error('Invalid service key file');
  const pubkey = getPublicKey(Uint8Array.from(Buffer.from(content.split('=')[1]!, 'hex')));
  const relays = readFileSync(config, 'utf8').match(/^CORDN_RELAY_URLS=(.+)$/m)![1]!.split(',');
  return { pubkey, relays, joinUrl: `https://cordn.net/chat/coordinators?c=${nip19.nprofileEncode({ pubkey, relays })}` };
}
function validate() {
  if (docker(['context', 'show'], true) !== 'desktop-linux') throw new Error('Expected local Docker Desktop context');
  if (docker(['info', '--format', '{{.OSType}}'], true) !== 'linux') throw new Error('Linux Docker required');
  const image = readFileSync(imageFile, 'utf8').trim();
  if (!/^ghcr\.io\/cordn-msg\/cordn@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Official digest pin required');
  const env = Object.fromEntries(readFileSync(config, 'utf8').trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  for (const [key, value] of Object.entries({ CORDN_ANNOUNCED: 'false', CORDN_STORAGE_BACKEND: 'sqlite',
    CORDN_SQLITE_PATH: '/data/cordn.sqlite', CORDN_RATE_LIMIT_ENABLED: 'true', CORDN_LOG_ABUSE_REJECTIONS: 'true' })) {
    if (env[key] !== value) throw new Error(`Invalid coordinator setting: ${key}`);
  }
  if ('CORDN_SERVER_PRIVATE_KEY' in env) throw new Error('Service key belongs only in ignored service.env');
  for (const key of ['CORDN_RATE_LIMIT_REFILL_PER_MINUTE', 'CORDN_RATE_LIMIT_BURST', 'CORDN_RATE_LIMIT_IDLE_TTL_SECONDS',
    'CORDN_MAX_KEY_PACKAGES_PER_IDENTITY', 'CORDN_MAX_LAST_RESORT_KEY_PACKAGES_PER_IDENTITY', 'CORDN_MAX_AGE_DAYS']) {
    if (!/^[1-9]\d*$/.test(env[key] ?? '')) throw new Error(`Positive integer required: ${key}`);
  }
  if (env.CORDN_RELAY_URLS !== 'wss://relay.contextvm.org,wss://relay2.contextvm.org') throw new Error('Expected public relay pair');
  for (const path of [runtime, data, secret]) {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o077)) throw new Error('Service storage must be owner-only');
  }
  const ignored = Bun.spawnSync(['git', 'check-ignore', secret], { cwd: root });
  if (ignored.exitCode !== 0) throw new Error('Service key must be ignored');
  const tracked = Bun.spawnSync(['git', 'ls-files', '--error-unmatch', secret], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (tracked.exitCode === 0) throw new Error('Service key must be untracked');
  publicIdentity();
  return image;
}
function ownedContainer() {
  const owned = docker(['container', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, name], true);
  if (owned !== 'true') throw new Error('Refusing to operate on an unrelated container');
}
try {
  if (action === 'init') {
    if (Bun.spawnSync(['git', 'check-ignore', secret], { cwd: root }).exitCode !== 0) throw new Error('Service key destination must be ignored before initialization');
    for (const path of [runtime, data, secret]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlink service storage');
    }
    mkdirSync(data, { recursive: true, mode: 0o700 });
    chmodSync(runtime, 0o700); chmodSync(data, 0o700);
    if (!existsSync(secret)) {
      writeFileSync(secret, `CORDN_SERVER_PRIVATE_KEY=${Buffer.from(generateSecretKey()).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(publicIdentity(), null, 2));
  } else if (action === 'validate' || action === 'identity') {
    const image = validate();
    console.log(JSON.stringify({ image, ...publicIdentity() }, null, 2));
  } else if (action === 'start') {
    const image = validate();
    const existing = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], true);
    if (existing) { ownedContainer(); docker(['start', name]); }
    else docker(['run', '-d', '--platform', 'linux/amd64', '--name', name, '--label', `${label}=true`, '--restart', 'unless-stopped',
      '--user', `${process.getuid!()}:${process.getgid!()}`, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '--env-file', config, '--mount', `type=bind,src=${secret},dst=/app/.env,readonly`,
      '--mount', `type=bind,src=${data},dst=/data`, image]);
  } else if (action === 'restart' || action === 'stop') {
    validate(); ownedContainer(); docker([action, name]);
  } else if (action === 'status') {
    ownedContainer(); docker(['inspect', '--format', '{{.State.Status}} image={{.Config.Image}} restart={{.HostConfig.RestartPolicy.Name}}', name]);
  } else throw new Error('Usage: bun scripts/cordn.ts init|validate|identity|start|restart|stop|status');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cordn operation failed');
  process.exit(1);
}
