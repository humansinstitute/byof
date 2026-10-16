import { generateSecretKey, finalizeEvent, getPublicKey, verifyEvent, getEventHash } from "nostr-tools";
const storageKey = "liquid-freedom-temporary-key-v1";
export function temporaryIdentity() {
  let hex = sessionStorage.getItem(storageKey);
  if (!hex) { hex = Array.from(generateSecretKey(), byte => byte.toString(16).padStart(2, "0")).join(""); sessionStorage.setItem(storageKey, hex); }
  const secret = Uint8Array.from(hex.match(/.{2}/g)!.map(value => parseInt(value, 16)));
  return { publicKey: getPublicKey(secret), getPublicKey: () => getPublicKey(secret), signEvent: (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secret) };
}
export function forgetTemporaryIdentity() { sessionStorage.removeItem(storageKey); cachedTemporarySigner = null; }
export { browserProfileCache, humanText, initials } from './profile-cache.ts';

let cachedTemporarySigner: ReturnType<typeof temporaryIdentity> | null = null;
export function participantSigner(identityType: string) {
  if (identityType === 'temporary') {
    if (!sessionStorage.getItem(storageKey)) { cachedTemporarySigner = null; return null; }
    if (!cachedTemporarySigner) cachedTemporarySigner = temporaryIdentity();
    return cachedTemporarySigner;
  }
  return (window as any).nostr?.getPublicKey && (window as any).nostr?.signEvent ? (window as any).nostr : null;
}
export { verifyEvent, getEventHash };
