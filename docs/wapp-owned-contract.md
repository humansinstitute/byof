# BYO Freedom WApp boundary

Bun owns HTTP/WebSocket UI, Nostr challenge login, SQLite foreign-key/WAL
transactions and private SHA256 source objects. The managed runner supplies PORT;
public host identity and canonical HTTPS origin are configuration. A browser cannot
select its role, run, native session, directory, callback, or pipeline definition.

Temporary keys are generated in the browser and stored only in sessionStorage.
The server receives a signature and public key; sessions use HttpOnly,
SameSite=Strict cookies plus CSRF tokens and exact Origin checks for mutation.
Host authority compares verified public key against FREEDOM_HOST_NPUB. Admission
is invitation-only by default, with explicit pending/open policies available.

## Current capabilities

The six starters contain runnable source. Projects have an independent logical
conversation ID and immutable revisions. Restoring creates a new revision and
requires the expected current revision. Shared and consented revision pointers
are separate from the current draft. Forks copy the pinned shared source into a
new owned project with independent conversation/history and retained lineage.

Instructions persist privately with `unavailable` status while builder prerequisites
are missing. They do not invoke a builder or consume allowance. Previews retain the
current successful revision with sandbox="allow-scripts allow-forms", no allow-same-origin and
an opaque-origin CSP that allows direct HTTPS/WSS service calls but denies remote
active assets, frames, objects and form destinations. These previews are local workshop apps, not a claim of a
verified signed NIP-5D runtime. Native generation, progress streaming and publication
remain unavailable until the corresponding activated integrations pass acceptance.

## Callback integration

`POST /api/v1/pipeline/callback` is outside browser Origin/cookie/CSRF middleware.
It requires the pinned public delivery signer, NIP-98 exact URL/method/body hash,
freshness, unique tags, signed run/delivery/attempt and matching headers. The
pipeline-owned receiver module supplies verification. WApp `delivery-store.ts`
applies the business effect and receipt/event insertion in one transaction before
2xx. Reusing the same authorization event is rejected; a fresh signed retry of the
identical delivery is deduplicated. Different bytes for a delivery ID are rejected.

Only server-side accepted dispatch may call `bindRun(db, requestId, runId)` against
an already-persisted request. There is no public browser run-binding route. Callback
mapping derives owner/project from stored records. Classifier errors never ban.
Validated ban evidence hides only that member's projects, revokes consent and
cancels queued requests. Build failures preserve the successful source.
`build_completed` currently returns 503 without any promotion: the isolated build
artifact/session DTO and independent validation gate are not activated.

Before activating generation, agree the artifact manifest and source hash,
request/project/base revision, scoped session/native reference and binding generation.
Validate bytes outside the model, reject stale bases and retain immutable receipts.
Do not claim completion on pipeline submission acknowledgement.

## Finite capacity

50 memberships (including the host), 10 projects/member, one initial non-fork
project/member, 100 revisions/project, 200 saved instructions/project, 8,000
characters/instruction, 256 KB/app source, 300 KB/HTTP body, 4 WebSockets/member.
Default allowance is 20; host may set 0–100. The configured future builder budget
is 2; currently **zero builders execute**. Logical caps are admission controls,
not a measured AI throughput or latency promise. Owned handler tests measure
50 concurrent unavailable submissions across two participants; hosted HTTP/browser
measurements belong in ignored operational evidence.

## Validation and lifecycle

Run `bun test` and `bun run check`. Run builds and activation through
`bun clis/appctl.ts build|start|restart <app-id>` in the active Autopilot checkout.
`browser-acceptance.ts` uses the main managed URL for two real temporary identities
and a separate managed installation/database with a newly generated disposable
host identity for host/participant journeys. It never changes Pete's host identity
or starts an unmanaged localhost server. Browser evidence goes under ignored
`tmp/docs/handoffs/browser`. Set FREEDOM_BROWSER to an installed Chromium executable.

No Autopilot lifecycle operation is required or permitted by this slice. Source
and WApp activation do not activate new platform code. Keep umbrella delivery in
progress until actual builder, isolation, live moderation/progress and public
remote receipt acceptance pass.
