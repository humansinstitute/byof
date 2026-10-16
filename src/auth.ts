import { normalizedInvitation, shortInvitation } from './invitation-codes.ts';
import type { Database } from "bun:sqlite";
import { verifyEvent, type Event } from "nostr-tools";
import { sha256 } from "./assets.ts";
import { demand, text } from "./errors.ts";
import { limits, type Config } from "./config.ts";
export type Member = { pubkey: string; name: string; identity_type: string; state: string; allowance: number; host: boolean; admin?: boolean; workshopOwner?: boolean; workshopId?: string; picture?: string; about?: string; npub?: string; };
export const now = () => Math.floor(Date.now() / 1000);
export class Auth {
  constructor(private db: Database, private config: Config) {}
  isHost(pubkey: string) { return pubkey === this.config.hostPubkey || !!this.config.adminPubkeys?.includes(pubkey); }
  challenge(origin: string) {
    const id = crypto.randomUUID(), nonce = crypto.randomUUID(), expiresAt = now() + 120;
    this.db.run("DELETE FROM challenges WHERE expires_at < ?", [now()]);
    demand((this.db.query("SELECT COUNT(*) n FROM challenges").get() as any).n < 500, 429, "Sign-in capacity reached; retry shortly");
    this.db.run("INSERT INTO challenges(id,nonce,origin,expires_at) VALUES(?,?,?,?)", [id, nonce, origin, expiresAt]);
    return { id, expiresAt, event: { kind: 27235, created_at: now(), tags: [["u", `${origin}/api/v1/login`], ["method", "POST"], ["challenge", nonce]], content: `BYO Freedom sign-in: ${nonce}` } };
  }
  login(body: any, origin: string) {
    const id = text(body.challengeId, "Challenge", 100), event = body.event as Event;
    let valid = false; try { valid = verifyEvent(event); } catch {}
    demand(valid, 401, "Nostr signature is invalid");
    const challenge = this.db.query("SELECT * FROM challenges WHERE id=?").get(id) as any;
    const single = (key: string, expected: string) => event.tags.filter(tag => tag[0] === key).length === 1 && event.tags.find(tag => tag[0] === key)?.[1] === expected;
    demand(challenge && !challenge.used && challenge.expires_at >= now() && challenge.origin === origin, 401, "Challenge expired or already used");
    demand(event.kind === 27235 && Math.abs(event.created_at - now()) <= 120 && single("u", `${origin}/api/v1/login`) && single("method", "POST") && single("challenge", challenge.nonce) && event.content === `BYO Freedom sign-in: ${challenge.nonce}`, 401, "Signature does not match this fresh sign-in challenge");
    demand(body.identityType === "temporary" || body.identityType === "extension", 400, "Unknown identity type");
    const invitation=normalizedInvitation(body.invitation);
    demand(!shortInvitation(invitation),400,"Sign in, then redeem the six-digit workshop code");
    const host = this.isHost(event.pubkey);
    demand(!body.host || (host && body.identityType === "extension"), 403, "This identity is not the configured workshop host");
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`, csrf = crypto.randomUUID(), expiresAt = now() + 86400;
    return this.db.transaction(() => {
      const claimed = this.db.run("UPDATE challenges SET used=1 WHERE id=? AND used=0", [id]); demand(claimed.changes === 1, 401, "Challenge already used");
      const existing = this.db.query("SELECT * FROM members WHERE pubkey=?").get(event.pubkey) as any;
      if (!existing) {
        demand((this.db.query("SELECT COUNT(*) n FROM members").get() as any).n < limits.participants, 409, "Room membership capacity reached");
        const room = this.db.query("SELECT admission FROM room WHERE id=1").get() as any;
        let admitted = host || room.admission === "open";
        if (!admitted && invitation) {
          const used = this.db.run("UPDATE invitations SET remaining=remaining-1 WHERE hash=? AND workshop_id=(SELECT workshop_id FROM workshop_identity WHERE id=1) AND remaining>0 AND expires_at>=?", [sha256(text(invitation, "Invitation", 200)), now()]);
          demand(used.changes === 1, 403, "Invitation is invalid or exhausted"); admitted = true;
        }
        this.db.run("INSERT INTO members(pubkey,name,identity_type,state,created_at) VALUES(?,?,?,?,?)", [event.pubkey, text(body.name || 'Workshop participant', "Display name", 60), body.identityType, admitted ? "admitted" : "pending", now()]);
      }
      this.db.run("DELETE FROM sessions WHERE expires_at<=?", [now()]);
      this.db.run("DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE pubkey=? ORDER BY expires_at DESC,rowid DESC LIMIT -1 OFFSET 7)", [event.pubkey]);
      this.db.run("INSERT INTO sessions(hash,pubkey,csrf,expires_at,identity_type) VALUES(?,?,?,?,?)", [sha256(token), event.pubkey, csrf, expiresAt, body.identityType]);
      return { token, csrf, member: {...this.member(event.pubkey),identity_type:body.identityType}, expiresAt };
    })();
  }
  member(pubkey: string): Member { const member = this.db.query("SELECT * FROM members WHERE pubkey=?").get(pubkey) as any; demand(member, 401, "Sign in again"); return { ...member, admin: this.isHost(pubkey), host: this.isHost(pubkey) }; }
  session(request: Request, mutation = false): { member: Member; csrf: string; expiresAt: number; sessionHash: string } {
    const token = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("lf_session="))?.slice(11);
    demand(token, 401, "Please sign in");
    const session = this.db.query("SELECT * FROM sessions WHERE hash=? AND expires_at>?").get(sha256(token), now()) as any;
    demand(session, 401, "Session expired; please sign in");
    if (mutation) demand(request.headers.get("x-csrf-token") === session.csrf, 403, "Refresh this page before making changes");
    const member=this.member(session.pubkey);
    return { member: {...member,identity_type:session.identity_type||member.identity_type}, csrf: session.csrf, expiresAt: session.expires_at, sessionHash: session.hash };
  }
  sessionActive(hash: string) { return !!this.db.query("SELECT hash FROM sessions WHERE hash=? AND expires_at>?").get(hash, now()); }
  logout(request: Request) { const token = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith("lf_session="))?.slice(11); if (token) this.db.run("DELETE FROM sessions WHERE hash=?", [sha256(token)]); }
}
