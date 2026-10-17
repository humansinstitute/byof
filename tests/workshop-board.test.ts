import {test,expect,beforeEach,afterEach} from 'bun:test';
import {application} from '../src/application.ts';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {mkdtempSync,rmSync} from 'node:fs';
import {sha256} from '../src/assets.ts';
const origin='https://board.test';
let app:ReturnType<typeof application>,dir:string,hostKey:Uint8Array;
type Account={cookie:string;csrf:string;member:any};
async function call(path:string,account?:Account,body?:any,headers:any={}) {
  const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {cookie:response.headers.get('set-cookie')?.split(';')[0],status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text()};
}
async function login(key=generateSecretKey()):Promise<Account>{const c=(await call('challenge',undefined,{})).data;const r=await call('login',undefined,{challengeId:c.id,event:finalizeEvent(c.event,key),identityType:'extension',name:'Board test'});expect(r.status).toBe(200);return{cookie:r.cookie!,csrf:r.data.csrf,member:r.data.member};}
async function setup(){const host=await login(hostKey);await call('host/settings',host,{title:'Board',introduction:'Test',admission:'open',lightning:'',paused:false});return{host,a:await login(),b:await login()};}
async function create(a:Account,starterId='game'){return(await call('projects',a,{starterId})).data.project;}
const room=async(a:Account)=>(await call('room',a)).data;
beforeEach(()=>{dir=mkdtempSync('/tmp/freedom-board-');hostKey=generateSecretKey();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'board-test'});});
afterEach(()=>{app.db.close();rmSync(dir,{recursive:true,force:true});});
test('active board follows completed checkpoints, excludes hidden/banned and exposes no private records',async()=>{
 const {host,a,b}=await setup(),p=await create(a);let board=(await room(b)).board;
 expect(board.napplets.map((p:any)=>p.id)).toEqual([p.id]);expect(board.napplets[0].current_revision).toBe(p.current_revision);
 expect(JSON.stringify(board)).not.toContain('conversation_id');expect(JSON.stringify(board)).not.toContain('prompt');
 expect((await call('projects/'+p.id,b)).status).toBe(404);
 expect((await call(`projects/${p.id}/preview?revision=${p.current_revision}`,b)).status).toBe(200);
 const hash=app.workshop.assets.put('<html><body>Latest completed</body></html>');
 const latest=app.workshop.addRevision(p,hash,a.member.pubkey);
 expect((await room(b)).board.napplets[0].current_revision).toBe(latest);
 expect((await call(`projects/${p.id}/preview?revision=${p.current_revision}`,b)).status).toBe(404);
 // Running/failed build requests do not advance the saved source.
 app.db.run("INSERT INTO requests(id,project_id,prompt,expected_revision,status,created_at) VALUES(?,?,?,?,?,?)",['building',p.id,'private instruction',latest,'building',1]);
 expect((await room(b)).board.napplets[0].current_revision).toBe(latest);
 expect((await call(`projects/${p.id}/preview?revision=${latest}`,b)).data).toContain('Latest completed');
 await call('host/projects/'+p.id,host,{hidden:true});expect((await room(b)).board.napplets).toEqual([]);expect((await call(`projects/${p.id}/preview?revision=${latest}`,b)).status).toBe(404);
 await call('host/projects/'+p.id,host,{hidden:false});await call('host/members/'+a.member.pubkey,host,{state:'banned',allowance:20});
 await call('host/projects/'+p.id,host,{hidden:false});expect((await room(b)).board.napplets).toEqual([]);expect((await call(`projects/${p.id}/preview?revision=${latest}`,b)).status).toBe(404);
 expect((await room(a)).board).toBeUndefined();
});
test('payload bytes stay immutable while every runtime load rechecks access and issues a fresh document binding',async()=>{
 const {host,a,b}=await setup(),p=await create(a),source=app.workshop.preview(app.auth.member(a.member.pubkey),p.id,p.current_revision);
 const route=`projects/${p.id}`,query=`?workshop=${app.site.legacy()}&revision=${p.current_revision}`;
 const one=await call(route+'/runtime'+query,b),two=await call(route+'/runtime'+query,b);
 expect(one.status).toBe(200);expect(two.status).toBe(200);expect(one.data).toContain('freedom-napplet-source-request');expect(one.data).toContain(sha256(source));
 const binding=(html:string)=>{const encoded=html.match(/injection=atob\("([^"]+)"\)/)?.[1];expect(encoded).toBeTruthy();return Buffer.from(encoded!,'base64').toString().match(/documentId:("[^"]+")/)?.[1];};
 expect(binding(one.data)).toBeTruthy();expect(binding(one.data)).not.toBe(binding(two.data));expect(one.data).not.toContain(b.cookie);
 const payload=await app.handle(new Request(origin+'/api/v1/'+route+'/payload'+query,{headers:{cookie:b.cookie,'x-workshop-id':app.site.legacy()}}));
 expect(payload.status).toBe(200);expect(payload.headers.get('cache-control')).toBe('no-store');expect(payload.headers.get('x-napplet-source-sha256')).toBe(sha256(source));expect(await payload.text()).toBe(source);
 await call('host/projects/'+p.id,host,{hidden:true});expect((await call(route+'/runtime'+query,b)).status).toBe(404);
 await call('host/projects/'+p.id,host,{hidden:false});await call('host/members/'+a.member.pubkey,host,{state:'banned',allowance:20});expect((await call(route+'/runtime'+query,b)).status).toBe(404);
 await call('host/members/'+a.member.pubkey,host,{state:'admitted',allowance:20});app.db.run('UPDATE sessions SET expires_at=0 WHERE pubkey=?',[b.member.pubkey]);expect((await call(route+'/runtime'+query,b)).status).toBe(401);
});
test('only genuine scoped hosts can persist layout; CAS rejects simultaneous and stale saves; personal fields never enter storage',async()=>{
 const {host,a,b}=await setup();await create(a);const board=(await room(host)).board;
 const group={id:crypto.randomUUID(),kind:'group',label:'Planning',x:0,y:0,width:960,height:560,groupId:null};
 const objects=[...board.objects.map((o:any)=>({...o,x:123,y:234,width:500,height:500,groupId:group.id,focus:true,minimized:true})),group,{id:crypto.randomUUID(),kind:'text',text:'Next steps',x:1000,y:20,width:300,height:200,groupId:null},{id:crypto.randomUUID(),kind:'image',src:'https://example.com/photo.png',label:'Workshop photo',x:1000,y:250,width:300,height:200,groupId:null}];
 const body={expectedVersion:board.version,objects,viewport:{scale:.5}};
 expect((await call('board',a,body)).status).toBe(403);expect((await call('board',b,{...body,host:true,admin:true})).status).toBe(403);
 expect((await call('board',host,body,{'x-csrf-token':'wrong'})).status).toBe(403);expect((await call('board',undefined,body)).status).toBe(401);
 const results=await Promise.all([call('board',host,body),call('board',host,body)]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 const saved=(await room(b)).board;expect(saved.objects[0]).toMatchObject({x:123,y:234,width:500,height:500,groupId:group.id});
 expect(JSON.stringify(saved.objects)).not.toContain('focus');expect(JSON.stringify(saved.objects)).not.toContain('minimized');expect(JSON.stringify(saved)).not.toContain('viewport');
 const original=JSON.stringify(saved.objects);app.db.close();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'test'});expect(JSON.stringify((await room(host)).board.objects)).toBe(original);
 expect((await call('board',host,body)).status).toBe(409);
});
test('new apps seed stable nonoverlapping placements; hidden placements retained; groups and geometry strictly bounded',async()=>{
 const {host,a,b}=await setup(),p=await create(a),first=(await room(host)).board;
 await call('board',host,{expectedVersion:first.version,objects:first.objects.map((o:any)=>({...o,x:100,y:100,width:900,height:800}))});
 const q=await create(b),board=(await room(host)).board,one=board.objects.find((o:any)=>o.id===p.id),two=board.objects.find((o:any)=>o.id===q.id);
 expect((await call('board',host,{expectedVersion:first.version+1,objects:[one]})).status).toBe(409);
 expect(one).toMatchObject({x:100,y:100,width:900,height:800});expect(two.x>=1000||two.y>=900||two.x+two.width<=100||two.y+two.height<=100).toBe(true);
 expect((await room(host)).board).toEqual(board);
 for(const override of [{x:Infinity},{width:0},{height:5000},{groupId:'missing'},{projectId:crypto.randomUUID()},{kind:'widget'}])expect((await call('board',host,{expectedVersion:board.version,objects:board.objects.map((o:any,i:number)=>o.id===p.id?{...o,...override}:o)})).status).toBe(400);
 expect((await call('board',host,{expectedVersion:board.version,objects:board.objects.slice(1)})).status).toBe(400);
 expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,board.objects[0]]})).status).toBe(400);
 for(const src of ['javascript:alert(1)','data:image/svg+xml,test','https://127.0.0.1/x.png','https://10.0.0.1/x.png','https://example.com/a.svg','https://u:p@example.com/x.png'])expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{id:crypto.randomUUID(),kind:'image',src,label:'test',x:0,y:0,width:300,height:200,groupId:null}]})).status).toBe(400);
 expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{id:crypto.randomUUID(),kind:'text',text:'x'.repeat(4001),x:0,y:0,width:300,height:200,groupId:null}]})).status).toBe(400);
 await call('host/projects/'+p.id,host,{hidden:true});const hidden=(await room(host)).board;
 expect(hidden.objects.some((o:any)=>o.id===p.id)).toBe(false);await call('board',host,{expectedVersion:hidden.version,objects:hidden.objects});
 await call('host/projects/'+p.id,host,{hidden:false});expect((await room(host)).board.objects.find((o:any)=>o.id===p.id)).toEqual(one);
});
test('workshop boundaries remain independent while the scoped host can edit participant apps',async()=>{
 const {host,a,b}=await setup(),p=await create(a);
 const created=(await call('site/workshops',host,{title:'Other',owner:a.member.pubkey,introduction:'Test'})).data.workshop;
 // Site API returns workshop directly in a wrapper.
 const id=created?.id||(await call('workshops',host)).data.workshops.find((w:any)=>w.title==='Other').id;
 const headers={'x-workshop-id':id};
 expect((await call(`projects/${p.id}/preview?revision=${p.current_revision}`,b,undefined,headers)).status).toBe(403);
 await call('workshops/join',a,{},headers);await call('host/settings',a,{title:'Other',introduction:'Test',paused:false,admission:'open',lightning:''},headers);await call('workshops/join',b,{},headers);
 expect((await call(`projects/${p.id}/preview?revision=${p.current_revision}`,b,undefined,headers)).status).toBe(404);
 const other=(await call('projects',b,{starterId:'game'},headers)).data.project;
 const board=(await call('room',a,undefined,headers)).data.board;
 expect((await call('board',b,{expectedVersion:board.version,objects:board.objects},headers)).status).toBe(403);
 expect((await call('board',a,{expectedVersion:board.version,objects:board.objects},headers)).status).toBe(200);
 expect((await call('projects/'+other.id+'/rename',a,{title:'Host managed app'},headers)).status).toBe(200);
 expect((await call('board',a,{expectedVersion:0,objects:[]},{'x-workshop-id':app.site.legacy()})).status).toBe(403);
});

test('unbuilt active app remains visible as metadata without a preview, until a completed checkpoint appears',async()=>{
 const {host,a,b}=await setup(),p=await create(a,'blank');const source=p.current_revision;
 app.db.run('UPDATE projects SET current_revision=NULL WHERE id=?',[p.id]);
 const unbuilt=(await room(b)).board;expect(unbuilt.napplets[0].current_revision).toBeNull();expect(unbuilt.objects.find((o:any)=>o.kind==='napplet').projectId).toBe(p.id);
 expect((await call(`projects/${p.id}/preview?revision=${source}`,b)).status).toBe(404);
 app.db.run('UPDATE projects SET current_revision=? WHERE id=?',[source,p.id]);expect((await room(b)).board.napplets[0].current_revision).toBe(source);
 expect((await call(`projects/${p.id}/preview?revision=${source}`,b)).status).toBe(200);
});

test('uploaded raster bytes are immutable, bounded, host-only and scoped to admitted workshop members',async()=>{
 const {host,a,b}=await setup();
 // Real Chrome canvas output, 1x1 PNG, not an app source or external URL.
 const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==';
 expect((await call('board/images',a,{base64})).status).toBe(403);expect((await call('board/images',undefined,{base64})).status).toBe(401);
 const uploaded=await call('board/images',host,{base64});expect(uploaded.status).toBe(201);expect(uploaded.data).toMatchObject({mime:'image/png',width:1,height:1});
 expect((await call('board/images',host,{base64})).data).toEqual(uploaded.data);
 const path='board/images/'+uploaded.data.sha256;
 const image=await app.handle(new Request(origin+'/api/v1/'+path,{headers:{cookie:b.cookie}}));expect(image.status).toBe(200);expect(image.headers.get('content-type')).toBe('image/png');expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe(base64);expect((await call(path)).status).toBe(401);
 const board=(await room(host)).board,object={id:crypto.randomUUID(),kind:'image',src:uploaded.data.src,label:'Stored image',x:0,y:0,width:300,height:200,groupId:null};
 expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,object]})).status).toBe(200);
 for(const body of [{base64:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')},{base64,workshopId:crypto.randomUUID()},{base64:base64.slice(0,-8)},{base64:'a'.repeat(240004)}])expect((await call('board/images',host,body)).status).toBe(400);
 const corrupt=Buffer.from(base64,'base64');corrupt[20]=1;expect((await call('board/images',host,{base64:corrupt.toString('base64')})).status).toBe(400);
 const other=(await call('site/workshops',host,{title:'Image boundary',owner:host.member.pubkey,introduction:'Test'})).data.workshop;
 const id=other?.id||(await call('workshops',host)).data.workshops.find((w:any)=>w.title==='Image boundary').id;
 expect((await call(path,b,undefined,{'x-workshop-id':id})).status).toBe(403);
 expect((await call(path,host,undefined,{'x-workshop-id':id})).status).toBe(404);
 const otherBoard=(await call('room',host,undefined,{'x-workshop-id':id})).data.board;
 expect((await call('board',host,{expectedVersion:otherBoard.version,objects:[...otherBoard.objects,object]},{'x-workshop-id':id})).status).toBe(400);
 app.db.close();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'reloaded'});const persisted=await app.handle(new Request(origin+'/api/v1/'+path,{headers:{cookie:b.cookie}}));expect(Buffer.from(await persisted.arrayBuffer()).toString('base64')).toBe(base64);
});

test('font sizes and builtin donation placement retain server host validation and required layout objects',async()=>{
 const {host,a}=await setup(),board=(await room(host)).board;
 const donation=board.objects.find((o:any)=>o.kind==='donation');expect(donation.id).toBe('workshop-donation');
 expect((await call('board',host,{expectedVersion:board.version,objects:board.objects.filter((o:any)=>o.kind!=='donation')})).status).toBe(400);
 const object={id:crypto.randomUUID(),kind:'text',text:'Inline text',fontSize:48,x:0,y:0,width:300,height:200,groupId:null};
 for(const fontSize of [0,11,145,'48',48.5])expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{...object,fontSize}]})).status).toBe(400);
 expect((await call('board',a,{expectedVersion:board.version,objects:[...board.objects,object]})).status).toBe(403);
 expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,object]})).status).toBe(200);
 expect((await room(a)).board.objects.find((o:any)=>o.id===object.id).fontSize).toBe(48);
});

test('text effects and arrows persist with strict typed validation and legacy text compatibility',async()=>{
 const {host,a}=await setup();let board=(await room(host)).board;
 const base={id:crypto.randomUUID(),kind:'text',text:'Styled',x:0,y:0,width:300,height:100,groupId:null};
 for(const effect of ['bold','italic','underline','shadow'])expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{...base,[effect]:'true'}]})).status).toBe(400);
 const arrow={id:crypto.randomUUID(),kind:'arrow',x:300,y:400,endX:-200,endY:100,width:200,height:100,groupId:null};
 for(const override of [{endX:null},{endY:Infinity},{endX:5000},{width:300},{endX:1,endY:1,width:1,height:1}])expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{...arrow,...override}]})).status).toBe(400);
 const objects=[...board.objects,{...base,bold:true,italic:true,underline:true,shadow:true},arrow];
 expect((await call('board',a,{expectedVersion:board.version,objects})).status).toBe(403);
 expect((await call('board',host,{expectedVersion:board.version,objects})).status).toBe(200);
 board=(await room(a)).board;expect(board.objects.find((o:any)=>o.id===base.id)).toMatchObject({bold:true,italic:true,underline:true,shadow:true,fontSize:24});expect(board.objects.find((o:any)=>o.id===arrow.id)).toEqual(arrow);
 app.db.close();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'effects'});expect((await room(host)).board.objects).toEqual(board.objects);
});

test('arrow styles and curve points validate and persist without accepting arbitrary CSS',async()=>{
 const {host,a}=await setup();let board=(await room(host)).board;
 const arrow={id:crypto.randomUUID(),kind:'arrow',x:0,y:0,endX:200,endY:0,width:200,height:1,groupId:null,colour:'#EA4411',dotted:true,curveX:100,curveY:-150};
 for(const override of [{colour:'red'},{colour:'#fff'},{colour:'url(https://evil)'},{dotted:'yes'},{curveX:undefined},{curveY:Infinity},{curveY:-4001},{x:50000,curveX:1}])expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,{...arrow,...override}]})).status).toBe(400);
 expect((await call('board',host,{expectedVersion:board.version,objects:[...board.objects,arrow]})).status).toBe(200);
 board=(await room(a)).board;expect(board.objects.find((o:any)=>o.id===arrow.id)).toMatchObject({...arrow,colour:'#ea4411'});
 expect((await call('board',a,{expectedVersion:board.version,objects:board.objects})).status).toBe(403);
});
