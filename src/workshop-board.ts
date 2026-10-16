import { installBoardImages, boardImageSource } from './workshop-images.ts';
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { demand, text } from './errors.ts';
import { imageUrl } from './site.ts';
export type BoardObject = { id:string; kind:'napplet'|'text'|'image'|'group'|'donation'|'arrow'; x:number; y:number; width:number; height:number; groupId:string|null; projectId?:string; text?:string; src?:string; label?:string; fontSize?:number; bold?:boolean; italic?:boolean; underline?:boolean; shadow?:boolean; endX?:number; endY?:number; colour?:string; dotted?:boolean; curveX?:number; curveY?:number };
export function boardBounds(o:BoardObject){return o.kind==='arrow'?{left:o.x+Math.min(0,o.endX!,o.curveX??o.endX!/2),top:o.y+Math.min(0,o.endY!,o.curveY??o.endY!/2),right:o.x+Math.max(0,o.endX!,o.curveX??o.endX!/2),bottom:o.y+Math.max(0,o.endY!,o.curveY??o.endY!/2)}:{left:o.x,top:o.y,right:o.x+o.width,bottom:o.y+o.height};}
export function installBoard(workshop:Workshop) {
  installBoardImages(workshop);
  workshop.db.exec(`CREATE TABLE IF NOT EXISTS workshop_boards(workshop_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,objects_json TEXT NOT NULL DEFAULT '[]');`);
}
export function activeNapplets(workshop:Workshop):any[] {
  // Revisions are immutable successful checkpoints; pending local builds never
  // advance current_revision. Do not return conversations, storage grants or drafts.
  return (workshop.db.query(`SELECT p.id,p.title,p.owner authorPubkey,p.shared_revision,p.current_revision,p.created_at,r.number,r.source_hash FROM projects p LEFT JOIN revisions r ON r.id=p.current_revision WHERE p.workshop_id=? AND p.hidden=0 ORDER BY p.created_at,p.id`).all(workshop.id) as any[])
    .filter(p=>workshop.projectOwnerAccess(p.authorPubkey)?.state==='admitted').map(p=>({...p,appVersionUrl:workshop.versionLink(p.id,p.current_revision)}));
}
export function boardSnapshot(workshop:Workshop) {
  return workshop.db.transaction(()=>{
    workshop.db.run('INSERT OR IGNORE INTO workshop_boards(workshop_id) VALUES(?)',[workshop.id]);
    const row=workshop.db.query('SELECT * FROM workshop_boards WHERE workshop_id=?').get(workshop.id) as any;
    const objects:BoardObject[]=JSON.parse(row.objects_json),napplets=activeNapplets(workshop);
    let changed=false;
    for(const p of [...napplets,{id:'workshop-donation',donation:true}]) if(!objects.some(o=>o.id===p.id)) {
      let x=24,y=24;
      for(let slot=0;slot<10000;slot++) {
        x=24+(slot%3)*464+Math.floor(slot/300)*1392;y=24+Math.floor((slot%300)/3)*464;
        if(!objects.some(o=>{const b=boardBounds(o);return o.kind!=='group'&&x<b.right+16&&x+440+16>b.left&&y<b.bottom+16&&y+424+16>b.top;}))break;
      }
      objects.push(p.donation?{id:p.id,kind:'donation',x,y,width:320,height:240,groupId:null}:{id:p.id,kind:'napplet',projectId:p.id,x,y,width:440,height:424,groupId:null});changed=true;
    }
    if(changed)workshop.db.run('UPDATE workshop_boards SET version=version+1,objects_json=? WHERE workshop_id=?',[JSON.stringify(objects),workshop.id]);
    const ids=new Set(napplets.map(p=>p.id));
    return {version:row.version+Number(changed),objects:objects.filter(o=>o.kind!=='napplet'||ids.has(o.projectId)),napplets};
  })();
}
function validateObject(value:any,active:Set<string>,workshop:Workshop):BoardObject {
  demand(value&&typeof value==='object'&&!Array.isArray(value),400,'Invalid board object');
  demand(typeof value.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(value.id),400,'Invalid object ID');
  demand(['napplet','text','image','group','donation','arrow'].includes(value.kind),400,'Invalid object kind');
  for(const key of ['x','y','width','height'])demand(typeof value[key]==='number'&&Number.isFinite(value[key]),400,'Invalid geometry');
  demand(Math.abs(value.x)<=50000&&Math.abs(value.y)<=50000&&value.width>=(value.kind==='arrow'?1:240)&&value.width<=4000&&value.height>=(value.kind==='arrow'?1:value.kind==='napplet'?200:100)&&value.height<=4000,400,'Board geometry is out of bounds');
  demand(value.groupId===null||typeof value.groupId==='string',400,'Invalid group');
  const o:BoardObject={id:value.id,kind:value.kind,x:value.x,y:value.y,width:value.width,height:value.height,groupId:value.groupId};
  if(o.kind==='napplet'){demand(value.projectId===o.id&&active.has(value.projectId),400,'Active Napplet required');o.projectId=value.projectId;}
  if(o.kind==='text'){o.text=text(value.text,'Board text',4000);const fontSize=value.fontSize??24;demand(Number.isInteger(fontSize)&&fontSize>=12&&fontSize<=144,400,'Text size must be 12–144');o.fontSize=fontSize;for(const key of ['bold','italic','underline','shadow'] as const){demand(value[key]===undefined||typeof value[key]==='boolean',400,'Invalid text effect');if(value[key]!==undefined)o[key]=value[key];}}
  if(o.kind==='arrow'){demand(value.colour===undefined||typeof value.colour==='string'&&/^#[0-9a-f]{6}$/i.test(value.colour),400,'Use a six-digit hex arrow colour');if(value.colour!==undefined)o.colour=value.colour.toLowerCase();demand(value.dotted===undefined||typeof value.dotted==='boolean',400,'Invalid dotted style');if(value.dotted!==undefined)o.dotted=value.dotted;demand((value.curveX===undefined)===(value.curveY===undefined),400,'Curve point requires both coordinates');if(value.curveX!==undefined)for(const key of ['curveX','curveY'] as const){demand(typeof value[key]==='number'&&Number.isFinite(value[key])&&Math.abs(value[key])<=4000&&Math.abs((key==='curveX'?o.x:o.y)+value[key])<=50000,400,'Invalid curve point');o[key]=value[key];}for(const key of ['endX','endY'] as const){demand(typeof value[key]==='number'&&Number.isFinite(value[key])&&Math.abs(value[key])<=4000,400,'Invalid arrow endpoint');o[key]=value[key];}demand(Math.hypot(o.endX!,o.endY!)>=8&&o.width===Math.max(1,Math.abs(o.endX!))&&o.height===Math.max(1,Math.abs(o.endY!)),400,'Invalid arrow bounds');demand(Math.abs(o.x+o.endX!)<=50000&&Math.abs(o.y+o.endY!)<=50000,400,'Arrow endpoint out of bounds');}
  if(o.kind==='donation')demand(o.id==='workshop-donation',400,'Invalid donation window');
  if(o.kind==='group'){o.label=text(value.label,'Group name',80);demand(o.groupId===null,400,'Groups cannot be nested');}
  if(o.kind==='image'){o.src=boardImageSource(workshop,value.src)||imageUrl(value.src);demand(o.src,400,'Image URL required');const host=new URL(o.src,'https://workshop.invalid').hostname;demand(!/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|localhost$)|\.(internal|localhost|local)$/.test(host),400,'Use a public HTTPS image');o.label=text(value.label,'Image description',200);}
  return o;
}
export function saveBoard(workshop:Workshop,member:Member,body:any) {
  // Resolve role from database at the request boundary, never from client fields.
  workshop.host(member);workshop.admitted(member);
  demand(body&&Number.isSafeInteger(body.expectedVersion)&&body.expectedVersion>=0,400,'Expected board version required');
  demand(Array.isArray(body.objects)&&body.objects.length<=700,400,'Board capacity reached');
  demand(Buffer.byteLength(JSON.stringify(body))<=200000,413,'Board payload too large');
  return workshop.db.transaction(()=>{
    const current=boardSnapshot(workshop);
    demand(current.version===body.expectedVersion,409,'The board changed. Reload layout before arranging again.');
    const active=new Set<string>(current.napplets.map(p=>p.id));
    const objects:BoardObject[]=body.objects.map((o:any)=>validateObject(o,active,workshop));
    const ids=new Set(objects.map(o=>o.id));demand(ids.size===objects.length,400,'Duplicate board object');
    demand(objects.filter(o=>o.kind==='donation').length===1,400,'Donation window must stay on the board');
    demand(objects.filter(o=>o.kind!=='napplet'&&o.kind!=='donation').length<=100,400,'Use at most 100 board decorations');
    demand(objects.filter(o=>o.kind==='napplet').length===active.size,400,'All active Napplets must stay on the board');
    for(const o of objects)if(o.groupId)demand(objects.some(g=>g.id===o.groupId&&g.kind==='group'),400,'Group not found');
    // Keep hidden placements privately, so moderation does not destroy layout.
    const row=workshop.db.query('SELECT objects_json FROM workshop_boards WHERE workshop_id=?').get(workshop.id) as any;
    const inactive=(JSON.parse(row.objects_json) as BoardObject[]).filter(o=>o.kind==='napplet'&&!active.has(o.projectId!)).map(o=>({...o,groupId:ids.has(o.groupId!)?o.groupId:null}));
    demand(workshop.db.run('UPDATE workshop_boards SET version=version+1,objects_json=? WHERE workshop_id=? AND version=?',[JSON.stringify([...objects,...inactive]),workshop.id,body.expectedVersion]).changes===1,409,'Board changed; reload layout');
    return boardSnapshot(workshop);
  })();
}
