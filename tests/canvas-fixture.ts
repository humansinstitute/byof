import type { StorageTransport } from '../src/tower-storage-client.ts';
/** Disposable Tower table-contract fixture. Not a Tower live-service substitute. */
export class CanvasTableFixture {
 rows=new Map<string,any>();offline=false;atomic=true;
 request:StorageTransport=async(url,method,body:any)=>{
  if(this.offline)throw Error('Synthetic Tower disconnect');
  const path=new URL(url).pathname;
  if(path.endsWith('/provision'))return Response.json({ok:true});
  if(path.endsWith('/descriptor'))return Response.json({capabilities:{conditional_update:this.atomic}});
  if(path.endsWith('/migrations'))return Response.json({ok:true});
  if(path.endsWith('/query')){
   let rows=[...this.rows.values()].filter(row=>Object.entries(body.where||{}).every(([k,v]:any)=>'eq' in v?row[k]===v.eq:true));
   for(const order of [...(body.order||[])].reverse())rows.sort((a,b)=>a[order.field]<b[order.field]?-1:a[order.field]>b[order.field]?1:0);
   rows=rows.slice(body.offset||0,(body.offset||0)+(body.limit||100));if(body.select)rows=rows.map(r=>Object.fromEntries(body.select.map((k:string)=>[k,r[k]])));
   return Response.json({rows});
  }
  if(method==='POST'&&path.endsWith('/rows')){
   const row={...body.data,id:body.id};
   if([...this.rows.values()].some(r=>row.schema_slot!==null&&row.schema_slot!==undefined&&r.schema_slot===row.schema_slot&&['installation_id','workspace_id','canvas_id','visibility','owner_pubkey'].every(k=>r[k]===row[k]))||this.rows.has(row.id)||[...this.rows.values()].some(r=>['installation_id','workspace_id','canvas_id','dataset','visibility','owner_pubkey','slot'].every(k=>r[k]===row[k])))return Response.json({error:'row conflict'},{status:409});
   this.rows.set(row.id,structuredClone(row));return Response.json({row},{status:201});
  }
  if(method==='PATCH'){
   const id=path.split('/').at(-1)!,row=this.rows.get(id);
   if(!row||!Object.entries(body.where).every(([key,c]:any)=>row[key]===c.eq))return Response.json({error:'conditional conflict'},{status:409});
   Object.assign(row,structuredClone(body.set));return Response.json({row});
  }
  throw Error('Unexpected Tower fixture request');
 };
}
