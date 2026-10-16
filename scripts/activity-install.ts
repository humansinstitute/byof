// Authorized implementation CLI: version exact installed builder specs and issue
// installation-scoped grants. It never activates a service or changes live env.
import {resolve,join,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {autopilotRepository,loadCapabilityClient} from './autopilot-runtime.ts';
import {activityWebhookConfiguration} from '../src/pipeline/activity-configuration.ts';
const {capabilityNip98Fetch}=await loadCapabilityClient();
const [planPath,evidencePath]=Bun.argv.slice(2);
if(!planPath||!evidencePath)throw Error('Usage: bun scripts/activity-install.ts ignored-plan.json ignored-evidence.json');
function ignored(path:string){if(Bun.spawnSync(['git','check-ignore',path]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',path]).exitCode===0)throw Error('Operational paths must be ignored and untracked');}
ignored(planPath);ignored(evidencePath);
const plan=await Bun.file(planPath).json(),receipts:any[]=[],installed:any[]=[];
async function api(path:string,payload?:unknown){const r=await capabilityNip98Fetch(new URL(path,process.env.WINGMAN_URL).href,{method:payload===undefined?'GET':'POST',...(payload===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});const body=await r.json();receipts.push({path,status:r.status,body});await Bun.write(evidencePath,JSON.stringify({receipts,installed},null,2));if(!r.ok)throw Error('Installation API rejected '+path+' '+r.status);return body;}
const root=await api('/api/pipelines/root');
async function publish(directory:string,name:string,content:string){const file=Bun.file(join(directory,name));if(await file.exists()){if(await file.text()!==content)throw Error('Version already exists with different content: '+name);return;}await api('/api/docs/file',{directory,name,content});}
async function bundle(entry:string,name:string){const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm'});if(!result.success||result.outputs.length!==1)throw Error('Function bundle failed');await publish(root.userFunctions,name,await result.outputs[0]!.text());}
for(const item of plan.installations){
 for(const file of [item.scopeFile,item.storageScopeFile,item.registrationFile])ignored(file);
 const source=(await api('/api/pipelines/definitions/'+encodeURIComponent(item.definitionId))).definition;
 if(!source?.spec||source.spec.version!==item.sourceVersion||!Number.isSafeInteger(item.version)||item.version<=item.sourceVersion)throw Error('Installed source/version mismatch');
 const spec=structuredClone(source.spec),scope=await Bun.file(item.scopeFile).json(),storage=await Bun.file(item.storageScopeFile).json();
 const native=spec.steps.filter((s:any)=>s.type==='code'&&s.function==='session.completedTurn');if(native.length!==1||!spec.steps.some((s:any)=>s.function?.startsWith('freedomtools.storeBuild.')))throw Error('One completedTurn and existing storage required');
 native[0].activityWebhook=activityWebhookConfiguration(plan.activityUrl);
 native[0].input.pick.requestId='$.nativeRequestId';
 native[0].input.pick.abandonUncertain='$.abandonUncertain';
 const version=item.version;spec.version=version;spec.name=`BYO Freedom interactive project builder v${version}`;
 const prepare=spec.steps.find((s:any)=>s.function?.startsWith('freedomtools.followupPrepare.')),candidate=spec.steps.find((s:any)=>s.function?.startsWith('freedomtools.followupCandidate.')),store=spec.steps.find((s:any)=>s.function?.startsWith('freedomtools.storeBuild.'));
 if(!prepare||!candidate||!store||!scope.workshopId||scope.workshopId!==plan.workshopId)throw Error('Installed scope mismatch');
 prepare.function=`freedomtools.followupPrepare.v${version}`;candidate.function=`freedomtools.followupCandidate.v${version}`;store.function=`freedomtools.storeBuild.v${version}`;
 for(const [kind,content] of [
  ['Prepare',`import {prepareTrustedFollowup} from ${JSON.stringify(resolve('src/pipeline/followup.ts'))};import {ensureBuilderDirectory,seedBuilderSource} from ${JSON.stringify(resolve('src/pipeline/project-directory.ts'))};export const name='freedomtools.followupPrepare.v${version}';export const version=${version};export default input=>{const result=prepareTrustedFollowup(input,${JSON.stringify(scope)});ensureBuilderDirectory(result.directory);if(!input.replacementContext?.fileBuild)seedBuilderSource(result.directory,input.source);return result;};`],
  ['Candidate',`import {followupCandidate} from ${JSON.stringify(resolve('src/pipeline/followup.ts'))};export const name='freedomtools.followupCandidate.v${version}';export const version=${version};export default input=>followupCandidate(input);`],
  ['Storage',`import {storeBuildCandidate} from ${JSON.stringify(resolve('src/pipeline/store-artifact.ts'))};export const name='freedomtools.storeBuild.v${version}';export const version=${version};export default input=>storeBuildCandidate(input,${JSON.stringify(storage)});`],
 ] as [string,string][]){const path=evidencePath+'.'+version+'.'+kind+'.ts';await Bun.write(path,content);await bundle(path,`freedomtools-${kind==='Prepare'?'followupPrepare':kind==='Candidate'?'followupCandidate':'storeBuild'}.v${version}.mjs`);}
 const fileName=`freedomtools-followup.v${version}.json`;await publish(root.userDefinitions,fileName,JSON.stringify(spec,null,2));
 const definitionId='user:'+basename(dirname(root.userDefinitions))+':'+createHash('sha256').update(join(root.userDefinitions,fileName)).digest('hex').slice(0,12);
 const after=(await api('/api/pipelines/definitions/'+encodeURIComponent(definitionId))).definition;if(JSON.stringify(after.spec)!==JSON.stringify(spec))throw Error('Installed spec readback differs');
 const registration={...await Bun.file(item.registrationFile).json(),definitionId,expiresAt:Date.now()+7*86400000};
 const registrationPath=evidencePath+'.'+version+'.registration.json';await Bun.write(registrationPath,JSON.stringify(registration));
 const command=Bun.spawnSync(['bun','clis/wapp-pipeline-grant.ts','register',resolve(registrationPath)],{cwd:autopilotRepository});if(command.exitCode!==0)throw Error('Managed grant registration failed: '+command.stderr.toString());
 const grant=JSON.parse(command.stdout.toString());const result={previousDefinitionId:item.definitionId,definitionId,version,activityUrl:plan.activityUrl,grant,sourceHash:createHash('sha256').update(JSON.stringify(source.spec)).digest('hex'),installedHash:createHash('sha256').update(JSON.stringify(spec)).digest('hex')};installed.push(result);await Bun.write(evidencePath,JSON.stringify({receipts,installed},null,2));
}
const functions=(await api('/api/pipelines/functions')).functions;
for(const i of installed)for(const name of [`freedomtools.followupPrepare.v${i.version}`,`freedomtools.followupCandidate.v${i.version}`,`freedomtools.storeBuild.v${i.version}`,'session.completedTurn'])if(!functions.some((f:any)=>f.name===name&&f.status==='ok'))throw Error('Installed function unavailable: '+name);
console.log(JSON.stringify({installed:installed.map(i=>({definitionId:i.definitionId,version:i.version,activityUrl:i.activityUrl,credentialFile:i.grant.credentialFile})),evidencePath,activation:'pending Autopilot prerequisite and managed Freedom Tools activation'}));
