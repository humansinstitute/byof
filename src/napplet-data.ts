import type { Database } from 'bun:sqlite';
import type { Workshop } from './workshop.ts';
import type { Member } from './auth.ts';
import { demand } from './errors.ts';
export const nappletDataLimits = { keyBytes: 128, valueBytes: 32768, quotaBytes: 262144, keys: 128 };
type Binding = { sessionHash: string; user: string; workshop: string; project: string; revision: string; expires: number };
// Tokens stay in the trusted parent, never in generated source or child messages.
export class NappletData {
  private bindings = new Map<string, Binding>();
  private documents = new Map<string, Binding>();
  private closeListeners=new Set<(token:string)=>void>();
  onClose(listener:(token:string)=>void){this.closeListeners.add(listener);}
  private closeToken(token:string){this.bindings.delete(token);for(const listener of this.closeListeners)listener(token);}
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS napplet_user_data(workshop_id TEXT NOT NULL REFERENCES workshops(id),project_id TEXT NOT NULL REFERENCES projects(id),user_pubkey TEXT NOT NULL REFERENCES members(pubkey),key TEXT NOT NULL,value_json TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(workshop_id,project_id,user_pubkey,key));`);
  }
  issueDocument(workshop: Workshop, member: Member, sessionHash: string, project: string, revision: string) {
    for(const [id,b] of this.documents)if(b.expires<=Date.now())this.documents.delete(id);
    demand(this.documents.size<1000,429,'Preview document capacity reached');
    const id=crypto.randomUUID();this.documents.set(id,{sessionHash,user:member.pubkey,workshop:workshop.id,project,revision,expires:Date.now()+300000});return id;
  }
  open(workshop: Workshop, member: Member, sessionHash: string, body: any) {
    demand(Object.keys(body).every(k=>['projectId','revisionId','documentId'].includes(k)),400,'Unexpected bridge binding field');
    demand(typeof body.projectId==='string' && typeof body.revisionId==='string',400,'Project and revision required');
    const document=this.documents.get(body.documentId);
    demand(document && document.expires>Date.now() && document.sessionHash===sessionHash && document.user===member.pubkey && document.workshop===workshop.id && document.project===body.projectId && document.revision===body.revisionId,403,'Preview document binding expired or mismatched');
    workshop.previewRevision(member,body.projectId,body.revisionId);
    for(const [token,b] of this.bindings)if(b.expires<=Date.now())this.closeToken(token);
    demand(this.bindings.size<1000 && [...this.bindings.values()].filter(b=>b.sessionHash===sessionHash).length<64,429,'Bridge capacity reached');
    this.documents.delete(body.documentId);
    const token=crypto.randomUUID(), expires=Date.now()+3600000;
    this.bindings.set(token,{sessionHash,user:member.pubkey,workshop:workshop.id,project:body.projectId,revision:body.revisionId,expires});
    const project=this.db.query('SELECT title FROM projects WHERE id=?').get(body.projectId) as any;
    const revision=workshop.revision(body.projectId,body.revisionId);
    return {token,expires,user:member.pubkey,identityType:member.identity_type,title:project.title,workshopTitle:workshop.roomRow().title,revisionNumber:revision.number};
  }
  activeToken(token:string){const b=this.bindings.get(token);if(b&&b.expires<=Date.now())this.closeToken(token);return !!b&&b.expires>Date.now();}
  authorize(workshop:Workshop,member:Member,sessionHash:string,token:string){
    const b=this.bindings.get(token);
    demand(b&&b.expires>Date.now()&&b.sessionHash===sessionHash&&b.user===member.pubkey&&b.workshop===workshop.id,403,'Bridge binding expired or mismatched');
    workshop.admitted(member);workshop.previewRevision(member,b.project,b.revision);return b;
  }
  closeSession(sessionHash: string) { for(const [id,b] of this.documents)if(b.sessionHash===sessionHash)this.documents.delete(id); for(const [token,b] of this.bindings)if(b.sessionHash===sessionHash)this.closeToken(token); }
  operate(workshop: Workshop, member: Member, sessionHash: string, body: any) {
    demand(Object.keys(body).every(k=>['token','method','key','value'].includes(k)),400,'Unexpected data field');
    const b=this.bindings.get(body.token);
    demand(b && b.expires>Date.now() && b.sessionHash===sessionHash && b.user===member.pubkey && b.workshop===workshop.id,403,'Bridge binding expired or mismatched');
    if(body.method==='close'){this.closeToken(body.token);return {ok:true};}
    workshop.previewRevision(member,b.project,b.revision);
    const scope=[b.workshop,b.project,b.user];
    if(body.method==='check')return {user:member.pubkey,identityType:member.identity_type};
    demand(['get','set','remove'].includes(body.method),400,'Unknown storage method');
    demand(typeof body.key==='string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(body.key),400,'Storage key must contain 1–128 ASCII letters, digits or . _ : / -');
    if(body.method==='get'){const row=this.db.query('SELECT value_json FROM napplet_user_data WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND key=?').get(...scope,body.key) as any;return {value:row?JSON.parse(row.value_json):null};}
    if(body.method==='remove'){this.db.run('DELETE FROM napplet_user_data WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND key=?',[...scope,body.key]);return {ok:true};}
    demand(body.value!==undefined,400,'JSON value required');
    const value=JSON.stringify(body.value),bytes=Buffer.byteLength(value)+Buffer.byteLength(body.key);
    demand(Buffer.byteLength(value)<=nappletDataLimits.valueBytes,413,'Storage value exceeds 32 KiB');
    return this.db.transaction(()=>{
      const totals=this.db.query('SELECT count(*) count,COALESCE(sum(bytes),0) bytes FROM napplet_user_data WHERE workshop_id=? AND project_id=? AND user_pubkey=?').get(...scope) as any;
      const old=this.db.query('SELECT bytes FROM napplet_user_data WHERE workshop_id=? AND project_id=? AND user_pubkey=? AND key=?').get(...scope,body.key) as any;
      demand(totals.count+(old?0:1)<=nappletDataLimits.keys && totals.bytes-(old?.bytes||0)+bytes<=nappletDataLimits.quotaBytes,413,'Napplet user storage quota exceeded');
      this.db.run('INSERT INTO napplet_user_data VALUES(?,?,?,?,?,?) ON CONFLICT(workshop_id,project_id,user_pubkey,key) DO UPDATE SET value_json=excluded.value_json,bytes=excluded.bytes',[...scope,body.key,value,bytes]);return {ok:true};
    }).immediate();
  }
}
