// Diagnostic only: this does not start a builder or constitute an isolation boundary.
// Uses synthetic fixtures exclusively; never reads credentials or other projects.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'freedomtools-boundary-'));
try {
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const service = join(root, 'service');
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(service)]);
  await writeFile(join(projectB, 'canary'), 'synthetic-other-project');
  await writeFile(join(service, 'canary'), 'synthetic-service-credential');
  const child = Bun.spawn([process.execPath, '-e', `
    const fs = await import('node:fs/promises');
    const results = {
      crossProjectReadable: await fs.readFile(process.argv[1], 'utf8').then(x => x === 'synthetic-other-project').catch(() => false),
      serviceCanaryReadable: await fs.readFile(process.argv[2], 'utf8').then(x => x === 'synthetic-service-credential').catch(() => false),
      parentProcessVisible: (() => { try { process.kill(Number(process.argv[3]), 0); return true; } catch { return false; } })(),
      publicNetworkReachable: await fetch('https://docs.typesafe.ai/llms.txt', {signal: AbortSignal.timeout(10000)}).then(r => r.ok).catch(() => false),
      injectedCapabilityVisible: process.env.FREEDOMTOOLS_TEST_CAPABILITY === 'synthetic-no-authority'
    };
    console.log(JSON.stringify(results));
  `, join(projectB, 'canary'), join(service, 'canary'), String(process.pid)], {
    cwd: projectA,
    env: { PATH: process.env.PATH ?? '', FREEDOMTOOLS_TEST_CAPABILITY: 'synthetic-no-authority' },
    stdout: 'pipe', stderr: 'pipe'
  });
  const output = await new Response(child.stdout).text();
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`Fixture subprocess failed (${exit})`);
  console.log(output.trim());
  console.log('Diagnostic completed. True values show that cwd and environment injection do not enforce isolation. This is not an isolated managed-builder test.');
} finally {
  await rm(root, { recursive: true, force: true });
}
