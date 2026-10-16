import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {application} from '../src/application.ts';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {CanvasTableFixture} from './canvas-fixture.ts';
import {CanvasDatasetStore,canvasDatasetLimits,datasetBinding,datasetDescription} from '../src/canvas-datasets.ts';
import {canvasDatasetContract,nappletExecutionContract} from '../src/builder-prompt.ts';
import {replacementSnapshot,builderEpoch} from '../src/builder-lifecycle.ts';
import {authorizeStorageHttp} from '../src/pipeline/managed-storage-transport.ts';
const target={towerUrl:'https://tower.test',workspaceId:'workspace-a',workspaceOwnerNpub:'owner',appNpub:'app'};
const binding={name:'inventory',visibility:'shared' as const},definition={...binding,description:'Current inventory',fields:{quantity:'number: units available',sku:'string: stable product identifier'}};
function stores(){const table=new CanvasTableFixture(),scope={installationId:'installation-a',target,canvasId:'canvas-a',user:'a'.repeat(64)};return {table,scope,store:new CanvasDatasetStore(scope,table.request)};}
test('named datasets cross Napplets/users, owner attribution, atomic conflicts and scope isolation',async()=>{
 const {table,scope,store}=stores();await store.ensure();await store.open(definition);
 const other=new CanvasDatasetStore({...scope,user:'b'.repeat(64)},table.request);await other.open(binding);
 expect(await store.set(binding,'stock',{quantity:4},0)).toMatchObject({version:1,updatedBy:scope.user});expect(await other.get(binding,'stock')).toMatchObject({value:{quantity:4},version:1});
 const writes=await Promise.allSettled([store.set(binding,'stock',{quantity:5},1),other.set(binding,'stock',{quantity:6},1)]);expect(writes.filter(w=>w.status==='fulfilled')).toHaveLength(1);expect(writes.filter(w=>w.status==='rejected')).toHaveLength(1);expect(await store.get(binding,'stock')).toMatchObject({version:2});
 await expect(other.set(binding,'stock',{quantity:9},1)).rejects.toThrow('Dataset changed');
 for(const isolated of [{canvasId:'canvas-b'},{target:{...target,workspaceId:'workspace-b'}},{installationId:'installation-b'}])expect((await new CanvasDatasetStore({...scope,...isolated},table.request).get(binding,'stock')).version).toBe(0);
 const privateBinding={name:'notes',visibility:'private' as const};await store.open({...privateBinding,description:'Personal notes',fields:{note:'string: personal note'}});await store.set(privateBinding,'note',{note:'secret'},0);expect((await other.get(privateBinding,'note')).version).toBe(0);
 const discovery=await other.discovery();expect(discovery).toHaveLength(1);expect(discovery[0]).toMatchObject({name:'inventory',fields:definition.fields});expect(JSON.stringify(discovery)).not.toContain('secret');
 await expect(store.open({...definition,fields:{quantity:'string: incompatible'}})).rejects.toThrow('conflicts');
});
test('record and schema bounds, concurrent creates use distinct quota slots, no automatic legacy migration',async()=>{
 const {table,store}=stores();await store.open(definition);
 await Promise.all([store.set(binding,'a',{n:1},0),store.set(binding,'b',{n:2},0)]);expect(new Set([...table.rows.values()].filter(r=>r.slot>=0).map(r=>r.slot)).size).toBe(2);
 await expect(store.set(binding,'bad',{text:'x'.repeat(canvasDatasetLimits.valueBytes)},0)).rejects.toThrow('32 KiB');
 await expect(store.set(binding,'__schema__',{},0)).rejects.toThrow('Invalid record');
 await expect(store.set(binding,'a',{},-1)).rejects.toThrow('Expected version');
 for(let i=2;i<128;i++)await store.set(binding,'k'+i,{},0);
 await expect(store.set(binding,'overflow',{},0)).rejects.toThrow('quota');
 expect(()=>datasetBinding({...binding,owner:'forged'})).toThrow('Unexpected');expect(()=>datasetBinding({...binding,name:'../other'})).toThrow();expect(()=>datasetDescription({description:'',fields:{}})).toThrow();
});
test('actual Freedom backend requires current member, exact bridge/Canvas/session grants; lists and watches revoke',async()=>{
 const dir=mkdtempSync('/tmp/canvas-runtime-'),owner=generateSecretKey(),table=new CanvasTableFixture();
 const app=application({dataDir:dir,hostPubkey:getPublicKey(owner),origin:null,version:'test'},{datasetTransport:()=>table.request});const origin='http://canvas.test';
 type Account={cookie:string;csrf:string;pubkey:string};
 async function call(path:string,body?:any,account?:Account,canvas?:string){const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...(canvas?{'x-workshop-id':canvas}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));const raw=await response.text();return {status:response.status,data:response.headers.get('content-type')?.includes('text/html')?{documentId:raw.match(/documentId:\s*"([a-f0-9-]{36})"/)?.[1]}:JSON.parse(raw),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};}
 async function login(key:Uint8Array){const c=await call('challenge',{}),r=await call('login',{challengeId:c.data.id,event:finalizeEvent(c.data.event,key),identityType:'extension'});return {cookie:r.cookie,csrf:r.data.csrf,pubkey:getPublicKey(key)};}
 async function bridge(p:any,a:Account,canvas?:string){const doc=await call(`projects/${p.id}/preview?revision=${p.current_revision}${canvas?'&workshop='+canvas:''}`,undefined,a,canvas);const opened=await call('napplet/open',{projectId:p.id,revisionId:p.current_revision,documentId:doc.data.documentId},a,canvas);expect(opened.status).toBe(200);return opened.data.token;}
 try{
  const a=await login(owner);app.db.run("UPDATE room SET admission='open' WHERE id=1");const b=await login(generateSecretKey());
  const p=(await call('projects',{starterId:'blank'},a)).data.project,q=(await call('projects',{starterId:'blank'},b)).data.project;
  const ta=await bridge(p,a),tb=await bridge(q,b);
  const oa=await call('napplet/dataset',{token:ta,method:'open',dataset:definition},a),ob=await call('napplet/dataset',{token:tb,method:'open',dataset:binding},b);expect(oa.status).toBe(200);expect(ob.status).toBe(200);
  const ha=oa.data.handle,hb=ob.data.handle;
  expect((await call('napplet/dataset',{token:ta,method:'set',handle:ha,key:'x',value:{quantity:1},expectedVersion:0},a)).status).toBe(200);
  expect((await call('napplet/dataset',{token:tb,method:'get',handle:hb,key:'x'},b)).data.value).toEqual({quantity:1});
  expect((await call('napplet/dataset',{token:tb,method:'list',handle:ha},b)).status).toBe(403);
  expect((await call('napplet/dataset',{token:ta,method:'get',handle:ha,key:'x',user:b.pubkey},a)).status).toBe(400);
  expect((await call('canvas/datasets')).status).toBe(401);
  const snapshot=await app.workshop.datasetDiscovery!(app.workshop.scoped(app.auth.member(a.pubkey)));expect(snapshot.datasets[0].name).toBe('inventory');expect(snapshot.valuesIncluded).toBe(false);
  app.workshop.datasetSnapshot=snapshot;const request=app.workshop.request(app.auth.member(a.pubkey),p.id,{requestId:'discovery',prompt:'Improve',expectedRevisionId:p.current_revision},true) as any;expect(replacementSnapshot(app.workshop,p,request,'/fixture',builderEpoch(app.workshop,p)).snapshot).toHaveProperty('canvasDatasets',snapshot);
  expect((await call('napplet/data',{token:ta,method:'set',key:'legacy',value:'untouched'},a)).status).toBe(200);expect((await call('napplet/dataset',{token:ta,method:'get',handle:ha,key:'legacy'},a)).data.version).toBe(0);expect((await call('napplet/data',{token:ta,method:'get',key:'legacy'},a)).data.value).toBe('untouched');
  const other=(await call('site/workshops',{title:'Different Canvas'},a)).data;expect((await call('napplet/dataset',{token:ta,method:'get',handle:ha,key:'x'},a,other.id)).status).toBe(403);
  const controller=new AbortController();const stream=await app.handle(new Request(origin+'/api/v1/napplet/dataset/watch',{method:'POST',signal:controller.signal,headers:{origin,cookie:b.cookie,'x-csrf-token':b.csrf,'content-type':'application/json'},body:JSON.stringify({token:tb,handle:hb})}));expect(stream.status).toBe(200);const reader=stream.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain('connecting');
  app.db.run("UPDATE members SET state='banned' WHERE pubkey=?",[b.pubkey]);expect((await call('napplet/dataset',{token:tb,method:'list',handle:hb},b)).status).toBe(403);
  let closed=false;for(let i=0;i<6;i++){const r=await reader.read();if(r.done)break;if(new TextDecoder().decode(r.value).includes('closed')){closed=true;break;}}expect(closed).toBe(true);controller.abort();
  // More than 1000 historical grants must not exhaust the process after frame reloads.
  for(let i=0;i<260;i++){const token=await bridge(p,a);for(let j=0;j<4;j++)expect((await call('napplet/dataset',{token,method:'open',dataset:binding},a)).status).toBe(200);expect((await call('napplet/data',{token,method:'close'},a)).status).toBe(200);}
  await call('logout',{},a);expect((await call('napplet/dataset',{token:ta,method:'get',handle:ha,key:'x'},a)).status).toBe(401);
 }finally{app.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('builder and bridge contracts require discovery, explicit permissions and preserve tool publication/prose',async()=>{
 expect(canvasDatasetContract).toContain('REQUIRE inspecting');expect(canvasDatasetContract).toContain('never private values');expect(nappletExecutionContract).toContain('final messages remain ordinary prose');
 const skill=await Bun.file('templates/napplet-build/SKILL.md').text();expect(skill).toContain('canvasDatasets');expect(skill).toContain('Never treat a missing/unavailable snapshot');
 const client=await Bun.file('templates/napplet-client.js').text();expect(client).toContain('openDataset');
 const app=await Bun.file('public/app.js').text();expect(app).toContain("button('workshops','Canvases')");expect(app).toContain('Create Canvas');expect(app).toContain("api('site/workshops'");
});
test('atomic schema slots bound shared and private owners independently, including concurrent final slot',async()=>{
 const {store,scope,table}=stores();
 for(let i=0;i<63;i++)await store.open({...definition,name:'shared_'+i});
 const race=await Promise.allSettled([store.open({...definition,name:'last_a'}),store.open({...definition,name:'last_b'})]);
 expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await store.discovery()).toHaveLength(64);
 const privateStore=new CanvasDatasetStore(scope,table.request);
 for(let i=0;i<64;i++)await privateStore.open({...definition,visibility:'private',name:'private_'+i});
 await expect(privateStore.open({...definition,visibility:'private',name:'overflow'})).rejects.toThrow('limit');
 const other=new CanvasDatasetStore({...scope,user:'b'.repeat(64)},table.request);
 await other.open({...definition,visibility:'private',name:'overflow'});expect(await other.discovery()).toHaveLength(64);
});
test('object cap and canonical descriptions, versioned remove prevents stale writes and ABA recreation',async()=>{
 const {store}=stores();await store.open(definition);await store.open({...definition,fields:{sku:definition.fields.sku,quantity:definition.fields.quantity}});
 for(const invalid of [null,[],1,'text',true])await expect(store.set(binding,'x',invalid,0)).rejects.toThrow('non-null JSON object');
 await store.set(binding,'x',{text:'x'.repeat(32757)},0);
 expect(await store.remove(binding,'x',1)).toMatchObject({version:2,deleted:true});
 expect(await store.get(binding,'x')).toMatchObject({version:2,value:null});expect(store.records(await store.list(binding))).toEqual([]);
 await expect(store.set(binding,'x',{},0)).rejects.toThrow('already exists');await expect(store.set(binding,'x',{},1)).rejects.toThrow('changed');
 expect(await store.set(binding,'x',{restored:true},2)).toMatchObject({version:3});
 await expect(store.remove(binding,'x',2)).rejects.toThrow('changed');
});
