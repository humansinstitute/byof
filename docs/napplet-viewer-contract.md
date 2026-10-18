# Napplet titles and workshop previews

Owners, workshop owners and site administrators can rename Napplets through the window settings cog or builder. `POST
/api/v1/projects/:id/rename` takes `{title}` and returns `{project}`. The title is
trimmed, required, at most 120 input characters, and cannot contain line breaks
or control characters. Browser rendering escapes titles and uses text attributes
for accessible names. Authentication, CSRF, admission, workshop selection and
project ownership or scoped workshop-administrator authority are required. Cross-workshop authority is never inferred.

Renaming updates only project metadata. It does not change source bytes, immutable
revisions, shared revision selection, consent, conversation history, builder state,
storage records or allowance. Windows, builder headings and preview names use the
saved metadata after reload.

The workshop desktop automatically plays every authorized active Napplet's current
completed checkpoint, independently of the selected publication revision. Hidden
projects and banned-owner projects are excluded. See
[Live workshop desktop](workshop-board-contract.md) for layout, permissions and
personal viewport behavior. Historical preview access and publication consent
remain distinct from admission to active app previews.

Each card has an accessible pop-out button outside the iframe. The same inline
`dialog` expands with `showModal()` and returns to its original size on close;
its iframe is never moved, cloned or recreated by expansion. Fullscreen uses the
existing document-root API, with a viewport fallback. Close and Escape return focus
to the opener. Preview Escape messages are accepted only from the active iframe
window. Card updates preserve unchanged iframe nodes; authorized revision changes
load the new revision. Modern browsers also preserve frames when cards reorder
through `moveBefore`; older browsers can reload a frame if its card is reordered.

Sandbox permissions remain `allow-scripts allow-forms`, with no same-origin
privilege and no-referrer policy. The preview response and the cache transport's
fresh runtime shell use the same content security policy. It permits direct HTTPS fetches and secure WSS
connections while continuing to deny remote active assets, frames, objects and form destinations; the iframe
also explicitly denies camera, microphone, geolocation and payment. No new app or
storage privileges are introduced.

## Immutable payload cache

The authenticated room/project response advertises each visible revision and its
immutable SHA-256 source hash. Cache Storage is consulted only after that room
access check. On a miss, the payload route repeats the access checks before
returning source bytes. Before any cached or downloaded source can execute, the
no-store runtime endpoint rechecks the current session, Canvas membership, project
visibility and exact revision access and issues a new one-use document binding.
Neither route treats possession of cached bytes as authorization.

Source HTML is retrieved separately through the authenticated payload endpoint.
The browser verifies both its advertised hash header and the SHA-256 of the bytes
before execution, then stores only those bytes in Cache Storage under a
schema-versioned content-hash key. A later load may reuse matching verified bytes,
including identical bytes from a fork, but still obtains a fresh runtime binding
for the fork's own project/revision/workshop identity. Session cookies, CSRF and
capability tokens, document IDs, consent and bridge state are never cached.

The freshly authorized runtime shell is a small iframe response with the existing
CSP and permissions headers. It requests the already verified source from the
trusted parent through a one-use `MessageChannel`, rehashes it inside the opaque
frame, and replaces itself with the source plus that load's fresh bridge. The
source transfer and document binding are ephemeral and never enter Cache Storage.

The cache keeps at most 64 payloads and removes oldest stored entries after a
successful write; browsers may evict them sooner. This cache is separate from
Napplet data storage, so cleanup cannot delete user data. Cache absence, quota or
operation failure, corrupt bytes, or a payload download failure falls back to the
existing authenticated `/preview` navigation and its clear server error behavior.
Room access and a fresh bridge remain online requirements; this is not offline
execution.

Validate with `bun run check`, `bun test ./tests ./src` and
`bun scripts/workshop-board-acceptance.ts`. The earlier embeds acceptance script
covers the superseded pinned-gallery UI. The browser script runs an isolated
real API with synthetic NIP-07 identities and Chrome, exercising desktop/mobile
interaction, persisted layout, active app admission, modal state continuity,
personal navigation, nonhost denial and automatic completed-version updates.
It does not register a managed browser fixture or authenticate as a human user.
Its screenshots and results are written under ignored `tmp/docs/handoffs/`.


Workshop windows show only the title and small minimize/restore, green pop-out,
and settings controls. Administrators see settings for every Napplet in their
selected workshop; ordinary nonowners see a secondary options menu for Fork.
The app viewport is 380px high, with full card width; the bar is
44px high and touch targets expand to 44px on coarse pointers. Author, version,
description, gallery headings and repeated builder buttons are omitted.

Minimize is reversible presentation state, scoped to workshop/project for the
current page session. It survives room events, rename and identity-menu rerenders.
The iframe remains mounted with its original dimensions but hidden, clipped and
inert until restored; data and saved revisions are never deleted. Pop-out also
restores a minimized window. Settings use a keyboard-accessible native dialog
with Escape and focus return. Workshop-owner and site-admin edits retain the
participant owner, use explicit scoped server authority and append immutable
audit rows for rename, activation, restore and sharing. Host conversation changes
continue through the separately audited host-follow-up route. Public publication
consent remains owner-only and cannot be supplied by an administrator.

Only a signed-in site administrator sees **Delete Napplet** in that settings
dialog. The destructive form identifies the Napplet, requires its exact current
title and revision, uses the normal CSRF-protected request path and does not
remove the window until the server commits. Active/uncertain requests, native
builder deletion and public publication claims fence deletion. The committed
operation tombstones the project, removes its saved Canvas object and app-local
Napplet data, revokes consent and hosted inclusion, and closes all private,
public-hosted and bridge access paths. Immutable revisions, request/guidance/
engine history, fork lineage, wallet records and admin audit rows remain intact;
their database triggers are not bypassed. Content-addressed assets, native
transcripts and externally stored publication objects are not erased or claimed
as erased by this action. Repeating a committed request returns not found.

Authenticated preview responses and fresh runtime bootstraps inject the [Napplet bridge v1](napplet-bridge-api.md) before app scripts. Identity consent, participant signing and durable per-user project storage travel over a channel bound to the existing frame. Both paths use the same opaque-origin sandbox and CSP: direct HTTPS/WSS service calls are allowed, while remote code, frames, objects and form destinations remain blocked. Removing/replacing a frame revokes its grants, while resize/minimize/pop-out preserve its channel with the document.
