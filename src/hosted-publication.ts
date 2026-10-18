import type {Database} from 'bun:sqlite';
import type {Member} from './auth.ts';
import {now} from './auth.ts';
import type {Workshop} from './workshop.ts';
import {boardSnapshot, type BoardObject} from './workshop-board.ts';
import {demand} from './errors.ts';

const adjectives=['amber','brave','bright','calm','clear','coral','gentle','golden','happy','kind','lively','lucky','mint','quiet','rapid','silver','solar','tidy','warm','wild'];
const nouns=['badger','breeze','cedar','comet','dingo','fern','harbour','heron','island','koala','lantern','meadow','otter','pebble','quokka','river','sparrow','summit','willow','wren'];
const endings=['bay','bridge','cloud','cove','field','garden','grove','hill','isle','lake','path','point','ridge','shore','spring','stone','trail','vale','view','wood'];
export const reservedPublicNames=new Set(['api','app','assets','admin','auth','health','login','logout','p','public','static','www']);
export function canonicalPublicName(value:unknown) {
  demand(typeof value==='string',400,'Publication name required');
  const name=value.trim().toLowerCase();
  demand(name.length>=3&&name.length<=63&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name),400,'Use 3–63 lowercase letters, numbers and single hyphens');
  demand(!reservedPublicNames.has(name),409,'That publication name is reserved');
  return name;
}
export function randomPublicName(random:()=>number=()=>crypto.getRandomValues(new Uint32Array(1))[0]!/2**32) {
  const pick=(words:string[])=>words[Math.min(words.length-1,Math.floor(random()*words.length))]!;
  return `${pick(adjectives)}-${pick(nouns)}-${pick(endings)}`;
}
export type HostedNapplet={projectId:string;revisionId:string;title:string;description:string;authorName:string;authorPubkey:string;number:number;sourceHash:string};
export type HostedSnapshot={schema:1;workshopId:string;title:string;introduction:string;pictures:string[];lightning:string;supportLabel:string;boardVersion:number;objects:BoardObject[];napplets:HostedNapplet[];publishedAt:number};
export function installHostedPublication(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS hosted_publication_exclusions(
      workshop_id TEXT NOT NULL REFERENCES workshops(id),project_id TEXT NOT NULL REFERENCES projects(id),excluded INTEGER NOT NULL CHECK(excluded IN (0,1)),updated_at INTEGER NOT NULL,
      PRIMARY KEY(workshop_id,project_id));
    CREATE TABLE IF NOT EXISTS hosted_publications(
      workshop_id TEXT PRIMARY KEY REFERENCES workshops(id),alias TEXT NOT NULL UNIQUE,snapshot_json TEXT NOT NULL,version INTEGER NOT NULL,published_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hosted_publication_alias ON hosted_publications(alias);`);
}
export class HostedPublication {
  constructor(private db:Database,private workshop:Workshop){installHostedPublication(db);}
  private available(name:string,workshopId=this.workshop.id){return !this.db.query('SELECT workshop_id FROM hosted_publications WHERE alias=? AND workshop_id<>?').get(name,workshopId);}
  status(member:Member) {
    this.workshop.host(member);
    const publication=this.db.query('SELECT alias,version,published_at,updated_at FROM hosted_publications WHERE workshop_id=?').get(this.workshop.id) as any;
    const projects=this.db.query(`SELECT p.id,p.title,p.current_revision,p.hidden,m.name author,p.owner authorPubkey,
      COALESCE(e.excluded,0) excluded FROM projects p JOIN members m ON m.pubkey=p.owner
      LEFT JOIN hosted_publication_exclusions e ON e.workshop_id=p.workshop_id AND e.project_id=p.id
      WHERE p.workshop_id=? AND p.deleted_at IS NULL ORDER BY p.created_at,p.id`).all(this.workshop.id) as any[];
    return {publication,projects:projects.map(p=>({...p,includedByDefault:!p.excluded})),canChooseName:!!member.admin};
  }
  inclusion(member:Member,projectId:string,included:boolean) {
    this.workshop.host(member);demand(typeof included==='boolean',400,'Publication inclusion must be explicit');
    demand(this.db.query('SELECT id FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(projectId,this.workshop.id),404,'Napplet not found');
    this.db.run(`INSERT INTO hosted_publication_exclusions VALUES(?,?,?,?)
      ON CONFLICT(workshop_id,project_id) DO UPDATE SET excluded=excluded.excluded,updated_at=excluded.updated_at`,[this.workshop.id,projectId,Number(!included),now()]);
    const current=this.db.query('SELECT version FROM hosted_publications WHERE workshop_id=?').get(this.workshop.id) as any;
    if(current)this.publish(member,{expectedVersion:current.version});
    return this.status(member);
  }
  publish(member:Member,body:any,random:()=>number=Math.random) {
    this.workshop.host(member);
    demand(body&&Object.keys(body).every(k=>['name','expectedVersion'].includes(k)),400,'Unexpected publication field');
    if(body.name!==undefined)demand(member.admin,403,'Only a site administrator can choose a publication name');
    return this.db.transaction(()=>{
      const previous=this.db.query('SELECT * FROM hosted_publications WHERE workshop_id=?').get(this.workshop.id) as any;
      if(previous&&body.expectedVersion!==undefined)demand(body.expectedVersion===previous.version,409,'The public Canvas changed; reload before publishing again');
      if(!previous&&body.expectedVersion!==undefined)demand(body.expectedVersion===0,409,'The public Canvas changed; reload before publishing');
      let alias=previous?.alias as string|undefined;
      if(body.name!==undefined){alias=canonicalPublicName(body.name);demand(this.available(alias),409,'That publication name is already in use');}
      if(!alias){for(let attempt=0;attempt<128;attempt++){const candidate=randomPublicName(random);if(this.available(candidate)){alias=candidate;break;}}demand(alias,503,'A publication name could not be allocated; try again');}
      const board=boardSnapshot(this.workshop),room=this.workshop.roomRow();
      const excluded=new Set((this.db.query('SELECT project_id FROM hosted_publication_exclusions WHERE workshop_id=? AND excluded=1').all(this.workshop.id) as any[]).map(r=>r.project_id));
      const napplets:HostedNapplet[]=board.napplets.filter((p:any)=>p.current_revision&&!excluded.has(p.id)).map((p:any)=>{
        const row=this.db.query(`SELECT p.id,p.title,p.description,p.owner authorPubkey,m.name authorName,r.id revisionId,r.number,r.source_hash sourceHash
          FROM projects p JOIN members m ON m.pubkey=p.owner JOIN revisions r ON r.id=p.current_revision
          WHERE p.id=? AND p.workshop_id=? AND p.hidden=0 AND p.deleted_at IS NULL`).get(p.id,this.workshop.id) as any;
        demand(row&&this.workshop.projectOwnerAccess(row.authorPubkey)?.state==='admitted',409,'The Canvas changed while it was being published; try again');return {projectId:row.id,revisionId:row.revisionId,title:row.title,description:row.description,authorName:row.authorName,authorPubkey:row.authorPubkey,number:row.number,sourceHash:row.sourceHash};
      });
      const included=new Set(napplets.map(p=>p.projectId));
      const objects=board.objects.filter(o=>o.kind!=='napplet'||included.has(o.projectId!)).map(o=>structuredClone(o));
      const snapshot:HostedSnapshot={schema:1,workshopId:this.workshop.id,title:room.title,introduction:room.introduction,pictures:JSON.parse(room.pictures_json||'[]'),lightning:room.lightning,supportLabel:room.support_label||'Support this BYOF Canvas',boardVersion:board.version,objects,napplets,publishedAt:now()};
      const version=(previous?.version??0)+1,stamp=now();
      this.db.run(`INSERT INTO hosted_publications VALUES(?,?,?,?,?,?) ON CONFLICT(workshop_id) DO UPDATE SET alias=excluded.alias,snapshot_json=excluded.snapshot_json,version=excluded.version,updated_at=excluded.updated_at`,[this.workshop.id,alias,JSON.stringify(snapshot),version,previous?.published_at??stamp,stamp]);
      return {alias,url:`/p/${alias}`,version,publishedAt:previous?.published_at??stamp,updatedAt:stamp,snapshot};
    }).immediate();
  }
  static lookup(db:Database,alias:string):{alias:string;version:number;snapshot:HostedSnapshot}|null {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias))return null;
    const row=db.query('SELECT alias,version,snapshot_json FROM hosted_publications WHERE alias=?').get(alias) as any;
    if(!row)return null;try{
      const snapshot=JSON.parse(row.snapshot_json) as HostedSnapshot;
      const available=new Set(snapshot.napplets.filter(app=>{
        const project=db.query('SELECT hidden,owner FROM projects WHERE id=? AND workshop_id=? AND deleted_at IS NULL').get(app.projectId,snapshot.workshopId) as any;
        if(!project||project.hidden)return false;
        const exclusion=db.query('SELECT excluded FROM hosted_publication_exclusions WHERE workshop_id=? AND project_id=?').get(snapshot.workshopId,app.projectId) as any;
        if(exclusion?.excluded)return false;
        return true;
      }).map(app=>app.projectId));
      snapshot.napplets=snapshot.napplets.filter(app=>available.has(app.projectId));snapshot.objects=snapshot.objects.filter(o=>o.kind!=='napplet'||available.has(o.projectId!));
      return {alias:row.alias,version:row.version,snapshot};
    }catch{return null;}
  }
}
