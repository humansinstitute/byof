import { SimplePool, type Event } from 'nostr-tools';
import { PROFILE_RELAYS, PROFILE_TTL, PROFILE_RETRY, validMetadata, latestMetadata, metadataFields, profileImageUrl, humanText } from './nostr-profile.ts';
export { humanText, initials } from './nostr-profile.ts';

type Record = { event: Event | null; checkedAt: number; retryAt: number; avatar: string; avatarPicture: string; avatarEvent: Event | null; imageRetryAt: number };
type Local = { name: string; picture: string; about: string; avatar: string };
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export type ProfileView = { name: string; picture: string; about: string; avatar: string; local: boolean; event: Event | null };
const cachePrefix = 'freedom-nostr-profile-v1:';
const localPrefix = 'freedom-local-profile-v1:';
const empty = (): Record => ({ event:null,checkedAt:0,retryAt:0,avatar:'',avatarPicture:'',avatarEvent:null,imageRetryAt:0 });
export const isLocalRaster = (s: unknown): s is string => typeof s === 'string' && s.length <= 180000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(s);

export async function queryMetadata(pubkey: string): Promise<unknown[]> {
  const pool = new SimplePool();
  const events: Event[] = [];
  // Individual subscriptions avoid pool-wide pre-verification ID deduplication:
  // an invalid event from one relay must not suppress its valid signed original.
  return new Promise(resolve => {
    let finished = false, remaining = PROFILE_RELAYS.length;
    const subscriptions: {close:()=>void}[] = [];
    const done = () => { if (finished) return; finished=true; clearTimeout(timer); subscriptions.forEach(s=>s.close()); queueMicrotask(()=>pool.close(PROFILE_RELAYS)); resolve(events); };
    const timer = setTimeout(done,3500);
    for (const url of PROFILE_RELAYS) void pool.ensureRelay(url,{connectionTimeout:2500}).then(relay=>{
      if(finished){relay.close();return;}
      const sub=relay.subscribe([{ kinds:[0],authors:[pubkey],limit:8 }],{onevent:e=>{if(events.length<64)events.push(e);},oneose:()=>{if(--remaining===0)done();}});
      subscriptions.push(sub);
    }).catch(()=>{if(--remaining===0)done();});
  });
}

// Only decoded raster bytes are persisted. No remote URL ever enters an avatar img.
export async function cacheRaster(url: string): Promise<string> {
  if (!profileImageUrl(url)) throw Error('Use a public HTTPS raster image');
  const r = await fetch(url,{ credentials:'omit',referrerPolicy:'no-referrer',redirect:'follow',signal:AbortSignal.timeout(5000) });
  const type=(r.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!r.ok || !profileImageUrl(r.url || url) || !['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(type) || Number(r.headers.get('content-length')||0)>2*1024*1024) throw Error('Image unavailable');
  const reader=r.body?.getReader(); if(!reader)throw Error('Image unavailable');
  const parts: Uint8Array[]=[];let size=0;
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('Image too large');parts.push(value);} } finally { await reader.cancel().catch(()=>{}); }
  const bitmap=await createImageBitmap(new Blob(parts as BlobPart[],{type}));
  try {
    if(!bitmap.width||!bitmap.height||bitmap.width>4096||bitmap.height>4096||bitmap.width*bitmap.height>16000000)throw Error('Image too large');
    const scale=Math.min(1,128/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/png');if(!isLocalRaster(data))throw Error('Image too large');return data;
  } finally { bitmap.close(); }
}

export class ProfileCache {
  private records=new Map<string,Record>();
  private locals=new Map<string,Local>();
  private flights=new Map<string,Promise<ProfileView>>();
  private images=new Map<string,Promise<string>>();
  constructor(private store:Store,private query=queryMetadata,private raster=cacheRaster,private clock=Date.now) {}
  private write(key:string,value:unknown){try{this.store.setItem(key,JSON.stringify(value));}catch{/* Memory cache still works with unavailable/full storage. */}}
  private record(pubkey:string):Record {
    let r=this.records.get(pubkey);if(r)return r;
    r=empty();try{
      const stored=JSON.parse(this.store.getItem(cachePrefix+pubkey)||'null');
      if(stored){const now=this.clock(),event=validMetadata(stored.event,pubkey,now);
        const stamp=(n:unknown,max:number)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=max?n:0;
        r={...empty(),event,checkedAt:event?stamp(stored.checkedAt,now):0,retryAt:stamp(stored.retryAt,now+PROFILE_RETRY),imageRetryAt:stamp(stored.imageRetryAt,now+PROFILE_RETRY)};
        const avatarEvent=validMetadata(stored.avatarEvent||stored.event,pubkey,now);
        if(event&&metadataFields(event).picture&&avatarEvent&&stored.avatarPicture===metadataFields(avatarEvent).picture&&isLocalRaster(stored.avatar)){r.avatar=stored.avatar;r.avatarPicture=stored.avatarPicture;r.avatarEvent=avatarEvent;}}

    }catch{}this.records.set(pubkey,r);return r;
  }
  private local(pubkey:string):Local|undefined {
    if(this.locals.has(pubkey))return this.locals.get(pubkey);
    try{const p=JSON.parse(this.store.getItem(localPrefix+pubkey)||'null');if(p&&humanText(p.name,60)){const l={name:humanText(p.name,60),about:humanText(p.about),picture:profileImageUrl(p.picture),avatar:isLocalRaster(p.avatar)?p.avatar:''};this.locals.set(pubkey,l);return l;}}catch{}return undefined;
  }
  peek(pubkey:string,temporaryName=''):ProfileView {
    const r=this.record(pubkey),p=metadataFields(r.event),local=this.local(pubkey);
    return {...p,...(temporaryName&&!r.event?{name:humanText(temporaryName,60)||p.name}:{}),avatar:p.picture?r.avatar:'',...local,local:!!local,event:r.event};
  }
  seed(pubkey:string,value:unknown){const event=validMetadata(value,pubkey,this.clock());if(!event)return;const r=this.record(pubkey);r.event=latestMetadata([event,...(r.event?[r.event]:[])],pubkey,this.clock());this.write(cachePrefix+pubkey,r);}
  private image(url:string):Promise<string>{const prior=this.images.get(url);if(prior)return prior;const next=this.raster(url).finally(()=>this.images.delete(url));this.images.set(url,next);return next;}
  refresh(pubkey:string):Promise<ProfileView> {
    const prior=this.flights.get(pubkey);if(prior)return prior;
    const r=this.record(pubkey),now=this.clock();
    if(now<r.retryAt||r.checkedAt>0&&now-r.checkedAt<PROFILE_TTL&&(r.avatarPicture===metadataFields(r.event).picture||!metadataFields(r.event).picture||now<r.imageRetryAt))return Promise.resolve(this.peek(pubkey));
    const flight=this.load(pubkey,r).finally(()=>this.flights.delete(pubkey));this.flights.set(pubkey,flight);return flight;
  }
  private async load(pubkey:string,r:Record):Promise<ProfileView>{
    const now=this.clock();
    if(!r.checkedAt||now-r.checkedAt>=PROFILE_TTL){
      r.retryAt=now+PROFILE_RETRY;this.write(cachePrefix+pubkey,r);
      try{const events=await this.query(pubkey),best=latestMetadata([...(r.event?[r.event]:[]),...events],pubkey,this.clock());
        if(events.some(e=>validMetadata(e,pubkey,this.clock()))){r.event=best;r.checkedAt=this.clock();r.retryAt=0;}
      }catch{/* Preserve signed cached identity and avatar on relay failure. */}
    }
    const picture=metadataFields(r.event).picture;
    if(!picture){r.avatar='';r.avatarPicture='';r.avatarEvent=null;r.imageRetryAt=0;}
    if(picture&&picture!==r.avatarPicture&&this.clock()>=r.imageRetryAt){
      r.imageRetryAt=this.clock()+PROFILE_RETRY;
      try{r.avatar=await this.image(picture);r.avatarPicture=picture;r.avatarEvent=r.event;r.imageRetryAt=0;}catch{}
    }
    this.write(cachePrefix+pubkey,r);return this.peek(pubkey);
  }
  async saveLocal(pubkey:string,fields:{name:string;picture:string;about:string}):Promise<ProfileView>{
    const name=humanText(fields.name,60);if(!name)throw Error('Enter your name');
    const picture=profileImageUrl(fields.picture);if(fields.picture.trim()&&!picture)throw Error('Use a public HTTPS raster image');
    const current=this.peek(pubkey),avatar=picture?(picture===current.picture&&current.avatar?current.avatar:await this.image(picture)):'';
    const local={name,picture,about:humanText(fields.about),avatar};this.locals.set(pubkey,local);this.write(localPrefix+pubkey,local);return this.peek(pubkey);
  }
  clearLocal(pubkey:string){this.locals.delete(pubkey);this.write(localPrefix+pubkey,null);return this.peek(pubkey);}
}
export function browserProfileCache(){let store:Store;try{store=localStorage;}catch{const map=new Map<string,string>();store={getItem:k=>map.get(k)||null,setItem:(k,v)=>{map.set(k,v);}};}return new ProfileCache(store);}
