import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { application } from '../src/application.ts';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { installBuilderPrompt, loadBuilderPrompt, obsoleteCapabilityParagraph, nappletCapabilityParagraph, migrateNappletPrompt, requestBuilderPrompt } from '../src/builder-prompt.ts';
import { validateGeneratedHtml } from '../src/pipeline/artifact.ts';
import { injectNappletBridge } from '../src/napplet-runtime.ts';

test('authenticated durable app data isolates session, participant, project and workshop with quota and revocation',async()=>{
 const directory=mkdtempSync(tmpdir()+'/napplet-data-'),secret=generateSecretKey();
 let app=application({dataDir:directory,origin:null,hostPubkey:getPublicKey(secret),version:'test'});
 type Account={cookie:string;csrf:string};
 const origin='http://workshop.test';
 async function call(path:string,body?:any,account?:Account,scope?:string){const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));const raw=await response.text();const data=response.headers.get('content-type')?.includes('text/html')?{documentId:raw.match(/documentId:\s*"([a-f0-9-]{36})"/)?.[1]}:JSON.parse(raw);return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]||''};}
 async function openProject(projectId:string,revisionId:string,account:Account,scope?:string){const preview=await call(`projects/${projectId}/preview?revision=${revisionId}${scope?'&workshop='+scope:''}`,undefined,account,scope);return call('napplet/open',{projectId,revisionId,documentId:preview.data.documentId||'invalid'},account,scope);}
 async function login(key:Uint8Array,identityType='extension'){const c=await call('challenge',{});const r=await call('login',{challengeId:c.data.id,event:finalizeEvent(c.data.event,key),identityType});return {cookie:r.cookie,csrf:r.data.csrf};}
 try {
 const a=await login(secret);const temporarySession=await login(secret,'temporary');expect((await call('me',undefined,temporarySession)).data.member.identity_type).toBe('temporary');expect((await call('me',undefined,a)).data.member.identity_type).toBe('extension');app.db.run("UPDATE room SET admission='open' WHERE id=1");const b=await login(generateSecretKey());
 const p=(await call('projects',{starterId:'game'},a)).data.project;
 const open=await openProject(p.id,p.current_revision,a);expect(open.status).toBe(200);const token=open.data.token;
 const document=(await call(`projects/${p.id}/preview?revision=${p.current_revision}`,undefined,a)).data.documentId;
 expect((await call('napplet/open',{projectId:p.id,revisionId:p.current_revision,documentId:document},b)).status).toBe(403);
 expect((await call('napplet/open',{projectId:p.id,revisionId:'foreign-revision',documentId:document},a)).status).toBe(403);
 expect((await call('napplet/open',{projectId:p.id,revisionId:p.current_revision,documentId:document},a)).status).toBe(200);
 expect((await call('napplet/open',{projectId:p.id,revisionId:p.current_revision,documentId:document},a)).status).toBe(403);

 expect((await call('napplet/data',{token,method:'set',key:'list',value:{items:['one']}},a)).status).toBe(200);
 expect((await call('napplet/data',{token,method:'get',key:'list'},b)).status).toBe(403);
 expect((await call('napplet/data',{token,method:'get',key:'list',user:getPublicKey(secret)},a)).status).toBe(400);
 const own=(await openProject(p.id,p.current_revision,b)).data.token;
 expect((await call('napplet/data',{token:own,method:'get',key:'list'},b)).data.value).toBeNull();
 expect((await call('napplet/data',{token:own,method:'set',key:'list',value:['two']},b)).status).toBe(200);
 expect((await call('napplet/data',{token,method:'get',key:'list'},a)).data.value).toEqual({items:['one']});
 const fork=(await call('projects',{forkProjectId:p.id,idempotencyKey:'latest-saved'},b));expect(fork.status).toBe(201);
 expect(fork.data.project.origin_revision).toBe(p.current_revision);
 const q=(await call('projects',{starterId:'game'},b)).data.project;
 const other=(await openProject(q.id,q.current_revision,b)).data.token;
 expect((await call('napplet/data',{token:other,method:'get',key:'list'},b)).data.value).toBeNull();
 expect((await openProject(p.id,q.current_revision,a)).status).toBe(403);
 for(const key of ['', '../bad key', 'x'.repeat(129)])expect((await call('napplet/data',{token,method:'set',key,value:1},a)).status).toBe(400);
 expect((await call('napplet/data',{token,method:'set',key:'large',value:'x'.repeat(32768)},a)).status).toBe(413);
 for(let i=0;i<7;i++)expect((await call('napplet/data',{token,method:'set',key:'quota'+i,value:'x'.repeat(32000)},a)).status).toBe(200);
 expect((await call('napplet/data',{token,method:'set',key:'overflow',value:'x'.repeat(32000)},a)).status).toBe(200);
 expect((await call('napplet/data',{token,method:'set',key:'overflow2',value:'x'.repeat(32000)},a)).status).toBe(413);
 const w=(await call('site/workshops',{title:'Different'},a)).data;
 expect((await call('napplet/data',{token,method:'get',key:'list'},a,w.id)).status).toBe(403);
 expect((await openProject(p.id,p.current_revision,a,w.id)).status).toBe(403);
 app.db.close();app=application({dataDir:directory,origin:null,hostPubkey:getPublicKey(secret),version:'test'});
 expect((await call('napplet/data',{token,method:'get',key:'list'},a)).status).toBe(403);
 const reopened=(await openProject(p.id,p.current_revision,a)).data.token;
 expect((await call('napplet/data',{token:reopened,method:'get',key:'list'},a)).data.value).toEqual({items:['one']});
 expect((await call('napplet/data',{token:reopened,method:'remove',key:'list'},a)).status).toBe(200);
 expect((await call('napplet/data',{token:reopened,method:'get',key:'list'},a)).data.value).toBeNull();
 await call('logout',{},a);expect((await call('napplet/data',{token:reopened,method:'get',key:'quota0'},a)).status).toBe(401);
 }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('prompt migration replaces only the literal obsolete paragraph and preserves queued snapshots',()=>{
 const directory=mkdtempSync(tmpdir()+'/napplet-prompts-');const app=application({dataDir:directory,origin:null,hostPubkey:null,version:'test'});
 try {
 const original='Custom prefix\n\n'+obsoleteCapabilityParagraph+'\n\nCustom suffix';app.db.run('UPDATE builder_prompt SET text=?',[original]);const before=loadBuilderPrompt(app.db);
 const pubkey='a'.repeat(64);app.db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,'Test','extension','admitted',1)",[pubkey]);
 const member=app.workshop.scoped(app.auth.member(pubkey)),project=app.workshop.create(member,'game').project;
 const request=app.workshop.request(member,project.id,{requestId:'snapshot-before-migration',prompt:'hello',expectedRevisionId:project.current_revision},false) as any;
 const snapshot=requestBuilderPrompt(app.db,request.id);expect(snapshot?.text).toBe(original);
 installBuilderPrompt(app.db);const migrated=loadBuilderPrompt(app.db);expect(migrated.text).toBe(original.replace(obsoleteCapabilityParagraph,nappletCapabilityParagraph));expect(migrated.revision).toBe(before.revision+1);expect(requestBuilderPrompt(app.db,request.id)).toEqual(snapshot);installBuilderPrompt(app.db);expect(loadBuilderPrompt(app.db)).toEqual(migrated);
 const full='x'.repeat(16000-obsoleteCapabilityParagraph.length)+obsoleteCapabilityParagraph;app.db.run('UPDATE builder_prompt SET text=?',[full]);installBuilderPrompt(app.db);expect(loadBuilderPrompt(app.db).text).toBe(full.replace(obsoleteCapabilityParagraph,nappletCapabilityParagraph));expect(loadBuilderPrompt(app.db).text.length).toBeLessThanOrEqual(16000);
 const custom=obsoleteCapabilityParagraph.replace('currently','presently');app.db.run('UPDATE builder_prompt SET text=?',[custom]);installBuilderPrompt(app.db);expect(loadBuilderPrompt(app.db).text).toBe(custom);
 const id=app.site.legacy();app.db.run('INSERT INTO workshop_prompts VALUES(?,?,?,?,?)',[id,1,original,'Custom Agent',1]);migrateNappletPrompt(app.db,'workshop_prompts');const row=app.db.query('SELECT * FROM workshop_prompts').get() as any;expect(row.text).toBe(migrated.text);expect(row.agent_name).toBe('Custom Agent');
 // The migration never touches request_builder_prompts/dispatch/epoch tables.
 const triggers=app.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'request_prompt_%'").all();expect(triggers.length).toBe(2);
 }finally{app.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('validator permits inline APIs and direct service calls while active embedding stays forbidden; injection precedes scripts in standards mode',()=>{
 const html='<!doctype html><html><head><script>fetch("https://api.example/data");new WebSocket("wss://socket.example");napplet.storage.set("key",{ok:true})</script></head><body></body></html>';
 expect(validateGeneratedHtml(html)).toBe(html);const served=injectNappletBridge(html,'test-document');expect(served.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);expect(injectNappletBridge('<!-- Intro -->'+html,'test-document').startsWith('<!-- Intro --><!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);expect(served.indexOf("Object.defineProperty(window,'napplet'")).toBeLessThan(served.indexOf('napplet.storage.set'));
 for(const source of ['<html><iframe></iframe></html>','<html><script src="https://evil.test/x.js"></script></html>','<html><script src="/host.js"></script></html>','<html><link rel="stylesheet" href="/host.css"></html>','<html><form action="https://evil.test/"></form></html>'])expect(()=>validateGeneratedHtml(source)).toThrow();
});
