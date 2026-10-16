import { test, expect } from 'bun:test';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { ProfileCache, isLocalRaster } from '../src/profile-cache.ts';
import { latestMetadata, validMetadata, metadataFields, PROFILE_TTL, PROFILE_RETRY, profileImageUrl } from '../src/nostr-profile.ts';
const key=generateSecretKey(),other=generateSecretKey(),pubkey=getPublicKey(key),now=Date.now();
const event=(name='Relay person',time=Math.floor(now/1000)-1,secret=key,picture='https://images.example.com/avatar.png')=>finalizeEvent({kind:0,created_at:time,tags:[],content:JSON.stringify({name:'Name',display_name:name,picture,about:'From Nostr'})},secret);
function store(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)||null,setItem:(k:string,v:string)=>{data.set(k,v);},data};}
const png='data:image/png;base64,iVBORw0KGgo=';
test('metadata accepts only signed kind-0 exact authors, rejects malformed/forged/future events and chooses latest with deterministic ties',()=>{
 const a=event(),b=event('Newer',a.created_at+1),tie=event('Tie',b.created_at);
 expect(validMetadata(a,pubkey)).not.toBeNull();
 for(const e of [event('Other',a.created_at,other),{...a,kind:1},{...a,content:'{}'},{...a,sig:'0'.repeat(128)},event('Future',Math.floor(now/1000)+1000),finalizeEvent({kind:0,created_at:a.created_at,tags:[],content:'[]'},key)])expect(validMetadata(e,pubkey)).toBeNull();
 expect(latestMetadata([a,b,tie],pubkey)?.id).toBe([b,tie].sort((x,y)=>x.id.localeCompare(y.id))[0]!.id);
 expect(latestMetadata([tie,b,a],pubkey)?.id).toBe(latestMetadata([a,b,tie],pubkey)?.id);
 expect(metadataFields(event(pubkey)).name).toBe('Name');
});
test('cache persists verified names and local raster bytes across instances, navigation and routine reload do not fetch',async()=>{
 const storage=store();let queries=0,images=0;
 const query=async()=>{queries++;return [event()];},raster=async()=>{images++;return png;};
 const cache=new ProfileCache(storage,query,raster,()=>now);
 expect(cache.peek(pubkey).name).toBe('Workshop participant');
 const result=await cache.refresh(pubkey);expect(result.name).toBe('Relay person');expect(result.avatar).toBe(png);
 await cache.refresh(pubkey);await cache.refresh(pubkey);
 const reloaded=new ProfileCache(storage,query,raster,()=>now+100);
 expect(reloaded.peek(pubkey).name).toBe('Relay person');await reloaded.refresh(pubkey);
 expect({queries,images}).toEqual({queries:1,images:1});
 expect(reloaded.peek(getPublicKey(other)).avatar).toBe('');expect(reloaded.peek(getPublicKey(other)).name).toBe('Workshop participant');
});
test('same-account refresh coalesces in-flight requests, image requests coalesce across accounts',async()=>{
 const storage=store();let queries=0,images=0;let resolve!: (v:unknown[])=>void;
 const cache=new ProfileCache(storage,()=>{queries++;return new Promise(r=>resolve=r);},async()=>{images++;await new Promise(r=>setTimeout(r,10));return png;},()=>now);
 const a=cache.refresh(pubkey),b=cache.refresh(pubkey);expect(a).toBe(b);expect(queries).toBe(1);resolve([event()]);await a;expect(images).toBe(1);
 const coalesced=new ProfileCache(store(),async p=>[p===pubkey?event():event('Other',Math.floor(now/1000),other)],async()=>{images++;await new Promise(r=>setTimeout(r,10));return png;},()=>now);
 await Promise.all([coalesced.refresh(pubkey),coalesced.refresh(getPublicKey(other))]);expect(images).toBe(2);
});
test('expiry refreshes once, delayed/offline failure preserves cached identity and decoded bytes, retry backoff persists reload',async()=>{
 const storage=store();let time=now,queries=0;let fail=false;
 const query=async()=>{queries++;if(fail)throw Error('Offline');return[event()];};
 const cache=new ProfileCache(storage,query,async()=>png,()=>time);await cache.refresh(pubkey);fail=true;time+=PROFILE_TTL+1;
 await cache.refresh(pubkey);expect(cache.peek(pubkey).name).toBe('Relay person');expect(cache.peek(pubkey).avatar).toBe(png);
 const reload=new ProfileCache(storage,query,async()=>{throw Error('must not refetch');},()=>time);await reload.refresh(pubkey);expect(queries).toBe(2);
 time+=PROFILE_RETRY+1;fail=false;await reload.refresh(pubkey);expect(queries).toBe(3);expect(reload.peek(pubkey).avatar).toBe(png);
});
test('invalid relay metadata and tampered or wrong-account persisted cache never hydrate a name or avatar',async()=>{
 const storage=store();const cache=new ProfileCache(storage,async()=>[event('Wrong',Math.floor(now/1000),other)],async()=>png,()=>now);
 await cache.refresh(pubkey);expect(cache.peek(pubkey).name).toBe('Workshop participant');
 storage.setItem('freedom-nostr-profile-v1:'+pubkey,JSON.stringify({event:event('Wrong',Math.floor(now/1000),other),avatar:png,avatarPicture:'https://images.example.com/avatar.png'}));
 const reload=new ProfileCache(storage,async()=>[],async()=>png,()=>now);expect(reload.peek(pubkey).avatar).toBe('');expect(reload.peek(pubkey).name).toBe('Workshop participant');
});
test('image failure keeps cached bytes, suppresses repeated image fetches, unsafe schemes and SVG are rejected',async()=>{
 const storage=store();let time=now,images=0;
 const cache=new ProfileCache(storage,async()=>[event()],async()=>{images++;return png;},()=>time);
 await cache.refresh(pubkey);
 const next=event('New profile',Math.floor(now/1000),key,'https://images.example.com/new.png');
 const broken=new ProfileCache(storage,async()=>[next],async()=>{images++;throw Error('Decode failure');},()=>time);
 time+=PROFILE_TTL+1;await broken.refresh(pubkey);expect(broken.peek(pubkey).name).toBe('New profile');expect(broken.peek(pubkey).avatar).toBe(png);
 await broken.refresh(pubkey);expect(images).toBe(2);
 const reloaded=new ProfileCache(storage,async()=>{throw Error('No metadata refetch');},async()=>{images++;throw Error('Still offline');},()=>time);
 expect(reloaded.peek(pubkey).avatar).toBe(png);await reloaded.refresh(pubkey);expect(images).toBe(2);
 time+=PROFILE_RETRY+1;await reloaded.refresh(pubkey);expect(images).toBe(3);expect(reloaded.peek(pubkey).avatar).toBe(png);
 for(const url of ['javascript:alert(1)','data:image/png;base64,AA','http://x.test/a.png','https://x.test/a.svg','https://localhost/a.png','https://user:pass@x.test/a.png'])expect(profileImageUrl(url)).toBe('');
 expect(isLocalRaster('data:image/svg+xml;base64,AA')).toBe(false);
});
test('local edits are explicit per-account overlays, survive reload, and restoring Nostr retains signed source',async()=>{
 const storage=store(),cache=new ProfileCache(storage,async()=>[event()],async()=>png,()=>now);
 await cache.refresh(pubkey);await cache.saveLocal(pubkey,{name:'Device name',picture:'',about:'Device bio'});
 const reload=new ProfileCache(storage,async()=>[],async()=>png,()=>now);expect(reload.peek(pubkey).name).toBe('Device name');expect(reload.peek(pubkey).local).toBe(true);
 expect(reload.peek(getPublicKey(other)).name).toBe('Workshop participant');expect(reload.clearLocal(pubkey).name).toBe('Relay person');expect(reload.peek(pubkey).avatar).toBe(png);
});
test('new signed metadata without picture clears previously cached avatar',async()=>{
 const storage=store();let time=now,remove=false;
 const cache=new ProfileCache(storage,async()=>[remove?event('Removed',Math.floor(now/1000),key,''):event()],async()=>png,()=>time);
 await cache.refresh(pubkey);remove=true;time+=PROFILE_TTL+1;await cache.refresh(pubkey);
 expect(cache.peek(pubkey).avatar).toBe('');expect(cache.peek(pubkey).picture).toBe('');
 const reload=new ProfileCache(storage,async()=>[],async()=>png,()=>time);expect(reload.peek(pubkey).avatar).toBe('');
});
