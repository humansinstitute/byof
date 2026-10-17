const CACHE_NAME = 'freedom-napplet-payload-v1';
const CACHE_PREFIX = '/.freedom-napplet-cache/v1/sha256/';
const MAX_ENTRIES = 64;

const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
export async function payloadSha256(bytes, cryptoImpl = globalThis.crypto) {
  return hex(await cryptoImpl.subtle.digest('SHA-256', bytes));
}

function cacheRequest(origin, hash) {
  return new Request(origin + CACHE_PREFIX + hash, { method:'GET' });
}

async function verifiedBytes(response, expectedHash, cryptoImpl) {
  const bytes = await response.arrayBuffer();
  if (await payloadSha256(bytes, cryptoImpl) !== expectedHash) throw new Error('Napplet payload integrity check failed');
  return bytes;
}

async function trim(cache, limit = MAX_ENTRIES) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  const entries = await Promise.all(keys.map(async request => {
    const response = await cache.match(request);
    return { request, stored:Number(response?.headers.get('x-freedom-cached-at') || 0) };
  }));
  entries.sort((a,b) => a.stored-b.stored);
  await Promise.all(entries.slice(0, entries.length-limit).map(entry => cache.delete(entry.request)));
}

export function createNappletPayloadCache({cacheStorage=globalThis.caches,fetchImpl=globalThis.fetch,cryptoImpl=globalThis.crypto,origin=globalThis.location?.origin,maxEntries=MAX_ENTRIES}={}) {
  async function networkBytes(spec) {
    const url = `/api/v1/projects/${encodeURIComponent(spec.projectId)}/payload?workshop=${encodeURIComponent(spec.workshopId)}&revision=${encodeURIComponent(spec.revisionId)}`;
    const response = await fetchImpl(url,{credentials:'same-origin',cache:'no-store',headers:{'x-workshop-id':spec.workshopId}});
    if(!response.ok)throw new Error('Napplet payload download failed');
    if(response.headers.get('x-napplet-source-sha256')!==spec.sourceHash)throw new Error('Napplet payload reference changed');
    return verifiedBytes(response,spec.sourceHash,cryptoImpl);
  }
  async function load(spec) {
    if(!/^[a-f0-9]{64}$/.test(spec.sourceHash))throw new Error('Invalid Napplet payload reference');
    let cache, bytes, cacheHit=false;
    try {
      if(!cacheStorage)throw new Error('Cache Storage unavailable');
      cache=await cacheStorage.open(CACHE_NAME);
      const request=cacheRequest(origin,spec.sourceHash),saved=await cache.match(request);
      if(saved){
        try{bytes=await verifiedBytes(saved,spec.sourceHash,cryptoImpl);cacheHit=true;}
        catch{await cache.delete(request);}
      }
    } catch {}
    if(!bytes)bytes=await networkBytes(spec);
    if(cache&&!cacheHit){
      const request=cacheRequest(origin,spec.sourceHash),headers={'content-type':'text/html; charset=utf-8','x-napplet-source-sha256':spec.sourceHash,'x-freedom-cached-at':String(Date.now())};
      try{await cache.put(request,new Response(bytes.slice(0),{headers}));await trim(cache,maxEntries);}catch{}
    }
    const source=new TextDecoder().decode(bytes);
    return {source,cacheHit};
  }
  return {load};
}

export { CACHE_NAME, CACHE_PREFIX, MAX_ENTRIES };
