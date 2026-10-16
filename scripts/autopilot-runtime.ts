import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const autopilotRepository = resolve(
  process.env.AUTOPILOT_REPO ?? '../wm/autopilot',
);

export async function loadCapabilityClient(): Promise<any> {
  return import(pathToFileURL(resolve(
    autopilotRepository,
    'src/mcp/capability-client.ts',
  )).href);
}
