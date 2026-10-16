# Freedom Tools Napplet bridge v1

Authenticated previews receive `window.napplet` before app scripts run. All
methods return promises. Check capabilities and handle rejection; opening the
HTML outside Freedom Tools does not provide this API. This bridge adds public
participant identity, participant signing, durable app data and approved public relay reads to existing
preview/sharing behavior.

```js
const caps = await napplet.capabilities(); // No identity disclosed
const pubkey = await napplet.identity.getPublicKey(); // Host consent
await napplet.storage.set('settings', { theme: 'dark' });
const settings = await napplet.storage.get('settings'); // null when absent
await napplet.storage.remove('settings');
const event = await napplet.signing.signEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', 'my-napplet-record']],
  content: JSON.stringify({ message: 'User-approved record' })
}); // Trusted host inspection/consent, then current participant signer
```

Wrap requests in `try/catch` and display `error.message`; `error.code` supports
application-specific handling. The demonstration in
[templates/napplet-bridge-demo.html](../templates/napplet-bridge-demo.html)
exercises the actual injected API, including storage and signing. Do not bundle
a fake bridge, add a signer/key, or fetch host endpoints from the iframe.

| Method | Input | Result |
|---|---|---|
| `capabilities()` | none | version, exact methods, limits, signing availability/kinds, durable storage limits, read-only relay registry/limits and publication false |
| `identity.getPublicKey()` | none | authenticated participant's public hex key after a frame-specific grant |
| `signing.signEvent(event)` | unsigned `kind`, `created_at`, `tags`, `content` only | verified signed Nostr event with the authenticated participant's pubkey |
| `storage.get(key)` | ASCII key | stored JSON value or null |
| `storage.set(key,value)` | ASCII key, JSON value | resolves without a value |
| `relay.query(options)` | validated filters, optional relays/timeoutMs | bounded events, per-relay state, complete/partial/truncated |
| `relay.subscribe(options,{onEvent,onStatus})` | options plus local callbacks | `{id, close()}` handle; stored history followed by live events |
| `storage.remove(key)` | ASCII key | resolves without a value; absent keys are harmless |

Identity consent lasts only for this running frame/account/workshop/revision.
Every signing request shows the app title, workshop/project/revision, public
signing account and complete unsigned event in a trusted host dialog. Deny is the
initial focus. Signing then uses the actual active NIP-07 extension, verifies its
public key before and after signing and verifies the exact returned event and
signature. Extension rejection is preserved as a useful error. The authenticated session records the login signer type separately from the
member’s original signup type. Temporary users use their existing tab-local signer, with a visible warning about losing that
identity. Missing or changed signers fail; no server, agent or workshop signing
key is substituted. The signed result is returned to the app, which can display
or copy it; no relay publication is provided.

The initial signing subset permits kinds **1, 30023, 30024, 30078**. Authentication,
remote signing, delegation, manifests and private host-control events are outside
this allowlist. Delegation tags are rejected even on allowed kinds. Timestamps
must be within ten minutes, content at most 16 KiB, and tags at most 64 arrays of
at most eight strings (1,024 characters each). The app cannot supply a pubkey,
signature or event ID. Additional legitimate kinds need an explicit policy change.

Storage uses the app-local SQLite database, separately from Tower app-source
storage. Its namespace is **workshop + Napplet project + authenticated user**,
derived by the host/server, never supplied by child code. It survives page and
server reloads; it does not synchronize independent Freedom Tools installations.
Sharing an app shares its code, not its user records. A fork starts another
project namespace. Revisions of the same project use the same user's records.

Keys contain 1–128 ASCII letters/digits or `. _ : / -`, starting with a letter or
digit. Values are JSON, at most 32 KiB serialized UTF-8; a namespace holds at most
128 keys and 256 KiB of keys plus serialized values. Quota checks and writes are
transactional. Authenticated routes require matching origin, session and CSRF;
each operation rechecks workshop membership and revision preview authorization.
Host-held leases expire after one hour or logout/closure; reload/reopen to obtain
a new channel. Restarting the server invalidates channels, while retaining data.

The transport uses an opaque-origin `postMessage` readiness signal and one
transferred `MessageChannel`, protocol version 1. The host accepts only registered
iframe windows with its own authenticated preview URL and exact sandbox. A server-issued, one-use preview document identifier binds the handshake to the
actual authenticated document load; it expires after five minutes and cannot be
reused for another user, session, workshop, project or revision. Each
channel is bound to that window, URL/project/revision, workshop and current user.
Removal, navigation, account/workshop changes and logout close it and cancel
pending consent. The host's **Revoke Napplet permissions** button closes current
channels; reload/reopen to reconnect and request fresh consent. No iframe request
chooses identities, namespace, backend URL, CSRF, credentials or signer.

Requests are bounded to 48 KiB, four concurrent operations and 120 requests per
minute per frame. Host operations time out after 55 seconds; the injected client
waits at most 60 seconds. Handshakes time out after ten seconds. At most 64 active
leases per authenticated session and 1,000 per process are allowed. Consent UI
is globally serialized. Wire IDs are monotonically increasing and bounded;
unknown methods, unexpected parameters and replayed IDs never execute. Typical
codes: `DENIED`, `STALE`, `BUSY`, `TIMEOUT`, `INVALID`, `TOO_LARGE`, `QUOTA`,
`UNKNOWN_METHOD`, `FORBIDDEN`, `SIGNER_UNAVAILABLE`, `SIGNER_MISMATCH`,
`SIGNER_REJECTED`, `FAILED`. Invalid/replayed envelopes may be silently ignored.
Signing already approved and submitted to an external signer cannot be undone;
late results after revocation/timeouts are discarded. While an external signer
remains unresolved, further signing calls fail with BUSY; reload/reopen after
resolving the signer prompt.

Sandbox remains `allow-scripts allow-forms`, without same-origin access. The
network-denying CSP remains enforced, including `connect-src 'none'`, no frames,
external resources or form destinations. The bridge does not expose private
keys, host administration, generic fetch, relay publishing/AUTH, LLM APIs or external
manifest/app publication. Public read-only relay access stays in the trusted parent.

## Read-only relay domain

This additive v1 domain implements the read side of current
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), checked on
2026-10-13. Generated code cannot create sockets or select network destinations.
Only the trusted parent opens the exact approved public WSS registry:
`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`.
Other URLs, trailing paths/slashes, credentials, alternate schemes and private
addresses are rejected, including URLs in event tags. Parent CSP permits this
registry and retains `purplepag.es` for the host's separate profile reader;
that profile relay is not available to Napplets. There is no proxy, publication,
`EVENT` transmission, `AUTH` transmission or extra signing grant.

```js
const options = {
  filters: [{ kinds: [1], '#t': ['bussobushbash'], limit: 100 }],
  timeoutMs: 15000 // optional; 1000–20000
};
const result = await napplet.relay.query(options);
for (const event of result.events) addAsText(event); // textContent, never innerHTML
showRelayStates(result.relays, result.partial, result.truncated);
const subscription = await napplet.relay.subscribe(options, {
  onEvent(event, { relay }) { addAsText(event); },
  onStatus(status) { showConnectionState(status); }
});
// On manual refresh/teardown, close before opening another subscription.
await subscription.close(); // idempotent; sends NIP-01 CLOSE, unregisters callbacks
```

Callbacks belong in the second argument and never cross the channel. Their
return values are ignored; make them short, handle any asynchronous work's own
errors, and bound application arrays. Options are JSON: 1–4 filter objects,
optional subset `relays` of exact registry URLs, optional `timeoutMs`.
Supported fields: `ids`, `authors`, `kinds`, `since`, `until`, `limit`, and indexed
single-letter `#a`–`#z`/`#A`–`#Z` tag filters. Lists have 1–32 values, strings at
most 256 characters. IDs/authors/#e/#p are exact 64-character lowercase hex,
kinds are integers 0–65535, times are nonnegative safe integers with since <=
until. Unknown fields (including search) are rejected. Limits are 0–100,
default 100 per filter, apply only to stored history, and are enforced locally.
Conditions within a filter are AND, filters are OR, tag matching uses the first
value and is case-sensitive. Zero limit still permits future events after EOSE.

`query` resolves `{events, relays, complete, partial, truncated}`. Events are
signature-verified and filter-matched, deduplicated by ID, sorted newest first
with lowest ID first on ties, and selected by each requested filter's limit from
the bounded received union. At most 100 candidates and 252 KiB of event JSON are
buffered (256 KiB response budget including metadata). Larger responses stop with
partial/truncated status. This bounded selection cannot guarantee the newest
union if the relay exceeds capacity. `complete` means every requested relay
reached EOSE, not exhaustive history or guaranteed absence of posts. A deadline,
connection failure, refusal or capacity limit is reported per relay and yields
`partial:true`, including when zero events arrived. Invalid options reject the
promise. Do not turn failure into an empty newspaper; retain imported/cached
content and show the failed relay state.

Subscription status is `{url?,state,message,gapPossible?,retryMs?,truncated?}`.
States are connecting/loading, live after EOSE, recovering, failed, and closed.
Failed relay states can coexist with successful live relays. EOSE ends stored
history and keeps the NIP-01 REQ active for genuinely new events; no polling
substitution is used. Each relay's initial history is bounded by the requested
filters. Disconnects emit failed/retry status and reconnect with backoff
1, 2, 4, 8, 16, 30 seconds, at most six retries. Recovery replays from the first
disconnect minus 60 seconds, constrained by the original since, and deduplicates
already seen IDs. `gapPossible:true` remains explicit after recovery: limited
history or a long outage may leave gaps. Refusal/timeout/exhaustion ends an
unusable single-relay subscription with closed status, releasing its handle;
reopen explicitly to retry. With surviving relays, their live feed remains open.
NOTICE text is displayed only as status; AUTH/OK/unknown messages are ignored.

Bounds: four operations per frame, 24 per parent, three shared sockets (one per
approved relay), 16 KiB/event, 32 KiB/raw relay message, 128 messages/second/socket,
240 EVENT messages/minute/operation before signature work, 4096 unique live IDs.
Reaching the rate/dedupe cap closes the subscription with visible truncation.
The channel has at most 16 unacknowledged deliveries; client ACKs after local
callback dispatch. A slow consumer closes rather than growing a queue. Early
messages before a subscribe response are buffered locally up to 16/256 KiB.
Unacknowledged messages expire and close the binding. All sockets/operations
close on frame removal/navigation, sandbox changes, account/workshop change,
revocation, pagehide or one-hour lease expiry. A bounded authenticated lease
check every ten seconds detects server-side logout/access loss; five-second check
failure closes the channel. Reopening requires a fresh document-bound handshake.

Applications must render event content, names, tags and relay notices as text.
The host verifies signatures, not the truth or safety of content. Never load
runtime URLs/images/scripts from event data. Existing inline-assets validation,
opaque iframe origin and `connect-src 'none'` remain unchanged.

## Relationship to NAP

The inspected [pinned NAP registry](https://github.com/napplet/naps/blob/e5308ac92cfd49e4fb026812c60886571515e219/README.md)
separates optional capability contracts from transport projections and makes the
runtime the policy boundary. Its [pinned identity draft](https://github.com/napplet/naps/blob/e5308ac92cfd49e4fb026812c60886571515e219/naps/NAP-IDENTITY.md)
uses `identity.getPublicKey` for read-only identity, and routes signing through
relay publication. This implementation aligns with injected discovery, read-only
public identity and mediated scoped data, but adds its own `signing` domain and
versioned wire protocol. It uses authenticated workshop projects/revisions rather
than externally verified manifests. It is a **Freedom Tools subset, not a formal
NAP projection or full NAP-IDENTITY/STORAGE implementation**. The pinned registry
links the storage proposal through a draft PR; no pinned NAP-STORAGE file exists
at that revision. No unsupported domain is advertised.

## Builder guidance and verification

Defaults describe the implemented methods. On installation, only the exact old unsupported-capabilities and no-relay paragraphs in editable site/workshop prompts is replaced;
custom text and names stay intact, revisions increment once, and already queued
request/dispatch/epoch snapshots are untouched. The compact replacement is
shorter than both obsolete paragraphs, including for prompts at the size limit.
Fixed execution contracts and the managed builder template supply the full API
subset while retaining external-resource restrictions. HTML validation already
accepts inline bridge calls; its external embedding restrictions are unchanged.
Managed pipeline installations pin bundled code: Rick must coordinate activation
of the matching builder definitions/templates if their installed versions still
contain the obsolete fixed contract. Source edits alone do not replace installed
pipeline grants or immutable queued requests.

Run `bun run check`, `bun test ./tests ./src`, `bun run build`, then
`bun scripts/napplet-bridge-acceptance.ts` and `bun scripts/napplet-relay-acceptance.ts`. The browser fixture uses real Chrome,
a real isolated backend and synthetic identities; evidence remains under ignored
`tmp/docs/handoffs/`. Existing workshop/window acceptance scripts remain relevant.

## Canvas datasets

`await napplet.datasets.open({name,visibility})` requests inspectable host consent
for a named `shared` or `private` dataset on the current Canvas. Creation also
requires `description` and `fields: {fieldName: 'type and meaning'}`. Equivalent
field order is accepted; incompatible descriptions produce `CONFLICT`.
Shared access requires a current authenticated Canvas member. Private access
also requires the authenticated owner. Neither identity nor destination can be
chosen by the child. Closing the frame/token/session revokes its dataset grants.

The returned handle provides `get(key)`, `list()`,
`set(key, object, expectedVersion)`, `remove(key, expectedVersion)`, `watch(...)`
and `close()`. Values must be non-null JSON objects, at most 32 KiB of compact
UTF-8 JSON. Each dataset has 128 lifetime keys, including tombstones, bounding
compact values to 4 MiB without a racy byte sum. PostgreSQL bounds its expanded
JSONB text separately to 64 KiB per row (8 MiB total), allowing JSONB whitespace
and encoding expansion. Schema descriptions have a separate 2 KiB compact cap.
There are 64 shared schemas per Canvas and 64 private schemas per owner;
PostgreSQL unique allocation slots enforce both quotas under concurrent writes.

Missing keys return `{key,value:null,version:0}`. A create uses version zero.
Updates and removal require the current version. Removal stores an empty-object
tombstone and increments the version; `get` returns null with that nonzero
version, while `list` omits it. Recreating requires the tombstone's version.
Keys are never unconditionally deleted or recycled, preventing stale writes
from overwriting a newly recreated record. On conflict, refetch and resolve.
Cancellation after a write starts does not imply rollback; refetch its outcome.

Watches send invalidation hints, not values. Refetch on open, change and recovery.
The server shares one version-only poll per authorized dataset/owner, checks each
consumer's current access, and aborts when its last consumer leaves. Requests use
the Autopilot runtime-only app database broker capability, a fresh 15-second
request deadline and at most eight concurrent requests, without a waiting queue.
Streams have bounded queues; child delivery uses bounded acknowledgements.
Runtime values are never stored in pipeline jobs or builder snapshots. Historical
dataset jobs are removed when the corrected runtime starts.

Builder preparation supplies a fresh shared schema-only `canvasDatasets` snapshot.
Builders must inspect names and field descriptions before creating a scheme and
must treat unavailable discovery as unavailable, rather than an empty Canvas.
Private values are excluded. Existing project-private `napplet.storage` data is
unchanged; copying or sharing it requires an explicit user-directed migration.

Deployment requires the managed WApp's Tower DB runtime binding to match the
Canvas destination. A mismatched workspace/Tower fails explicitly; it is never
redirected to the app's bound destination. `scripts/canvas-broker-bind.ts` attaches
an existing authorized Canvas destination using supported WApp store methods,
preserving app key custody. The managed app must then restart to receive its
runtime-only capability. This does not require an Autopilot restart. The corrected
CREATE-only migration uses `canvas_dataset_records`; historical, unshipped
`canvas_data` rows remain untouched and are not silently copied or shared.
