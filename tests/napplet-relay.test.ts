import {test,expect} from 'bun:test';
import {finalizeEvent,verifyEvent} from 'nostr-tools';
import {Database} from 'bun:sqlite';
import {migrateNappletPrompt,obsoleteNoRelayParagraph,obsoleteNetworkCapabilityParagraph,nappletCapabilityParagraph,builderPromptMaxChars} from '../src/builder-prompt.ts';
const source=await Bun.file('public/napplet-host.js').text();
const relay:any=new Function(source.slice(source.indexOf('// Fixed public registry')).replaceAll('export ','')+';return {APPROVED_RELAYS,validateRelayOptions,validRelayEvent,relayEventMatches,createRelayPool};')();
const key=new Uint8Array(32).fill(1);
const signed=(content='safe <script>text</script>',tags=[['t','bussobushbash']],time=1700000000)=>finalizeEvent({kind:1,created_at:time,tags,content},key);
test('strict NIP-01 filters and exact public registry; no generic network',()=>{
 const good={filters:[{kinds:[1],'#t':['bussobushbash'],limit:1}]};expect(relay.validateRelayOptions(good).relays).toEqual(relay.APPROVED_RELAYS);
 for(const relays of [['ws://127.0.0.1'],['wss://relay.damus.io/'],['wss://nos.lol@127.0.0.1'],['wss://nos.lol/private'],['wss://purplepag.es']])expect(()=>relay.validateRelayOptions({...good,relays})).toThrow();
 for(const filters of [[],[{} ,{}, {},{},{}],[{authors:['abc']}],[{'#t':[]}],[{search:'x'}],[{limit:101}],[{since:2,until:1}],[{kinds:[65536]}],[{'#word':['x']}],[{ids:['A'.repeat(64)]}]])expect(()=>relay.validateRelayOptions({filters})).toThrow();
 expect(relay.validateRelayOptions({filters:[{limit:0}]}).filters[0].limit).toBe(0);
 const e=signed();expect(relay.validRelayEvent(e,good.filters,verifyEvent)).toBe(true);expect(relay.validRelayEvent({...e,content:'changed'},good.filters,verifyEvent)).toBe(false);expect(relay.validRelayEvent(signed('wrong',[['t','other']]),good.filters,verifyEvent)).toBe(false);
 expect(relay.relayEventMatches(e,[{since:e.created_at,until:e.created_at,'#t':['bussobushbash']}])).toBe(true);
 expect(relay.relayEventMatches(e,[{authors:['b'.repeat(64)]},{kinds:[1]}])).toBe(true);
 expect(relay.validRelayEvent(signed('x'.repeat(17000)),good.filters,verifyEvent)).toBe(false);
});
class FixtureSocket {
 static sockets:FixtureSocket[]=[];readyState=0;sent:any[]=[];onopen:any;onmessage:any;onclose:any;onerror:any;
 constructor(public url:string){FixtureSocket.sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
 send(text:string){const msg=JSON.parse(text);this.sent.push(msg);if(msg[0]==='REQ'){for(const e of [signed(),signed(),{...signed('forged'),sig:'0'.repeat(128)},signed('wrong',[['t','other']]),signed('second',undefined,1700000001)])this.onmessage?.({data:JSON.stringify(['EVENT',msg[1],e])});this.onmessage?.({data:JSON.stringify(['EOSE',msg[1]])});}}
 close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
}
test('bounded historical query enforces limit even if relay ignores it, verifies/filter/deduplicates',async()=>{
 const pool=relay.createRelayPool(verifyEvent,FixtureSocket),h=pool.query({filters:[{kinds:[1],'#t':['bussobushbash'],limit:1}],relays:['wss://nos.lol']});
 const result=await h.promise;expect(result.events.length).toBe(1);expect(result.events[0].content).toBe("second");expect(result.complete).toBe(true);expect(result.truncated).toBe(true);expect(FixtureSocket.sockets.at(-1)!.sent.map(m=>m[0])).toEqual(['REQ','CLOSE']);
});
test('live subscription delivers post-EOSE event and closes socket; frame-independent capacity is released',async()=>{
 const pool=relay.createRelayPool(verifyEvent,FixtureSocket),messages:any[]=[];const h=pool.subscribe({filters:[{kinds:[1],'#t':['bussobushbash'],limit:1}],relays:['wss://nos.lol']},(m:any)=>messages.push(m));
 await Bun.sleep(30);const socket=FixtureSocket.sockets.at(-1)!;socket.onmessage({data:JSON.stringify(['EVENT',h.id,signed('after EOSE',undefined,1700000002)])});expect(messages.filter(m=>m.type==='event').length).toBe(2);expect(messages.some(m=>m.status?.state==='live')).toBe(true);h.close();expect(socket.readyState).toBe(3);
 for(let i=0;i<30;i++){const sub=pool.subscribe({filters:[{}],relays:['wss://nos.lol']},()=>{});sub.close();}
});
test('editable exact no-relay migration preserves max-sized custom instructions and snapshots',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE builder_prompt(id INTEGER,revision INTEGER,text TEXT,updated_at INTEGER);CREATE TABLE request_builder_prompts(text TEXT)');
 const text='custom'.padEnd(builderPromptMaxChars-obsoleteNoRelayParagraph.length,'x')+obsoleteNoRelayParagraph;db.run('INSERT INTO builder_prompt VALUES(1,2,?,0)',[text]);db.run('INSERT INTO request_builder_prompts VALUES(?)',[text]);migrateNappletPrompt(db,'builder_prompt');const row:any=db.query('SELECT * FROM builder_prompt').get();expect(row.text).toBe(text.replace(obsoleteNoRelayParagraph,nappletCapabilityParagraph));expect(row.text.length).toBeLessThanOrEqual(builderPromptMaxChars);expect(row.revision).toBe(3);expect((db.query('SELECT text FROM request_builder_prompts').get() as any).text).toBe(text);migrateNappletPrompt(db,'builder_prompt');expect((db.query('SELECT revision FROM builder_prompt').get() as any).revision).toBe(3);db.close();
});
test('editable current prompt gains direct HTTPS/WSS guidance without changing queued snapshots',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE builder_prompt(id INTEGER,revision INTEGER,text TEXT,updated_at INTEGER);CREATE TABLE request_builder_prompts(text TEXT)');
 db.run('INSERT INTO builder_prompt VALUES(1,4,?,0)',[obsoleteNetworkCapabilityParagraph]);db.run('INSERT INTO request_builder_prompts VALUES(?)',[obsoleteNetworkCapabilityParagraph]);migrateNappletPrompt(db,'builder_prompt');
 const row:any=db.query('SELECT * FROM builder_prompt').get();expect(row.text).toBe(nappletCapabilityParagraph);expect(row.revision).toBe(5);expect(row.text).toContain('Direct HTTPS/WSS allowed');expect(row.text).toContain('opaque/null origin');expect((db.query('SELECT text FROM request_builder_prompts').get() as any).text).toBe(obsoleteNetworkCapabilityParagraph);db.close();
});
test('parent CSP includes every approved relay and preview isolation remains fixed',async()=>{
 const application=await Bun.file('src/application.ts').text();for(const url of relay.APPROVED_RELAYS)expect(application).toContain(url);const assets=await Bun.file('src/assets.ts').text();expect(assets).toContain('connect-src https: wss:');expect(assets).toContain("script-src 'unsafe-inline'");expect(assets).toContain("frame-src 'none'");expect(assets).toContain("form-action 'none'");expect(assets).toContain('sandbox allow-scripts allow-forms');
});
test('constructor failure/backoff exhaustion closes and frees pool capacity for explicit retry',()=>{
 const nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout;const timers=new Map<number,()=>void>();let timerId=0;const messages:any[]=[];
 class Unreachable {constructor(){throw Error('Fixture unavailable');}}
 try{
  globalThis.setTimeout=((callback:any)=>{timers.set(++timerId,callback);return timerId;}) as any;globalThis.clearTimeout=((id:any)=>{timers.delete(id);}) as any;
  const pool=relay.createRelayPool(verifyEvent,Unreachable);const h=pool.subscribe({filters:[{}],relays:['wss://nos.lol']},(m:any)=>messages.push(m));
  for(let i=0;i<8&&timers.size;i++){const [id,callback]=timers.entries().next().value!;timers.delete(id);callback();}
  expect(messages.some(m=>m.status?.state==='closed')).toBe(true);expect(h.closed()).toBe(true);expect(messages.filter(m=>m.status?.retryMs).map(m=>m.status.retryMs)).toEqual([1000,2000,4000,8000,16000,30000,30000]);
  for(let i=0;i<30;i++){const next=pool.subscribe({filters:[{}],relays:['wss://nos.lol']},()=>{});next.close();}
 }finally{globalThis.setTimeout=nativeSet;globalThis.clearTimeout=nativeClear;}
});
test('EOSE with exactly the requested count is complete without invented truncation',async()=>{
 class OneSocket extends FixtureSocket {send(text:string){const m=JSON.parse(text);this.sent.push(m);if(m[0]==='REQ'){this.onmessage?.({data:JSON.stringify(['EVENT',m[1],signed()])});this.onmessage?.({data:JSON.stringify(['EOSE',m[1]])});}}}
 const result=await relay.createRelayPool(verifyEvent,OneSocket).query({filters:[{limit:1}],relays:['wss://nos.lol']}).promise;expect(result.events.length).toBe(1);expect(result.complete).toBe(true);expect(result.truncated).toBe(false);
});
test('global subscription exhaustion is explicit and close restores capacity',()=>{
 const pool=relay.createRelayPool(verifyEvent,FixtureSocket);const handles=Array.from({length:24},()=>pool.subscribe({filters:[{}],relays:['wss://nos.lol']},()=>{}));
 expect(()=>pool.subscribe({filters:[{}],relays:['wss://nos.lol']},()=>{})).toThrow('capacity');handles[0].close();const replacement=pool.subscribe({filters:[{}],relays:['wss://nos.lol']},()=>{});replacement.close();handles.forEach(h=>h.close());
});
test('limit zero rejects stored history but still delivers newly arriving live events',async()=>{
 const messages:any[]=[],pool=relay.createRelayPool(verifyEvent,FixtureSocket),h=pool.subscribe({filters:[{limit:0}],relays:['wss://nos.lol']},(m:any)=>messages.push(m));await Bun.sleep(30);expect(messages.filter(m=>m.type==='event')).toEqual([]);
 const socket=FixtureSocket.sockets.at(-1)!;socket.onmessage({data:JSON.stringify(['EVENT',h.id,signed('new event',undefined,1700000003)])});expect(messages.filter(m=>m.type==='event').map(m=>m.event.content)).toEqual(['new event']);h.close();
});
