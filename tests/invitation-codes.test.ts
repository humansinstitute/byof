import {test,expect,beforeEach,afterEach} from 'bun:test';
import {application} from '../src/application.ts';
import {sha256} from '../src/assets.ts';
import {codeAttempt} from '../src/invitation-codes.ts';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {mkdtempSync,rmSync} from 'node:fs';
const origin='https://codes.test';let app:ReturnType<typeof application>,dir:string,key:Uint8Array;
type Account={cookie:string;csrf:string;member:any};
async function call(path:string,a?:Account,body?:any,scope?:string){const r=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(a?{cookie:a.cookie,'x-csrf-token':a.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function login(secret=generateSecretKey(),invitation?:any){const challenge=(await call('challenge',undefined,{})).data;const r=await call('login',undefined,{challengeId:challenge.id,event:finalizeEvent(challenge.event,secret),identityType:'extension',name:'Code participant',...(invitation===undefined?{}:{invitation})});return{...r,cookie:r.cookie!,csrf:r.data.csrf,member:r.data.member};}
async function workshop(host:Account){return(await call('site/workshops',host,{title:'Private code room',introduction:'Private',owner:host.member.pubkey})).data.id as string;}
async function invite(host:Account,scope?:string,uses=1){const r=await call('host/invitations',host,{uses,shortCode:true},scope);expect(r.status).toBe(200);expect(r.data.code).toMatch(/^\d{6}$/);expect(r.data.url).toBe(origin+'/?code='+r.data.code);expect(r.data.qr).toStartWith('data:image/gif;base64,');return r.data;}
beforeEach(()=>{dir=mkdtempSync('/tmp/freedom-codes-');key=generateSecretKey();app=application({origin,hostPubkey:getPublicKey(key),dataDir:dir,version:'codes'});});
afterEach(()=>{app.db.close();rmSync(dir,{recursive:true,force:true});});
test('workshop-bound short invites atomically redeem, select target and admit existing pending members',async()=>{
 const host=await login(key),a=await login(),b=await login(),scope=await workshop(host);
 expect((await call('workshops/join',a,{},scope)).data.member.state).toBe('pending');
 const code=await invite(host,scope);
 expect((await call('workshops/join',a,{invitation:code.code})).status).toBe(403); // wrong room
 const results=await Promise.all([call('workshops/redeem-code',a,{code:code.code}),call('workshops/redeem-code',b,{code:code.code})]);expect(results.map(r=>r.status).sort()).toEqual([200,403]);
 const winner=results[0].status===200?a:b;expect(results.find(r=>r.status===200)!.data).toMatchObject({workshopId:scope,member:{state:'admitted',workshopId:scope}});
 expect((await call('room',winner,undefined,scope)).data.board).toBeDefined();expect((await call('room',winner)).data.board).toBeUndefined();
 const rows=app.db.query('SELECT * FROM invitations').all();expect(JSON.stringify(rows)).not.toContain(code.code);expect((rows[0] as any).remaining).toBe(0);
 const legacy=await invite(host);const pending=await login();expect(pending.member.state).toBe('pending');expect((await call('workshops/redeem-code',pending,{code:legacy.code})).data.member.state).toBe('admitted');
});
test('expiry, exhaustion, bans, host/CSRF gates and malformed code bodies cannot confer access',async()=>{
 const host=await login(key),a=await login(),scope=await workshop(host),code=await invite(host,scope);
 expect((await call('host/invitations',a,{uses:1,shortCode:true},scope)).status).toBe(403);
 expect((await call('workshops/redeem-code',undefined,{code:code.code})).status).toBe(401);
 expect((await call('workshops/redeem-code',{...a,csrf:'wrong'},{code:code.code})).status).toBe(403);
 for(const value of [123456,[code.code],{code:code.code},'12','not-a-code'])expect((await call('workshops/redeem-code',a,{code:value})).status).toBe(400);
 app.db.run('UPDATE invitations SET expires_at=0 WHERE hash=?',[sha256(code.code)]);expect((await call('workshops/redeem-code',a,{code:code.code})).status).toBe(403);
 const fresh=await invite(host,scope);await call('workshops/join',a,{},scope);await call('host/members/'+a.member.pubkey,host,{state:'banned',allowance:20},scope);
 expect((await call('workshops/redeem-code',a,{code:fresh.code})).status).toBe(403);expect((app.db.query('SELECT remaining FROM invitations WHERE hash=?').get(sha256(fresh.code)) as any).remaining).toBe(1);
});
test('whitespace normalization cannot bypass join attempt limits or direct sign-in restrictions',async()=>{
 const host=await login(key),a=await login(),code=await invite(host);let guessed='111111';if(code.code===guessed)guessed='222222';
 for(let i=0;i<10;i++)expect((await call('workshops/join',a,{invitation:' '+guessed+' '})).status).toBe(403);
 expect((await call('workshops/join',a,{invitation:' '+code.code+' '})).status).toBe(429);expect((await call('workshops/redeem-code',a,{code:code.code})).status).toBe(429);
 for(const invitation of [' '+code.code+' ',[code.code],{value:code.code},123456])expect((await login(generateSecretKey(),invitation)).status).toBe(400);
 const b=await login();expect((await call('workshops/join',b,{invitation:' '+code.code+' '})).status).toBe(200);
});
test('global attempts survive restart, cap newly created identities, and active codes do not collide',async()=>{
 const host=await login(key);const codes=new Set<string>();for(let i=0;i<20;i++)codes.add((await invite(host)).code);expect(codes.size).toBe(20);
 codeAttempt(app.db,host.member.pubkey);app.db.run("UPDATE invitation_attempts SET attempts=299 WHERE actor='installation'");
 const a=await login();expect((await call('workshops/redeem-code',a,{code:'000000'})).status).toBe(403);
 app.db.close();app=application({origin,hostPubkey:getPublicKey(key),dataDir:dir,version:'restart'});
 const b=await login();expect((await call('workshops/redeem-code',b,{code:[...codes][0]})).status).toBe(429);
});
