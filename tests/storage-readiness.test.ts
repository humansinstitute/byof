import {test,expect} from 'bun:test';
import {storageDecision,storageTerminal} from '../src/pipeline/storage-readiness.ts';
import {storageJobScope} from '../src/pipeline/store-artifact.ts';
import {authorizeStorageHttp} from '../src/pipeline/managed-storage-transport.ts';
import {nip19} from 'nostr-tools';
const screen=(noul:any)=>({model:'fixture',answers:{injection:{type:'noul',noul:0},extraction:{type:'noul',noul:0},implementation:{type:'noul',noul}}});
test('unready storage blocks implementation before builder; explicit answers and clear auto conversations stay available',()=>{
 for(const mode of ['auto','build'])for(const probability of [undefined,NaN,-1,0.05,0.5,0.99,2]){
  const decision:any=storageDecision({mode,storageReady:false,screen:screen(probability)});expect(decision.builderAllowed).toBe(false);expect(decision.banRequired).toBe(false);
  expect(storageTerminal({requestId:'q',projectId:'p',screen:decision.screen,blockedResult:decision.blockedResult})).toMatchObject({action:'build_failed',code:'storage_unready',requestId:'q',projectId:'p'});
 }
 expect(storageDecision({mode:'answer',storageReady:false,screen:screen(1)}).builderAllowed).toBe(true);
 expect(storageDecision({mode:'auto',storageReady:false,screen:screen(0.001)}).builderAllowed).toBe(true);
 expect(storageDecision({mode:'build',storageReady:true,screen:screen(1)}).builderAllowed).toBe(true);
 expect(storageDecision({mode:'answer',storageReady:false,screen:{}}).action).toBe('classifier_error');
});
test('generic destination grants bind authenticated installation job, workshop, native grants and exact app before signing',()=>{
 const app='a'.repeat(64),target={towerUrl:'https://nstack.otherstuff.ai',workspaceId:crypto.randomUUID(),workspaceOwnerNpub:nip19.npubEncode('b'.repeat(64)),appNpub:nip19.npubEncode(app)};
 const scope:any={appPubkey:app,appOrigin:'https://app.example',installationId:crypto.randomUUID(),workshopId:crypto.randomUUID(),towerOrigin:'https://sb4.otherstuff.studio',installationWorkshops:true,browserAuthorizedDestinations:true};
 const job:any={installationId:scope.installationId,workshopId:scope.workshopId,jobId:crypto.randomUUID(),target,objectId:crypto.randomUUID(),fileName:'v1.html',sha256:'c'.repeat(64),sizeBytes:1,operation:'read'};
 job.destinationGrant={installationId:scope.installationId,workshopId:scope.workshopId,target,actor:'d'.repeat(64),namespaceEventId:'e'.repeat(64),inviteEventId:'f'.repeat(64)};
 const allowed=storageJobScope(scope,job);expect(allowed.towerOrigin).toBe(target.towerUrl);expect(scope.towerOrigin).toBe('https://sb4.otherstuff.studio');
 expect(()=>authorizeStorageHttp(allowed,job,target.towerUrl+'/api/v4/storage/'+job.objectId+'/content','GET')).not.toThrow();
 for(const origin of ['https://evil.example','https://sb4.otherstuff.studio'])expect(()=>authorizeStorageHttp(allowed,job,origin+'/api/v4/storage/'+job.objectId+'/content','GET')).toThrow();
 for(const changes of [{destinationGrant:null},{installationId:crypto.randomUUID()},{workshopId:crypto.randomUUID()},{destinationGrant:{...job.destinationGrant,workshopId:crypto.randomUUID()}},{destinationGrant:{...job.destinationGrant,target:{...target,workspaceId:crypto.randomUUID()}}},{target:{...target,appNpub:nip19.npubEncode('b'.repeat(64))}},{destinationGrant:{...job.destinationGrant,actor:'npub'}}])expect(()=>storageJobScope(scope,{...job,...changes})).toThrow();
 expect(()=>storageJobScope({...scope,browserAuthorizedDestinations:false},job)).toThrow();
});
test('managed signer permits only the exact remote builder preparation body and URL',()=>{
 const scope:any={appOrigin:'https://app.example',appPubkey:'a'.repeat(64)},body={requestId:crypto.randomUUID(),projectId:crypto.randomUUID()};
 expect(()=>authorizeStorageHttp(scope,null,scope.appOrigin+'/api/v1/internal/builder/prepare','POST',body,undefined,undefined,{body})).not.toThrow();
 for(const [url,method,changed] of [[scope.appOrigin+'/api/v1/internal/builder/prepare?x=1','POST',body],[scope.appOrigin+'/api/v1/internal/builder/prepare','GET',body],['https://evil.example/api/v1/internal/builder/prepare','POST',body],[scope.appOrigin+'/api/v1/internal/builder/prepare','POST',{...body,projectId:crypto.randomUUID()}]])expect(()=>authorizeStorageHttp(scope,null,String(url),String(method),changed,undefined,undefined,{body})).toThrow();
});
