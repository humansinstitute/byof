import { randomInt } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { sha256 } from './assets.ts';
import { demand } from './errors.ts';
// Persistent account and installation caps, deliberately independent of untrusted proxy headers.
export function codeAttempt(db:Database,pubkey:string) {
 const now=Math.floor(Date.now()/1000),window=600,bucket=Math.floor(now/window);
 db.exec('CREATE TABLE IF NOT EXISTS invitation_attempts(actor TEXT PRIMARY KEY,bucket INTEGER NOT NULL,attempts INTEGER NOT NULL)');
 db.run('DELETE FROM invitation_attempts WHERE bucket<?',[bucket]);
 db.transaction(()=>{
  for(const [actor,cap] of [[pubkey,10],['installation',300]] as const){const row=db.query('SELECT * FROM invitation_attempts WHERE actor=?').get(actor) as any;demand(!row||row.attempts<cap,429,'Too many code attempts. Try again in ten minutes.');}
  for(const actor of [pubkey,'installation'])db.run('INSERT INTO invitation_attempts VALUES(?,?,1) ON CONFLICT(actor) DO UPDATE SET attempts=attempts+1',[actor,bucket]);
 }).immediate();
}
export function newJoinCode(db:Database) {
 for(let attempt=0;attempt<100;attempt++){const code=String(randomInt(100000,1000000));if(!db.query('SELECT hash FROM invitations WHERE hash=?').get(sha256(code)))return code;}
 demand(false,503,'Join code capacity reached. Try again shortly.');
}

export function normalizedInvitation(value:unknown){if(value===undefined)return undefined;demand(typeof value==='string'&&value.length<=200,400,'Invalid invitation');return value.trim();}
export function shortInvitation(value:unknown){const token=normalizedInvitation(value);return !!token&&/^\d{6}$/.test(token);}
