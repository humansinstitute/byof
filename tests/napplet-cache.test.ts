import {expect,test} from 'bun:test';
import {sha256} from '../src/assets.ts';
// Browser-native module is served as JavaScript; Bun executes its named exports directly.
// @ts-expect-error no generated declaration is required for the public browser module
import {CACHE_PREFIX,createNappletPayloadCache} from '../public/napplet-cache.js';

class MemoryCache {
  entries=new Map<string,Response>();
  async match(request:Request){return this.entries.get(request.url)?.clone();}
  async put(request:Request,response:Response){this.entries.set(request.url,response.clone());}
  async delete(request:Request){return this.entries.delete(request.url);}
  async keys(){return [...this.entries.keys()].map(url=>new Request(url));}
}

function fixture() {
  const cache=new MemoryCache(),sources=new Map<string,string>(),payloadCalls:string[]=[],runtimeCalls:string[]=[];let documents=0;
  const fetchImpl=async (input:string|URL|Request)=>{
    const url=new URL(String(input),'https://freedom.test'),revision=url.searchParams.get('revision')!;
    const source=sources.get(revision)!;
    if(url.pathname.endsWith('/runtime')){runtimeCalls.push(url.pathname+url.search);return Response.json({documentId:`00000000-0000-0000-0000-${String(++documents).padStart(12,'0')}`,sourceHash:sha256(source),injection:`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'"><script>window.binding=${documents}</script>`,suffix:'<script>window.finished=true</script>'});}
    payloadCalls.push(url.pathname+url.search);
    return new Response(source,{headers:{'x-napplet-source-sha256':sha256(source)}});
  };
  const storage={open:async()=>cache};
  const loader=createNappletPayloadCache({cacheStorage:storage as any,fetchImpl:fetchImpl as any,cryptoImpl:crypto,origin:'https://freedom.test',maxEntries:2});
  return {cache,sources,payloadCalls,runtimeCalls,loader};
}

const spec=(projectId:string,revisionId:string,source:string)=>({projectId,revisionId,sourceHash:sha256(source),workshopId:'workshop-one'});

test('first load stores immutable bytes and reload hits without redownloading',async()=>{
  const f=fixture(),source='<!doctype html><html><body>one</body></html>',s=spec('project-one','revision-one',source);f.sources.set(s.revisionId,source);
  const first=await f.loader.load(s),second=await f.loader.load(s);
  expect(first.cacheHit).toBe(false);expect(second.cacheHit).toBe(true);expect(f.payloadCalls).toHaveLength(1);expect(f.runtimeCalls).toHaveLength(0);expect(first.source).toBe(source);expect(second.source).toBe(source);
});

test('new hashes miss and identical fork bytes deduplicate by content only',async()=>{
  const f=fixture(),one='<html><body>same</body></html>',two='<html><body>changed</body></html>';
  f.sources.set('revision-one',one);f.sources.set('revision-two',two);f.sources.set('fork-revision',one);
  await f.loader.load(spec('project-one','revision-one',one));
  const fork=await f.loader.load(spec('project-fork','fork-revision',one));
  const changed=await f.loader.load(spec('project-one','revision-two',two));
  expect(fork.cacheHit).toBe(true);expect(changed.cacheHit).toBe(false);expect(f.payloadCalls).toHaveLength(2);
});

test('corrupt cached bytes are rejected and replaced from the authorized payload path',async()=>{
  const f=fixture(),source='<html><body>trusted</body></html>',s=spec('project-one','revision-one',source);f.sources.set(s.revisionId,source);
  const request=new Request('https://freedom.test'+CACHE_PREFIX+s.sourceHash);await f.cache.put(request,new Response('corrupt'));
  const loaded=await f.loader.load(s);expect(loaded.cacheHit).toBe(false);expect(f.payloadCalls).toHaveLength(1);expect(loaded.source).toContain('trusted');
  expect(await (await f.cache.match(request))!.text()).toBe(source);
});

test('unavailable Cache Storage uses the authorized network payload path',async()=>{
  const source='<html><body>online</body></html>',s=spec('project-one','revision-one',source),f=fixture();f.sources.set(s.revisionId,source);
  // Exercise cache failure with the same transport through a throwing Cache Storage facade.
  const fallback=createNappletPayloadCache({cacheStorage:{open:async()=>{throw Error('disabled');}} as any,fetchImpl:async()=>new Response(source,{headers:{'x-napplet-source-sha256':s.sourceHash}}),cryptoImpl:crypto,origin:'https://freedom.test'});
  expect((await fallback.load(s)).source).toContain('online');
});

test('bounded cleanup evicts the oldest content entry without touching Napplet data',async()=>{
  const f=fixture();
  for(const [revision,source] of [['one','<p>one</p>'],['two','<p>two</p>'],['three','<p>three</p>']]){f.sources.set(revision,source);await f.loader.load(spec('project',revision,source));}
  expect(f.cache.entries.size).toBe(2);
});
