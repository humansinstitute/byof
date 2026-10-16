// Managed source activation after the generic Autopilot prerequisite is live.
// No service restart, key access, grant revocation or filesystem isolation claim.
import {readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {loadCapabilityClient} from './autopilot-runtime.ts';
import {configuration} from '../src/config.ts';
import {configurableBuilderConfiguration} from '../src/pipeline/configurable-configuration.ts';
const {capabilityClientContextFromEnv,callCapabilityBrokerResponse}=await loadCapabilityClient();
const [grantPath,evidencePath,versionText='70']=Bun.argv.slice(2);
for(const path of [grantPath,evidencePath])if(!path||Bun.spawnSync(['git','check-ignore',path]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',path]).exitCode===0)throw Error('Use ignored, untracked grant and evidence paths');
const config=configuration(),grant=await Bun.file(grantPath!).json(),current=config.followup,context=capabilityClientContextFromEnv();
if(!current||!config.storage)throw Error('Capable builder and managed storage installation required');
const next=configurableBuilderConfiguration(current,grant,process.cwd(),config.storage.installationId,Number(versionText));
const response=await callCapabilityBrokerResponse('/api/mcp/wingman/project-tool',{sessionId:context.sessionId,operation:'capabilities'},context);
const capabilities=await response.json();if(!response.ok||capabilities.protocol!=='native-project-tools-v1'||!['codex','claude','goose'].every(agent=>capabilities.completedTurnAgents?.includes(agent))||capabilities.gooseProvider!=='openrouter')throw Error('Autopilot Codex/Claude/Goose completed-turn activation is required first; do not restart it without explicit approval');
const source=readFileSync('.env','utf8'),lines=source.split('\n');
if(lines.filter(l=>l.startsWith('FREEDOM_FOLLOWUP_CONFIG=')).length!==1)throw Error('Expected exactly one current routing entry');
await Bun.write(evidencePath!,JSON.stringify({previous:current,next,capabilities,activatedAt:new Date().toISOString(),managedAppRestartRequired:true,autopilotRestartPerformed:false},null,2));
const temp='.env.engines-'+crypto.randomUUID();writeFileSync(temp,lines.map(l=>l.startsWith('FREEDOM_FOLLOWUP_CONFIG=')?'FREEDOM_FOLLOWUP_CONFIG='+JSON.stringify(next):l).join('\n'),{flag:'wx',mode:statSync('.env').mode&0o777});renameSync(temp,'.env');
console.log(JSON.stringify({definitionId:next.definitionId,selectableBuilder:next.selectableBuilder,callbackUrl:next.callbackUrl,scopeCount:1+(next.additionalScopes?.length??0),managedAppRestartRequired:true}));
