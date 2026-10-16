// Installation management in an authorized session. No raw signing key is read or returned.
import {resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import type {ManagedStorageScope} from '../src/pipeline/managed-storage-transport.ts';
import {publicKey,configuration} from '../src/config.ts';
import {installSite} from '../src/site.ts';
import {openDatabase} from '../src/database.ts';
const [scopePath,receiptPath,versionText='1']=Bun.argv.slice(2),version=Number(versionText);
if(!scopePath||!receiptPath||!Number.isSafeInteger(version)||version<1)throw Error('Usage: bun scripts/storage-install.ts ignored-installation-scope.json ignored-receipt.json [version]');
for(const path of [scopePath,receiptPath])if(Bun.spawnSync(['git','check-ignore',path]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',path]).exitCode===0)throw Error('Installation context and receipts must be ignored/untracked');
const scope:ManagedStorageScope=JSON.parse(readFileSync(scopePath,'utf8'));
if(!scope.autopilotRoot.startsWith('/')||scope.appRoot!==resolve('.')||scope.appOrigin!==configuration().origin||!scope.installationId||!scope.appId||new URL(scope.towerOrigin).origin!==scope.towerOrigin||!scope.towerOrigin.startsWith('https:'))throw Error('Installation storage scope invalid');
const {wappStore}=await import(join(scope.autopilotRoot,'src/wapps/wapp-store.ts'));
const wapp=wappStore.get(scope.installationId);
if(!wapp||wapp.appId!==scope.appId||wapp.ownerNpub!==scope.ownerNpub||publicKey(wapp.appNpub)!==scope.appPubkey||new URL(wapp.launchUrl).origin!==scope.appOrigin)throw Error('Managed installation binding denied');
if(scope.browserAuthorizedDestinations===true&&scope.installationWorkshops!==true)throw Error('Browser destinations require installation-bound workshops');
const config=configuration(),db=openDatabase(config.dataDir);try{installSite(db,config);const selected=db.query('SELECT t.origin FROM workshops w JOIN towers t ON t.id=w.tower_id WHERE w.id=?').get(scope.workshopId) as any;if(!scope.browserAuthorizedDestinations&&selected?.origin!==scope.towerOrigin)throw Error('Workshop/Tower binding denied');if(scope.browserAuthorizedDestinations&&config.storage?.installationId!==scope.installationId)throw Error('Managed storage installation mismatch');}finally{db.close();}
const {capabilityNip98Fetch}=await import(join(scope.autopilotRoot,'src/mcp/capability-client.ts'));
const receipts:any[]=[];
async function api(path:string,payload?:unknown){const r=await capabilityNip98Fetch(new URL(path,process.env.WINGMAN_URL).href,{method:payload===undefined?'GET':'POST',...(payload===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});const result=await r.json();receipts.push({path,status:r.status,result});await Bun.write(receiptPath,JSON.stringify(receipts,null,2));if(!r.ok)throw Error(path+' '+r.status);return result;}
const root=await api('/api/pipelines/root'),entry=receiptPath+'.entry.ts';
await Bun.write(entry,`import {storeArtifactJob} from ${JSON.stringify(resolve('src/pipeline/store-artifact.ts'))};export const name='freedomtools.storageJob.v${version}';export const version=${version};export const description='Installation-bound private Tower storage and verified reads';export default input=>storeArtifactJob(input,${JSON.stringify(scope)});`);
const built=await Bun.build({entrypoints:[entry],target:'bun',format:'esm'});if(!built.success||built.outputs.length!==1)throw Error('Storage bundle failed');
async function install(directory:string,name:string,content:string){const file=Bun.file(join(directory,name));if(await file.exists()){if(await file.text()!==content)throw Error('Immutable installed version differs; increment version');return;}await api('/api/docs/file',{directory,name,content});}
await install(root.userFunctions,`freedomtools-storageJob.v${version}.mjs`,await built.outputs[0]!.text());
const spec={name:`BYO Freedom private storage v${version}`,version,enabled:true,description:'App-issued private upload/read jobs. Scoped managed signing and exact Tower S3 readback.',input:{},steps:[{name:'Verify private Tower storage job',type:'code',function:`freedomtools.storageJob.v${version}`,input:{pick:{jobId:'$.jobId'}},description:'Only the selected job object, configured Tower/workspace and methods are authorized. No builder or WApp key export.',display:{in:[{label:'Storage job',path:'$.jobId',format:'text'}],out:[{label:'Result',path:'$.action',format:'text'},{label:'Object',path:'$.remoteStorage.objectId',format:'text'},{label:'SHA256',path:'$.remoteStorage.sha256',format:'text'}]}}]};
await install(root.userDefinitions,`freedomtools-storage.v${version}.json`,JSON.stringify(spec,null,2));
const catalog=await api('/api/pipelines/definitions'),definition=catalog.definitions.find((d:any)=>d.name===spec.name);
if(!definition)throw Error('Storage definition missing');
console.log(JSON.stringify({definitionId:definition.id,version,installationId:scope.installationId,workshopId:scope.workshopId}));
