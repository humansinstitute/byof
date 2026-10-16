import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { storeBuildCandidate } from './store-artifact.ts';
import type { ManagedStorageScope } from './managed-storage-transport.ts';

/** Local persistence is enough to start. Remote storage stays grant-bound. */
export async function storeWorkshopBuildCandidate(input:any,scope:ManagedStorageScope,dataDir:string,store=storeBuildCandidate) {
  if(input.candidate?.action!=='build_completed')return input.candidate;
  const db=new Database(join(dataDir,'workshop.sqlite'),{readonly:true});
  let allocation:any;
  try {allocation=db.query('SELECT b.storage_required,p.workshop_id FROM local_builds b JOIN projects p ON p.id=b.project_id WHERE b.request_id=? AND b.project_id=?').get(input.requestId,input.projectId);}
  finally {db.close();}
  if(!allocation)throw Error('workshop_allocation_denied');
  if(!allocation.storage_required)return input.candidate;
  return store(input,{...scope,installationWorkshops:true,workshopId:allocation.workshop_id});
}
