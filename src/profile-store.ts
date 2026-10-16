import type { Database } from 'bun:sqlite';
import type { Member } from './auth.ts';
import { demand } from './errors.ts';
import { validMetadata, latestMetadata, metadataFields, humanText } from './nostr-profile.ts';
export function installProfileStore(db:Database){db.exec('CREATE TABLE IF NOT EXISTS nostr_profiles(pubkey TEXT PRIMARY KEY REFERENCES members(pubkey),event_json TEXT NOT NULL)');}
export function saveNostrProfile(db:Database,member:Member,body:any){
  const event=validMetadata(body?.event,member.pubkey);demand(event,400,'Invalid signed profile');
  const prior=db.query('SELECT event_json FROM nostr_profiles WHERE pubkey=?').get(member.pubkey) as any;
  const latest=latestMetadata([event,...(prior?[JSON.parse(prior.event_json)]:[])],member.pubkey)!;
  const fields=metadataFields(latest);
  db.transaction(()=>{db.run('INSERT INTO nostr_profiles VALUES(?,?) ON CONFLICT(pubkey) DO UPDATE SET event_json=excluded.event_json',[member.pubkey,JSON.stringify(latest)]);db.run('UPDATE members SET name=? WHERE pubkey=?',[fields.name,member.pubkey]);})();
  return {event:latest};
}
export function knownProfiles(db:Database,member:Member){
  demand(member.admin,403,'Site administrator access required');
  return {people:(db.query('SELECT m.pubkey,m.name,m.identity_type,n.event_json FROM members m LEFT JOIN nostr_profiles n ON n.pubkey=m.pubkey ORDER BY m.created_at,m.pubkey').all() as any[]).map(m=>({pubkey:m.pubkey,name:m.identity_type==='temporary'?(humanText(m.name,60)||'Workshop participant'):'Workshop participant',identity_type:m.identity_type,event:m.event_json?JSON.parse(m.event_json):null}))};
}
