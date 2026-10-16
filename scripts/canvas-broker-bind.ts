// Installation management only. Reuses app custody; never reads or returns a signer key.
import {configuration} from '../src/config.ts';
import {openDatabase} from '../src/database.ts';
import {Workshop} from '../src/workshop.ts';
import {Assets} from '../src/assets.ts';
import {Site} from '../src/site.ts';
import {storageBinding} from '../src/storage.ts';
import {join} from 'node:path';
const [root,canvasId,evidencePath]=Bun.argv.slice(2);
if(!root?.startsWith('/')||!canvasId||!evidencePath||Bun.spawnSync(['git','check-ignore',evidencePath]).exitCode!==0||Bun.spawnSync(['git','ls-files','--error-unmatch',evidencePath]).exitCode===0)throw Error('Usage: bun scripts/canvas-broker-bind.ts /active/autopilot canvas-id ignored-evidence.json');
const config=configuration();if(!config.storage)throw Error('Managed storage config required');
const db=openDatabase(config.dataDir);let target;
try{const w=new Workshop(db,new Assets(join(config.dataDir,'objects')),canvasId);target=storageBinding(w,new Site(db,config).storage(canvasId))?.target;}finally{db.close();}
if(!target)throw Error('Canvas destination is not ready');
const {wappStore}=await import(root+'/src/wapps/wapp-store.ts');const wapp=wappStore.get(config.storage.installationId);
if(!wapp||wapp.appNpub!==target.appNpub||!wappStore.hasAppSigningKey(wapp.id)||new URL(wapp.launchUrl).origin!==config.origin)throw Error('Managed app authority differs from Canvas destination');
const same=(b:any)=>b.towerUrl===target.towerUrl&&b.workspaceId===target.workspaceId&&b.workspaceOwnerNpub===target.workspaceOwnerNpub;
if(wapp.towerBinding&&!same(wapp.towerBinding))throw Error('Existing managed binding differs; refusing to redirect it');
const binding=wapp.towerBinding??wappStore.listTowerBindings().find(same)??wappStore.createTowerBinding({label:'Freedom Canvas data',towerUrl:target.towerUrl,workspaceId:target.workspaceId,workspaceOwnerNpub:target.workspaceOwnerNpub});
// Supported store operation preserves existing broker key custody. HTTP first-binding path currently requests key import incorrectly.
const updated=wappStore.update(wapp.id,{towerBindingId:binding.id});if(updated?.appNpub!==wapp.appNpub)throw Error('App identity changed');
await Bun.write(evidencePath,JSON.stringify({installationId:wapp.wappInstallationId,appId:wapp.appId,towerBindingId:binding.id,target,identityPreserved:true,managedAppRestartRequired:true,autopilotRestartPerformed:false},null,2));
console.log(JSON.stringify({bound:true,evidencePath,managedAppRestartRequired:true}));
