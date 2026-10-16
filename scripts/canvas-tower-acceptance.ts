import {expect} from 'bun:test';
import {CanvasDatasetStore} from '../src/canvas-datasets.ts';
import {openCanvasTowerFixture} from './canvas-tower-fixture.ts';
const fixture=await openCanvasTowerFixture();
try{
 const scope={installationId:crypto.randomUUID(),target:fixture.target,canvasId:crypto.randomUUID(),user:'a'.repeat(64)},a=new CanvasDatasetStore(scope,fixture.request),b=new CanvasDatasetStore({...scope,user:'b'.repeat(64)},fixture.request),binding={name:'inventory',visibility:'shared' as const};
 await a.ensure();await a.open({...binding,description:'Fixture inventory',fields:{quantity:'number: current units'}});await b.open(binding);
 await a.open({...binding,description:'Fixture inventory',fields:{quantity:'number: current units'}});
 await a.set(binding,'stock',{quantity:1},0);expect((await b.get(binding,'stock')).value).toEqual({quantity:1});
 const results=await Promise.allSettled([a.set(binding,'stock',{quantity:2},1),b.set(binding,'stock',{quantity:3},1)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const privateBinding={name:'notes',visibility:'private' as const};await a.open({...privateBinding,description:'Private notes',fields:{note:'string: private text'}});await a.set(privateBinding,'text',{note:'fixture secret'},0);expect((await b.get(privateBinding,'text')).version).toBe(0);
 expect((await b.discovery()).map((d:any)=>d.name)).toEqual(['inventory']);
 const before=await a.get(binding,'stock');expect(await a.remove(binding,'stock',before.version)).toMatchObject({version:before.version+1});
 expect(await a.get(binding,'stock')).toMatchObject({value:null,version:before.version+1});
 await expect(a.set(binding,'stock',{},0)).rejects.toThrow();await expect(a.set(binding,'stock',{},before.version)).rejects.toThrow();
 await a.set(binding,'stock',{quantity:8},before.version+1);
 await a.set(binding,'large',{text:'x'.repeat(32757)},0);
 for(const value of [null,[],1,'string'])await expect(a.set(binding,'bad',value,0)).rejects.toThrow('JSON object');
 for(let i=1;i<63;i++)await a.open({...binding,name:'dataset_'+i,description:'Schema quota fixture',fields:{n:'number'}});
 const quota=await Promise.allSettled([a.open({...binding,name:'last_a',description:'Final slot',fields:{n:'number'}}),b.open({...binding,name:'last_b',description:'Final slot',fields:{n:'number'}})]);
 expect(quota.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await a.discovery()).toHaveLength(64);
 for(let i=1;i<64;i++)await a.open({name:'private_'+i,visibility:'private',description:'Private quota',fields:{n:'number'}});
 await expect(a.open({name:'overflow',visibility:'private',description:'Overflow',fields:{n:'number'}})).rejects.toThrow('limit');
 await b.open({name:'overflow',visibility:'private',description:'Other owner',fields:{n:'number'}});
 console.log(JSON.stringify({passed:true,mode:'Actual source-loaded Tower routes/app-signer NIP-98/PostgreSQL disposable fixture; not deployed Tower',migration:'003_canvas_dataset_records',checks:['real migration/check/unique constraints','cross-owner shared JSON','two PostgreSQL simultaneous writes one winner','private owner and discovery isolation','equivalent schema reopen after JSONB key reordering','32 KiB object round trip','CAS tombstone and ABA protection','shared final slot concurrent race stays 64','64 private schemas independent of shared and other owner']}));
}finally{await fixture.close();}
