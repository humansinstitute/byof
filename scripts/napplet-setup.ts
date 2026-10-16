// Operator setup on the Autopilot host. No credentials are printed or exported.
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { configuration } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { Assets } from '../src/assets.ts';
import { join } from 'node:path';
import { projectRoute } from '../src/project-routing.ts';
import { ensureBuilderDirectory } from '../src/pipeline/project-directory.ts';
import { copyProjectFiles } from '../src/project-migration.ts';
import { refreshProjectGuidance } from '../src/local-builds.ts';
import { loadBuilderPrompt } from '../src/builder-prompt.ts';
const [root,receiptPath]=Bun.argv.slice(2);
if(!root || !receiptPath || !receiptPath.startsWith('tmp/docs/handoffs/'))throw Error('Usage: bun scripts/napplet-setup.ts /absolute/napplet-root tmp/docs/handoffs/setup-receipt.json');
ensureBuilderDirectory(root);
const config=configuration();if(!config.followup)throw Error('Scoped follow-up installation required');
const db=openDatabase(config.dataDir);
try {
 const workshopId=(db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id;
 const apply=(scope:any):any=>({...scope,builderRoot:root,workshopId,fileVersions:true,replacementEnabled:true,additionalScopes:scope.additionalScopes?.map(apply)});
 const next=apply(config.followup),evidence=[];
 for(const project of db.query('SELECT * FROM projects').all() as any[]){
  const old=projectRoute(project,config.followup),route=projectRoute(project,next);if(!route)continue;
  if(db.query("SELECT id FROM requests WHERE project_id=? AND status IN ('queued','dispatching','dispatch_pending','building')").get(project.id))throw Error('Active request prevents directory migration: '+project.id);
  const files=old?.directory && old.directory!==route.directory && existsSync(old.directory)?copyProjectFiles(old.directory,route.directory!):[];
  const assets=new Assets(join(config.dataDir,'objects'));
  const history=[];
  for(const revision of db.query('SELECT * FROM revisions WHERE project_id=? ORDER BY number').all(project.id) as any[]){
    const folder=join(route.directory!,'.history','revisions',revision.id);ensureBuilderDirectory(folder);
    const path=join(folder,'index.html'),source=assets.get(revision.source_hash);
    if(existsSync(path)){if(readFileSync(path,'utf8')!==source)throw Error('Historical revision conflict');}
    else writeFileSync(path,source,{flag:'wx',mode:0o400});
    history.push({revisionId:revision.id,number:revision.number,sha256:revision.source_hash});
  }
  refreshProjectGuidance(route.directory!,loadBuilderPrompt(db));
  evidence.push({projectId:project.id,oldDirectory:old?.directory,newDirectory:route.directory,files,history,historyPreserved:true});
 }
 const env=readFileSync('.env','utf8');
 writeFileSync('.env',env.split('\n').filter(line=>!line.startsWith('FREEDOM_FOLLOWUP_CONFIG=')&&!line.startsWith('FREEDOM_NAPPLET_ROOT=')).join('\n')+'\nFREEDOM_NAPPLET_ROOT='+root+'\nFREEDOM_FOLLOWUP_CONFIG='+JSON.stringify(next)+'\n',{mode:0o600});
 await Bun.write(receiptPath,JSON.stringify({workshopId,root,projects:evidence,activationRequired:true},null,2));
 console.log(JSON.stringify({workshopId,root,projects:evidence.length,activationRequired:true}));
}finally{db.close();}
