import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {CanvasRuntime} from '../src/canvas-runtime.ts';
import {CanvasTableFixture} from './canvas-fixture.ts';
import {canvasBroker,canvasBrokerBindingStatus,canvasDirect,canvasTransport} from '../src/canvas-broker.ts';
import {CanvasDatasetStore} from '../src/canvas-datasets.ts';
import {sha256} from '../src/assets.ts';
import {generateSecretKey,getPublicKey,nip19,verifyEvent} from 'nostr-tools';

test('128 authorized watchers share version-only requests; abort stops all polling and slow consumers close',async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE sessions(hash text,pubkey text,expires_at integer);CREATE TABLE workshop_storage_bindings(workshop_id text);CREATE TABLE storage_jobs(operation text);');
 const member={pubkey:'a'.repeat(64)},session='test-session';db.run('INSERT INTO sessions VALUES(?,?,?)',[session,member.pubkey,Math.floor(Date.now()/1000)+3600]);
 const tokens=new Set<string>();let closeToken:(token:string)=>void=()=>{};
 const data={onClose:(f:any)=>closeToken=f,activeToken:(t:string)=>tokens.has(t),authorize:(_w:any,_m:any,_s:any,t:string)=>{if(!tokens.has(t))throw Error('revoked');}};
 const workshop={id:'canvas',db,legacy:false,scoped:(m:any)=>m,admitted:()=>{}},table=new CanvasTableFixture();let polls=0;const pollOwners:string[]=[];
 const runtime=new CanvasRuntime(db,data as any,()=>async(url,method,body:any)=>{if(body?.select?.join(',')==='id,version'){polls++;pollOwners.push(body.where.owner_pubkey.eq);expect(body).not.toHaveProperty('data');}return table.request(url,method,body);});
 const streams:{controller:AbortController;done:Promise<void>}[]=[];
 try{
  for(let i=0;i<32;i++){
   const token='token-'+i;tokens.add(token);
   for(let j=0;j<4;j++){
    const opened:any=await runtime.operate(workshop as any,member as any,session,undefined,{token,method:'open',dataset:{name:'shared',visibility:'shared',description:'Shared fixture',fields:{n:'number'}}});
    const controller=new AbortController(),reader=runtime.watch(workshop as any,member as any,session,undefined,{token,handle:opened.handle},controller.signal).getReader();
    streams.push({controller,done:(async()=>{while(!(await reader.read()).done){}})()});
   }
  }
  expect(pollOwners.every(owner=>owner==='')).toBe(true);const initial=polls;await new Promise(r=>setTimeout(r,5150));expect(polls-initial).toBe(1);
  for(const s of streams)s.controller.abort();await Promise.all(streams.map(s=>s.done));const stopped=polls;
  await new Promise(r=>setTimeout(r,5100));expect(polls).toBe(stopped);
  expect((db.query('SELECT count(*) n FROM storage_jobs').get() as any).n).toBe(0);
  const privateStreams=[];
  for(const user of ['a'.repeat(64),'b'.repeat(64)]){const token='private-'+user;tokens.add(token);const privateSession='session-'+user;db.run('INSERT INTO sessions VALUES(?,?,?)',[privateSession,user,Math.floor(Date.now()/1000)+3600]);const actor={pubkey:user};const opened:any=await runtime.operate(workshop as any,actor as any,privateSession,undefined,{token,method:'open',dataset:{name:'notes',visibility:'private',description:'Private fixture',fields:{n:'number'}}});const controller=new AbortController(),reader=runtime.watch(workshop as any,actor as any,privateSession,undefined,{token,handle:opened.handle},controller.signal).getReader();privateStreams.push({controller,reader});}
  await new Promise(r=>setTimeout(r,20));expect(pollOwners).toContain('a'.repeat(64));expect(pollOwners).toContain('b'.repeat(64));for(const s of privateStreams){s.controller.abort();while(!(await s.reader.read()).done){}}
  // An unread channel has a finite queue and closes instead of accumulating messages.
  const token='slow';tokens.add(token);const opened:any=await runtime.operate(workshop as any,member as any,session,undefined,{token,method:'open',dataset:{name:'shared',visibility:'shared'}});
  const abort=new AbortController(),reader=runtime.watch(workshop as any,member as any,session,undefined,{token,handle:opened.handle},abort.signal).getReader();
  await new Promise(r=>setTimeout(r,6500));let closed=false;for(let i=0;i<12;i++){const r=await reader.read();if(r.done){closed=true;break;}}expect(closed).toBe(true);abort.abort();
 }finally{for(const s of streams)s.controller.abort();db.close();}
},25000);

test('managed Canvas broker rejects destination drift and unconditional deletes before transport',async()=>{
 const scope={installationId:'installation',canvasId:'canvas',user:'a'.repeat(64),target:{towerUrl:'https://tower.test',workspaceId:'workspace',workspaceOwnerNpub:'owner',appNpub:'app'}};
 const env={WAPP_TOWER_DB_BROKER_URL:'http://127.0.0.1:1/api/internal/wapps/tower-db',WAPP_TOWER_DB_CAPABILITY:'runtime',WAPP_INSTALLATION_ID:'installation',WAPP_TOWER_URL:'https://tower.test',WAPP_TOWER_WORKSPACE_ID:'workspace',WAPP_TOWER_WORKSPACE_OWNER_NPUB:'owner',WAPP_APP_NPUB:'app'};
 expect(canvasBrokerBindingStatus(scope,env).code).toBe('exact_match');
 const mismatch=canvasBrokerBindingStatus(scope,{...env,WAPP_TOWER_URL:'https://sb4.otherstuff.studio'});expect(mismatch).toMatchObject({code:'managed_binding_mismatch',canvasOrigin:'https://tower.test',managedOrigin:'https://sb4.otherstuff.studio'});expect(mismatch.message).toContain('Keep this Canvas on https://tower.test');
 expect(()=>canvasBroker(scope,undefined,{...env,WAPP_TOWER_URL:'https://sb4.otherstuff.studio'})).toThrow('not authorized by the managed broker binding');
 expect(()=>canvasBroker({...scope,target:{...scope.target,workspaceId:'other'}},undefined,env)).toThrow('not authorized');
 const request=canvasBroker(scope,undefined,env);
 await expect(request('https://tower.test/api/v4/workspaces/owner/apps/app/db/tables/canvas_dataset_records/rows/'+'a'.repeat(64),'DELETE')).rejects.toThrow('denied');
 await expect(request('https://foreign.test/api/v4/workspaces/owner/apps/app/db/descriptor','GET')).rejects.toThrow('denied');
});

test('an existing Canvas target remains unchanged and becomes eligible only under an exact managed binding',()=>{
 const target={towerUrl:'https://nstack.otherstuff.ai',workspaceId:'nstack-workspace',workspaceOwnerNpub:'nstack-owner',appNpub:'freedom-app'},scope={installationId:'freedom-installation',canvasId:'testing-canvas',user:'a'.repeat(64),target},before=JSON.stringify(target);
 const singleOtherBinding={WAPP_TOWER_DB_BROKER_URL:'http://127.0.0.1:1/api/internal/wapps/tower-db',WAPP_TOWER_DB_CAPABILITY:'runtime',WAPP_INSTALLATION_ID:scope.installationId,WAPP_TOWER_URL:'https://sb4.otherstuff.studio',WAPP_TOWER_WORKSPACE_ID:'sb4-workspace',WAPP_TOWER_WORKSPACE_OWNER_NPUB:'sb4-owner',WAPP_APP_NPUB:target.appNpub};
 expect(canvasBrokerBindingStatus(scope,singleOtherBinding).code).toBe('managed_binding_mismatch');
 const supportedExactBinding={...singleOtherBinding,WAPP_TOWER_URL:target.towerUrl,WAPP_TOWER_WORKSPACE_ID:target.workspaceId,WAPP_TOWER_WORKSPACE_OWNER_NPUB:target.workspaceOwnerNpub};
 expect(canvasBrokerBindingStatus(scope,supportedExactBinding).code).toBe('exact_match');expect(JSON.stringify(target)).toBe(before);
});

test('direct Canvas transport signs each exact Tower request and empty discovery stays available',async()=>{
 const secret=generateSecretKey(),appNpub=nip19.npubEncode(getPublicKey(secret));
 const scope={installationId:crypto.randomUUID(),canvasId:crypto.randomUUID(),user:'a'.repeat(64),target:{towerUrl:'https://tower.test',workspaceId:crypto.randomUUID(),workspaceOwnerNpub:nip19.npubEncode('b'.repeat(64)),appNpub}};
 const env={BYO_NSEC:nip19.nsecEncode(secret)},seen:{url:string;method:string;payload?:string}[]=[];
 const request=canvasDirect(scope,undefined,env,async(input,init)=>{
  const url=String(input),method=String(init?.method),payload=typeof init?.body==='string'?init.body:undefined;
  const encoded=String((init?.headers as Record<string,string>).authorization).replace(/^Nostr /,''),event=JSON.parse(Buffer.from(encoded,'base64').toString());
  expect(verifyEvent(event)).toBe(true);expect(event.pubkey).toBe(getPublicKey(secret));expect(event.kind).toBe(27235);expect(event.content).toBe('');
  expect(event.tags.filter((t:string[])=>t[0]==='u')).toEqual([['u',url]]);expect(event.tags.filter((t:string[])=>t[0]==='method')).toEqual([['method',method]]);
  expect(event.tags.filter((t:string[])=>t[0]==='payload')).toEqual(payload===undefined?[]:[['payload',sha256(payload)]]);
  expect(init?.redirect).toBe('error');seen.push({url,method,payload});
  if(url.endsWith('/descriptor'))return Response.json({capabilities:{conditional_update:true}});
  if(url.endsWith('/migrations'))return Response.json({migrations:[]});
  return Response.json({rows:[]});
 });
 const store=new CanvasDatasetStore(scope,request);await store.ensure();expect(await store.discovery()).toEqual([]);
 expect(seen.map(call=>[call.url.slice(store.base.length),call.method])).toEqual([['/descriptor','GET'],['/migrations','POST'],['/tables/canvas_dataset_records/query','POST']]);
 expect(canvasBrokerBindingStatus(scope,env)).toMatchObject({code:'exact_match',transport:'direct_nip98',signerNpub:appNpub});
});

test('direct Canvas transport fails closed for missing, invalid, mismatched and disallowed authority',async()=>{
 const secret=generateSecretKey(),other=generateSecretKey(),appNpub=nip19.npubEncode(getPublicKey(secret));
 const scope={installationId:'installation',canvasId:'canvas',user:'a'.repeat(64),target:{towerUrl:'https://tower.test',workspaceId:'workspace',workspaceOwnerNpub:nip19.npubEncode('b'.repeat(64)),appNpub}};
 expect(()=>canvasDirect(scope,undefined,{})).toThrow('configure the backend-only BYO_NSEC');
 expect(()=>canvasDirect(scope,undefined,{BYO_NSEC:'not-a-secret'})).toThrow('BYO_NSEC is invalid');
 const mismatch={BYO_NSEC:nip19.nsecEncode(other)};expect(canvasBrokerBindingStatus(scope,mismatch).code).toBe('signer_target_mismatch');expect(()=>canvasDirect(scope,undefined,mismatch)).toThrow('reauthorization is required');
 const request=canvasDirect(scope,undefined,{BYO_NSEC:nip19.nsecEncode(secret)},async()=>Response.json({}));
 await expect(request('https://foreign.test/api/v4/workspaces/x/apps/y/db/descriptor','GET')).rejects.toThrow('denied');
 await expect(request(`https://tower.test/api/v4/workspaces/${scope.target.workspaceOwnerNpub}/apps/${appNpub}/db/tables/canvas_dataset_records/rows/${'a'.repeat(64)}`,'DELETE')).rejects.toThrow('denied');
});

test('explicit managed loopback capability remains preferred over direct signing',async()=>{
 const scope={installationId:'installation',canvasId:'canvas',user:'a'.repeat(64),target:{towerUrl:'https://tower.test',workspaceId:'workspace',workspaceOwnerNpub:'owner',appNpub:'app'}};
 const env={BYO_NSEC:'invalid-on-purpose',WAPP_TOWER_DB_BROKER_URL:'http://127.0.0.1:1/api/internal/wapps/tower-db',WAPP_TOWER_DB_CAPABILITY:'runtime',WAPP_INSTALLATION_ID:'installation',WAPP_TOWER_URL:'https://tower.test',WAPP_TOWER_WORKSPACE_ID:'workspace',WAPP_TOWER_WORKSPACE_OWNER_NPUB:'owner',WAPP_APP_NPUB:'app'};
 let called='';const request=canvasTransport(scope,undefined,env,async(input,init)=>{called=String(input);expect((init?.headers as Record<string,string>).authorization).toBe('Bearer runtime');return Response.json({ok:true});});
 await request('https://tower.test/api/v4/workspaces/owner/apps/app/db/descriptor','GET');expect(called).toBe(env.WAPP_TOWER_DB_BROKER_URL);
});
