import { Workshop } from './workshop.ts';
import type { application } from './application.ts';
import type { Member } from './auth.ts';
export type EventClient = { member:Member; expiresAt:number; sessionHash:string; workshopId:string; projectId?:string; requestId?:string };
type Socket = {data:EventClient; send:(message:string)=>unknown; close:(code:number,reason:string)=>unknown};
/** One authorized request subscription per socket. Reconnect reads durable state,
 * never submits a build or trusts browser-provided run/session/owner identities. */
export class RequestEvents {
  private sockets = new Set<Socket>();
  private snapshots = new WeakMap<Socket,string>();
  constructor(private app:ReturnType<typeof application>) {}
  private scope(ws:Socket) {
    if (ws.data.expiresAt <= Date.now()/1000 || !this.app.auth.sessionActive(ws.data.sessionHash)) throw Error('Session expired');
    const scope=new Workshop(this.app.db,this.app.workshop.assets,ws.data.workshopId);
    const member=scope.scoped(this.app.auth.member(ws.data.member.pubkey));
    scope.admitted(member); return {scope,member};
  }
  open(ws:Socket) { this.sockets.add(ws); }
  close(ws:Socket) { this.sockets.delete(ws); this.snapshots.delete(ws); }
  message(ws:Socket,message:string) {
    try {
      const {scope,member}=this.scope(ws);
      if(message==='refresh'){ws.send(JSON.stringify({type:'room',data:scope.room(member)}));return;}
      const input=JSON.parse(message);
      if(input.type==='unsubscribe'){delete ws.data.projectId;delete ws.data.requestId;this.snapshots.delete(ws);return;}
      if(input.type!=='subscribe' || typeof input.projectId!=='string' || typeof input.requestId!=='string' || input.projectId.length>200 || input.requestId.length>200)throw Error('Invalid subscription');
      scope.project(member,input.projectId);
      if(!this.app.db.query('SELECT id FROM requests WHERE id=? AND project_id=?').get(input.requestId,input.projectId))throw Error('Request unavailable');
      ws.data.projectId=input.projectId;ws.data.requestId=input.requestId;this.snapshots.delete(ws);
      this.send(ws);
    } catch { ws.close(1008,'Request subscription unavailable'); }
  }
  private send(ws:Socket) {
    const {scope,member}=this.scope(ws);
    if(!ws.data.projectId || !ws.data.requestId)return;
    const detail=scope.detail(member,ws.data.projectId);
    const request=(detail.requests as any[]).find(r=>r.id===ws.data.requestId);
    if(!request)throw Error('Request unavailable');
    const snapshot=JSON.stringify({type:'request',workshopId:scope.id,projectId:detail.project.id,requestId:request.id,currentRevision:detail.project.current_revision,data:request});
    if(snapshot!==this.snapshots.get(ws)){ws.send(snapshot);this.snapshots.set(ws,snapshot);}
  }
  publish() {
    for(const ws of this.sockets){try{this.send(ws);}catch{ws.close(1008,'Request subscription unavailable');}}
  }
}
