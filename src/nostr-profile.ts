import { verifyEvent, type Event } from 'nostr-tools';

export const PROFILE_RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://purplepag.es'];
export const PROFILE_TTL = 24 * 60 * 60 * 1000;
export const PROFILE_RETRY = 5 * 60 * 1000;
export function humanText(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.replace(/npub1[0-9a-z]+|\b[a-f0-9]{64}\b|\bParticipant\s+[a-f0-9]{6,16}\b/gi, '').trim().slice(0, max) : '';
}
export function profileImageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || /^(localhost|127\.|0\.|\[|.*\.local$)/i.test(u.hostname) || /\.svg(?:$|\/)/i.test(u.pathname)) return '';
    return u.href;
  } catch { return ''; }
}
export function validMetadata(value: unknown, pubkey: string, now = Date.now()): Event | null {
  try {
    // Fresh JSON object: never trust nostr-tools' verified symbol on caller-owned objects.
    const e = JSON.parse(JSON.stringify(value));
    if (!/^[a-f0-9]{64}$/.test(pubkey) || e.pubkey !== pubkey || e.kind !== 0 || !Number.isSafeInteger(e.created_at) || e.created_at < 0 || e.created_at > Math.floor(now / 1000) + 60 || typeof e.content !== 'string' || e.content.length > 16384 || !verifyEvent(e)) return null;
    const p = JSON.parse(e.content);
    return p && typeof p === 'object' && !Array.isArray(p) ? e : null;
  } catch { return null; }
}
export function latestMetadata(values: unknown[], pubkey: string, now = Date.now()): Event | null {
  return values.map(e => validMetadata(e, pubkey, now)).filter((e): e is Event => !!e)
    .sort((a,b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0] || null;
}
export function metadataFields(event: Event | null) {
  const p = event ? JSON.parse(event.content) : {};
  return { name: humanText(p.display_name,60) || humanText(p.name,60) || 'Workshop participant', picture: profileImageUrl(p.picture), about: humanText(p.about) };
}
export function initials(name: string): string {
  return (humanText(name,60) || 'Workshop participant').split(/\s+/).slice(0,2).map(s=>Array.from(s)[0]).join('').toUpperCase();
}
