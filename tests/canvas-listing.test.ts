import {test,expect,beforeEach,afterEach} from 'bun:test';
import {application} from '../src/application.ts';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {mkdtempSync,rmSync} from 'node:fs';

const origin='https://canvas-list.test';
let app:ReturnType<typeof application>,dir:string,hostKey:Uint8Array;
type Account={cookie:string;csrf:string;member:any};
async function call(path:string,account?:Account,body?:any,scope=''){
 const response=await app.handle(new Request(origin+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...(account?{cookie:account.cookie,'x-csrf-token':account.csrf}:{}),...(scope?{'x-workshop-id':scope}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.text(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function login(key=generateSecretKey()):Promise<Account>{const challenge=(await call('challenge',undefined,{})).data,response=await call('login',undefined,{challengeId:challenge.id,event:finalizeEvent(challenge.event,key),identityType:'extension',name:'Canvas viewer'});return{cookie:response.cookie!,csrf:response.data.csrf,member:response.data.member};}
beforeEach(()=>{dir=mkdtempSync('/tmp/freedom-canvas-list-');hostKey=generateSecretKey();app=application({origin,hostPubkey:getPublicKey(hostKey),dataDir:dir,version:'canvas-list-test'});});
afterEach(()=>{app.db.close();rmSync(dir,{recursive:true,force:true});});

test('Canvas listings expose truthful counts only to members who can list that Canvas',async()=>{
 const admin=await login(hostKey),member=await login(),outsider=await login();
 const canvas=(await call('site/workshops',admin,{title:'Visual planning',introduction:'Plan together',owner:member.member.pubkey})).data;
 await call('workshops/join',member,{},canvas.id);await call('host/settings',member,{title:'Visual planning',introduction:'Plan together',admission:'open',paused:false,lightning:''},canvas.id);
 const project=(await call('projects',member,{starterId:'spinner'},canvas.id)).data.project;
 const room=(await call('room',member,undefined,canvas.id)).data;
 const listed=(await call('workshops',member)).data.workshops.find((item:any)=>item.id===canvas.id);
 expect(listed.overview).toEqual({nappletCount:1,decorationCount:0});
 expect(JSON.stringify(listed.overview)).not.toContain('conversation');expect(JSON.stringify(listed.overview)).not.toContain('prompt');
 expect((await call('workshops',outsider)).data.workshops.some((item:any)=>item.id===canvas.id)).toBe(false);
 app.db.run("UPDATE workshop_boards SET objects_json='not-json' WHERE workshop_id=?",[canvas.id]);
 const recovered=(await call('workshops',member)).data.workshops.find((item:any)=>item.id===canvas.id).overview;
 expect(recovered).toEqual({nappletCount:1,decorationCount:0});expect(room.board.napplets).toHaveLength(1);
});

test('Canvas listing journey uses the simplified name and stable decorative cover art',async()=>{
 const source=await Bun.file('public/app.js').text(),listing=source.match(/function workshopsMarkup\(\)[^\n]+/)![0];
 expect(listing).toContain('<h1>Canvases</h1>');expect(listing).toContain('canvasOverviewMarkup(w)');expect(listing).toContain('Create Canvas');expect(listing).toContain('Open Canvas');expect(listing).not.toContain('BYOF Canvas');
 const setup=source.match(/function renderCanvasSetup\(\)\{[\s\S]*?\n\}/)![0];expect(setup).toContain('1. Create Canvas');expect(setup).toContain('Connect an NStack backend');expect(setup).not.toContain('Choose a Tower');
 expect(setup).toContain('Dataset discovery is blocked by an exact managed-binding mismatch.');expect(setup).toContain('Canvas destination: <code>');expect(setup).toContain('Managed dataset broker: <code>');expect(setup).toContain('Keep this Canvas on its selected destination.');expect(setup).toContain('Do not reconnect this Canvas to the broker’s other backend.');
 expect(source.match(/function joinCodeForm\(\)\{[^\n]+\}/)![0]).toContain('>Canvas Code</label>');
 const cover=source.match(/function canvasOverviewMarkup\(workshop\) \{[\s\S]*?\n\}/)![0];expect(cover).toContain('data-cover-seed');expect(cover).toContain('not a content preview');expect(cover).toContain('<svg class="canvas-cover-art"');expect(cover).not.toContain('<image');
});

test('Canvas list startup renders before refresh and cannot hang forever',async()=>{
 const source=await Bun.file('public/app.js').text(),page=source.match(/async function workshopsPage\(\) \{[\s\S]*?\n\}/)![0],markup=source.match(/function workshopsMarkup\(\)[^\n]+/)![0];
 expect(page.indexOf("screen='workshops'")).toBeLessThan(page.indexOf("await api('workshops'"));
 expect(page).toContain('cachedWorkshops()');expect(page).toContain('AbortSignal.timeout(5000)');expect(page).toContain('workshopsLoadError=');
 expect(markup).toContain('Loading Canvases…');expect(markup).toContain("button('refresh-workshops','Try again')");
});
