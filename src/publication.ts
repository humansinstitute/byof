import type { Database } from "bun:sqlite";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools";
import { sha256, type Assets } from "./assets.ts";
import { demand } from "./errors.ts";
import type { Member } from "./auth.ts";
import { now } from "./auth.ts";
import type { Workshop } from "./workshop.ts";
export const publicationSpecs = {
  naps: "e5308ac92cfd49e4fb026812c60886571515e219",
  nsite: "5d6b432267d4046464490b1923b96844ac4559d0",
  nappletDraft: "020cb8b33a9e4c6b8ca4b2f9d0ed0a67843b68f7",
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export type PublicApp = { projectId:string; revisionId:string; title:string; description:string; authorPubkey:string; authorName:string; number:number; sourceHash:string; originProject:string|null; originRevision:string|null };
export type Snapshot = { id:string; host:string; title:string; introduction:string; lightning:string; supportLabel?:string; siteName:string; apps:PublicApp[]; specs:typeof publicationSpecs; createdAt:number; workshopId?:string; };
export type PublicationPorts = {
  publisherPubkey:string;
  servers:string[];
  relays:string[];
  sign:(event:EventTemplate)=>Promise<Event>;
  upload:(server:string,hash:string,bytes:Uint8Array,contentType:string)=>Promise<void>;
  readAsset:(server:string,hash:string)=>Promise<Uint8Array>;
  publish:(relay:string,event:Event)=>Promise<void>;
  readEvent:(relay:string,eventId:string)=>Promise<Event|null>;
};
export function nsiteAggregate(paths: {path:string;hash:string}[]) { return sha256(paths.map(p=>`${p.hash} ${p.path}\n`).sort().join("")); }
export class Publication {
  constructor(private db:Database,private workshop:Workshop,private assets:Assets) {
    db.exec(`CREATE TABLE IF NOT EXISTS publication_snapshots(id TEXT PRIMARY KEY,host TEXT NOT NULL,body_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_operations(snapshot_id TEXT NOT NULL REFERENCES publication_snapshots(id),operation TEXT NOT NULL,status TEXT NOT NULL,event_json TEXT,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(snapshot_id,operation));
      CREATE TABLE IF NOT EXISTS publication_claims(snapshot_id TEXT PRIMARY KEY REFERENCES publication_snapshots(id),token TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS snapshot_body_immutable BEFORE UPDATE OF body_json,host,created_at ON publication_snapshots BEGIN SELECT RAISE(ABORT,'immutable publication snapshot'); END;`);
  }
  prepare(member:Member,selections:{projectId:string;revisionId:string}[],siteName="freedom"):Snapshot {
    this.workshop.host(member); demand(/^[a-z0-9-]{1,13}$/.test(siteName) && !siteName.endsWith("-"),400,"Site name must be 1–13 lowercase letters/digits/hyphens and cannot end in a hyphen");
    demand(Array.isArray(selections) && selections.length>0 && selections.length<=50,400,"Select 1–50 exact consenting revisions");
    demand(new Set(selections.map(s=>s.projectId)).size===selections.length,400,"Select each project once");
    return this.db.transaction(()=>{
      const room=this.workshop.roomRow();
      const apps=selections.map(selection=>{
        const row=this.db.query("SELECT p.*,m.pubkey,m.name,r.id revision_id,r.number,r.source_hash FROM projects p JOIN revisions r ON r.id=p.shared_revision JOIN members m ON m.pubkey=p.owner JOIN consent c ON c.project_id=p.id AND c.revision_id=r.id WHERE p.id=? AND r.id=? AND c.granted=1 AND p.hidden=0").get(selection.projectId,selection.revisionId) as any;
        demand(row && row.workshop_id===this.workshop.id && this.workshop.membership(row.owner)?.state==='admitted',409,"Selected revision is hidden, unshared, banned or missing exact-version public consent");
        this.assets.get(row.source_hash);
        return {projectId:row.id,revisionId:row.revision_id,title:row.title,description:row.description,authorPubkey:row.pubkey,authorName:row.name,number:row.number,sourceHash:row.source_hash,originProject:row.origin_project,originRevision:row.origin_revision};
      });
      const snapshot:Snapshot={id:crypto.randomUUID(),host:member.pubkey,workshopId:this.workshop.id,title:room.title,introduction:room.introduction,lightning:room.lightning,supportLabel:room.support_label,siteName,apps,specs:publicationSpecs,createdAt:now()};
      this.db.run("INSERT INTO publication_snapshots VALUES(?,?,?,?,?)",[snapshot.id,member.pubkey,JSON.stringify(snapshot),"prepared",now()]);return snapshot;
    })();
  }
  list(member:Member) {this.workshop.host(member);return this.db.query("SELECT id,status,created_at FROM publication_snapshots WHERE COALESCE(json_extract(body_json,'$.workshopId'),(SELECT workshop_id FROM workshop_identity WHERE id=1))=? ORDER BY created_at DESC").all(this.workshop.id).map((row:any)=>({...row,operations:this.db.query("SELECT operation,status,error FROM publication_operations WHERE snapshot_id=?").all(row.id)}));}
  private snapshot(member:Member,id:string):Snapshot {this.workshop.host(member);const row=this.db.query("SELECT body_json FROM publication_snapshots WHERE id=? AND host=?").get(id,member.pubkey) as any;demand(row,404,"Publication snapshot not found");const saved=JSON.parse(row.body_json);demand((saved.workshopId|| (this.db.query('SELECT workshop_id FROM workshop_identity WHERE id=1').get() as any).workshop_id)===this.workshop.id,404,'Snapshot not found');return saved;}
  private consentStillValid(snapshot:Snapshot) {
    for(const app of snapshot.apps) {
      const p=this.db.query("SELECT p.* FROM projects p JOIN consent c ON c.project_id=p.id AND c.revision_id=p.shared_revision WHERE p.id=? AND p.shared_revision=? AND p.hidden=0 AND c.granted=1").get(app.projectId,app.revisionId) as any;
      demand(p && p.workshop_id===this.workshop.id && this.workshop.membership(p.owner)?.state==='admitted',409,"Consent or workshop visibility changed; prepare a new publication snapshot");
    }
  }
  async publish(member:Member,id:string,ports:PublicationPorts) {
    const snapshot=this.snapshot(member,id);
    demand(/^[a-f0-9]{64}$/.test(ports.publisherPubkey),503,"Approved publication identity required");
    demand(ports.servers.length>0 && ports.relays.length>0,503,"Approved storage and relays required");
    for(const server of ports.servers) {const url=new URL(server);demand(url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash,503,"Publication storage must be approved HTTPS");}
    for(const relay of ports.relays) demand(new URL(relay).protocol==='wss:',503,"Publication relay must be approved WSS");
    this.consentStillValid(snapshot);
    const files=snapshot.apps.map(app=>({path:`/apps/${app.projectId}/index.html`,hash:app.sourceHash,bytes:new TextEncoder().encode(this.assets.get(app.sourceHash)),type:"text/html"}));
    const publicMetadata=JSON.stringify({title:snapshot.title,apps:snapshot.apps,specs:snapshot.specs},null,2);
    const metadataHash=sha256(publicMetadata);
    const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(snapshot.title)}</title><style>body{max-width:1180px;margin:auto;padding:32px;background:#f5f4ec;color:#20392f;font:16px system-ui}article{background:white;border-radius:18px;padding:24px;margin:20px 0}a{color:#315d43}</style><h1>${escapeHtml(snapshot.title)}</h1><p>${escapeHtml(snapshot.introduction)}</p>${snapshot.lightning?`<a href="lightning:${escapeHtml(snapshot.lightning)}">${escapeHtml(snapshot.supportLabel || 'Support this workshop')}</a>`:''}${snapshot.apps.map(app=>`<article><h2>${escapeHtml(app.title)} · v${app.number}</h2><p>${escapeHtml(app.description)}</p><p>By ${escapeHtml(app.authorName)} (${app.authorPubkey})${app.originProject?' · Fork lineage in source metadata':''}</p><a href="/apps/${app.projectId}/index.html">Try app</a></article>`).join('')}<a href="/workshop.json">Author credits, exact revisions and source lineage</a></html>`;
    files.push({path:"/index.html",hash:sha256(html),bytes:new TextEncoder().encode(html),type:"text/html"},{path:"/workshop.json",hash:metadataHash,bytes:new TextEncoder().encode(publicMetadata),type:"application/json"});
    const record=(operation:string,status:string,event:Event|null=null,error:string|null=null)=>this.db.run("INSERT INTO publication_operations VALUES(?,?,?,?,?,?) ON CONFLICT(snapshot_id,operation) DO UPDATE SET status=excluded.status,event_json=COALESCE(excluded.event_json,publication_operations.event_json),error=excluded.error,updated_at=excluded.updated_at",[id,operation,status,event?JSON.stringify(event):null,error,now()]);
    const execute=async(operation:string,work:()=>Promise<void>)=>{fence();this.consentStillValid(snapshot);record(operation,"pending");try{await work();fence();record(operation,"verified");}catch(error){if((this.db.query("SELECT token FROM publication_claims WHERE snapshot_id=?").get(id) as any)?.token===token)record(operation,"failed",null,error instanceof Error?error.message.slice(0,1000):"Remote operation failed");throw error;}};
    const token=crypto.randomUUID(), leaseMs=300000;
    this.db.transaction(()=>{
      const prior=this.db.query("SELECT * FROM publication_claims WHERE snapshot_id=?").get(id) as any;
      demand(!prior || prior.expires_at<=Date.now(),409,"Publication already has an active execution claim");
      if(prior) this.db.run("UPDATE publication_operations SET status='interrupted',error='Execution lease expired; remote state must be reverified' WHERE snapshot_id=? AND status='pending'",[id]);
      this.db.run("INSERT INTO publication_claims VALUES(?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at",[id,token,Date.now()+leaseMs]);
      this.db.run("UPDATE publication_snapshots SET status='publishing' WHERE id=?",[id]);
    })();
    const fence=()=>{const claim=this.db.query("SELECT token,expires_at FROM publication_claims WHERE snapshot_id=?").get(id) as any;demand(claim?.token===token && claim.expires_at>Date.now(),409,"Publication execution claim lost");this.db.run("UPDATE publication_claims SET expires_at=? WHERE snapshot_id=? AND token=?",[Date.now()+leaseMs,id,token]);};
    const heartbeat=setInterval(()=>{try{fence();}catch{}},30000);
    try {
      for(const file of files) for(const server of ports.servers) await execute(`asset:${server}:${file.hash}`,async()=>{
        // A saved receipt never substitutes for current remote byte verification.
        let bytes:Uint8Array|null=null;try{bytes=await ports.readAsset(server,file.hash);}catch{}
        if(!bytes || sha256(bytes)!==file.hash) {fence();this.consentStillValid(snapshot);await ports.upload(server,file.hash,file.bytes,file.type);bytes=await ports.readAsset(server,file.hash);}
        demand(sha256(bytes)===file.hash,502,"Remote asset hash verification failed");
      });
      const templates:EventTemplate[]=snapshot.apps.map(app=>({kind:5129,created_at:snapshot.createdAt,content:app.description,tags:[["x",app.sourceHash],["title",app.title],...ports.servers.map(server=>["server",server])]}));
      templates.push({kind:35128,created_at:snapshot.createdAt,content:"",tags:[["d",snapshot.siteName],...files.map(f=>["path",f.path,f.hash]),["x",nsiteAggregate(files),"aggregate"],["title",snapshot.title],["description",snapshot.introduction],...ports.servers.map(server=>["server",server])]});
      const events:Event[]=[];
      for(const [index,template] of templates.entries()) {
        fence();this.consentStillValid(snapshot);
        const op=`signed:${index}`,prior=this.db.query("SELECT event_json FROM publication_operations WHERE snapshot_id=? AND operation=?").get(id,op) as any;
        const event:Event=prior?.event_json?JSON.parse(prior.event_json):await ports.sign(template);
        demand(verifyEvent(JSON.parse(JSON.stringify(event))) && event.pubkey===ports.publisherPubkey && event.kind===template.kind && event.created_at===template.created_at && event.content===template.content && JSON.stringify(event.tags)===JSON.stringify(template.tags),502,"Publication signer changed identity or event");
        fence();record(op,"signed",event);events.push(event);
        for(const relay of ports.relays) await execute(`event:${relay}:${event.id}`,async()=>{const previous=await ports.readEvent(relay,event.id);if(!previous){fence();this.consentStillValid(snapshot);await ports.publish(relay,event);}const remote=await ports.readEvent(relay,event.id);demand(remote && verifyEvent(JSON.parse(JSON.stringify(remote))) && remote.id===event.id && remote.pubkey===event.pubkey && remote.kind===event.kind && remote.created_at===event.created_at && remote.content===event.content && JSON.stringify(remote.tags)===JSON.stringify(event.tags),502,"Remote event verification failed");});
      }
      this.consentStillValid(snapshot);
      this.db.run("UPDATE publication_snapshots SET status='verified' WHERE id=?",[id]);return {snapshotId:id,events:events.map(event=>({id:event.id,kind:event.kind})),siteCoordinate:`35128:${ports.publisherPubkey}:${snapshot.siteName}`};
    } catch(error) {if((this.db.query("SELECT token FROM publication_claims WHERE snapshot_id=?").get(id) as any)?.token===token)this.db.run("UPDATE publication_snapshots SET status='partial_failure' WHERE id=?",[id]);throw error;} finally {clearInterval(heartbeat);this.db.run("DELETE FROM publication_claims WHERE snapshot_id=? AND token=?",[id,token]);}
  }
}
