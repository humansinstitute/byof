import {finalizeEvent,getPublicKey,nip19} from 'nostr-tools';
import {sha256} from '../src/assets.ts';
import type {StorageTransport,StorageTarget} from '../src/tower-storage-client.ts';
import {resolve} from 'node:path';
/** Source-loaded Tower + disposable PostgreSQL. Fixed fixture signer, never a human/app production key. */
export async function openCanvasTowerFixture(){
 const root=resolve(process.env.FREEDOM_TOWER_FIXTURE_ROOT??'../wm/tower');
 if(!root?.startsWith('/')||process.env.DB_PORT!=='55439'||process.env.TEST_DB_NAME!=='freedom_canvas_generic_fixture')throw Error('Explicit disposable Tower fixture configuration required');
 Object.assign(process.env,{SUPERBASED_DIRECT_HTTPS_URL:'https://tower.fixture.invalid',ADMIN_NPUB:nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(31))),DB_HOST:'127.0.0.1',DB_NAME:'freedom_canvas_generic_fixture',DB_USER:'postgres',DB_PASSWORD:'postgres',STORAGE_S3_ENDPOINT_PUBLIC:'http://127.0.0.1:1',STORAGE_S3_ACCESS_KEY:'synthetic-fixture-only',STORAGE_S3_SECRET_KEY:'synthetic-fixture-only',GRAPH_DB_ADMIN_USER:'fixture',GRAPH_DB_ADMIN_PASSWORD:'fixture',GRAPH_DB_APP_USER:'fixture',GRAPH_DB_APP_PASSWORD:'fixture'});
 process.env.FLIGHT_DECK_PG_APP_NPUB??=nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(34)));
 const {default:postgres}=await import(root+'/node_modules/postgres/src/index.js');
 const sql=postgres({host:'127.0.0.1',port:55439,database:'freedom_canvas_generic_fixture',username:'postgres',password:'postgres'});
 const {setDb}=await import(root+'/src/db.ts');setDb(sql);
 const {createApp}=await import(root+'/src/server.ts');const tower=createApp();
 const owner=nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(31))),key=new Uint8Array(32).fill(34),appNpub=nip19.npubEncode(getPublicKey(key));
 const target:StorageTarget={towerUrl:'https://tower.fixture.invalid',workspaceId:'f1c00000-0000-4000-8000-000000000001',workspaceOwnerNpub:owner,appNpub};
 const request:StorageTransport=async(url,method,body)=>{
  const parsed=new URL(url),actual='http://localhost'+parsed.pathname,serialized=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',actual],['method',method],...(serialized?[['payload',sha256(serialized)]]:[])]},key);
  return tower.request(actual,{method,headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),'content-type':'application/json'},...(serialized?{body:serialized}:{})});
 };
 return {request,target,close:()=>sql.end()};
}
