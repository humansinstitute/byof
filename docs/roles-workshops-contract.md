# Profiles, site administration and workshops

The avatar menu contains exactly **My Profile**, **Workshops**, and **Site Admin**
for site administrators. Other users see only the first two. Profile presentation
uses Nostr kind-0 names and decoded avatars, with a neutral name and initials
when metadata is missing. Public keys remain internal authorization identifiers;
they are never displayed as names or entered in owner selectors.

My Profile contains Sign out and explicit **Save on this device** edits. Device
edits are separate per-account overlays, and **Use Nostr profile** restores the
signed source. No profile event is published and no signing prompt is requested
for profile reading or local edits. Temporary identities retain their tab key
and device-name behavior; signing out removes access to that temporary identity.

Workshops lists and opens specific workshops. Admins can create a workshop here,
choosing a registered Tower and an existing account by profile name. Each workshop
page exposes an accessible Edit workshop icon to its owner and site admins. Its
edit page exposes People & settings and Publication. Site administrators manage
builder guidance in Site Admin → System prompts, with explicit saved prompt scopes.
Site Admin manages Tower connections. All permissions are enforced by the server,
with origin and CSRF checks on mutations. Owners cannot create workshops or manage
Tower connections. `FREEDOM_HOST_NPUB` bootstraps site/legacy-workshop ownership;
`FREEDOM_ADMIN_NPUBS` optionally adds site administrators. New workshops use approval
admission. Existing public-key API contracts remain unchanged.

Every admitted participant may fork any visible, active Napplet in the selected
workshop. The fork keeps exact source lineage but receives its own participant
owner, project identity, revisions, conversation, requests, builder runtime and
publication choices. Hidden, unavailable, banned-owner and cross-workshop sources
remain unavailable. Workshop owners and site administrators can list, open,
rename, converse with, activate versions and manage sharing for every Napplet in
their selected workshop without ownership transfer. Administrative conversation
changes use the explicit audited host-follow-up route; metadata/version/sharing
actions have immutable actor/owner audit rows. Only the participant owner can
grant exact-version public publication consent. A workshop or site administrator
who owns a project is treated as active even without a redundant membership row,
including persisted forks created before this rule was centralized.

## Nostr profile cache

`nostr-profile.ts` verifies fresh copies of signed kind-0 events with nostr-tools,
checks the exact author, bounded content and timestamps, rejects invalid JSON,
and chooses highest creation time with lowest event ID for a deterministic tie.
Names prefer display_name then name, with public-key strings removed from human
text. `profile-cache.ts` owns cache-first browser hydration and local edits. Its
per-public-key cache persists the signed event and bounded raster data bytes in
localStorage, with an in-memory fallback if browser storage is unavailable/full.
Relay reads are limited to the app's three configured public metadata relays,
coalesced per account, and bounded to 3.5 seconds. Verified metadata refreshes at
most once per 24 hours; failures persist a five-minute retry delay. Navigation
and ordinary reload use cached metadata and avatar bytes without network reads.
Cached events are reverified on hydration; another account cannot hydrate them.

Avatar downloads accept public HTTPS URLs and raster MIME types only, omit
credentials/referrers, validate the final HTTPS URL after redirects, and limit downloads to 2 MiB/five seconds.
The browser must decode the image; dimensions/pixel count are bounded and a canvas
normalizes it to at most 128 pixels per side and 180 KB of PNG data URL text.
Only those local bytes enter avatar image elements. Downloads coalesce by URL.
Decode/download failure preserves the prior avatar for that same account while
retrying after five minutes. Removing picture clears it. Relay failures preserve
cached identity. Clearing browser storage requires a new lookup. Cross-origin
image hosts must permit CORS; unavailable hosts fall back to initials or prior
cached bytes. No image proxy or arbitrary unverified account import is provided.

The authenticated profile/nostr route accepts only the current account's verified
signed event and preserves the latest event monotonically. It stores signed source
for named owner choices and updates the member display name for gallery attribution;
it does not publish to relays or change authorization. Site/people is admin-only.
Other people's metadata is read and cached through the same verified resolver.
Legacy app-local profile APIs remain self-owned for compatibility and temporary
profiles; they do not replace signed metadata in the extension user's avatar.

Validation: `bun test` covers signature/author failures, ties, expiry, request and
image coalescing, durable reload, offline retry, identity separation and local
edits. `scripts/profile-browser-acceptance.ts` uses the registered disposable
fixture with synthetic signed relay events and decoded PNG responses to exercise
exact desktop/mobile menus, network counts, delayed/offline relay, role/server
permissions, workshop creation/editing, project/gallery continuity and sign-out.
Real public relay metadata/image decoding is checked separately during activation.

## Workshop boundary and migration

Authenticated requests select a workshop with `x-workshop-id`, or `workshop`
in preview/WebSocket URLs. Omitting selection uses the persisted legacy UUID.
The UI retains selection in its URL, including previews. Each request constructs
its own Workshop instance; selection does not mutate shared server context.
Project lookup, private detail, sharing, fork source, preview revision, request,
receipt inspection, native lifecycle, moderation and guidance enforce the same
workshop boundary. Private drafts, immutable revisions and exact consent remain.
Public anonymous publication remains gated.

The additive migration copies the legacy room into workshop metadata while
retaining the old room/member tables as its authoritative settings/membership
source. Existing admission, bans, allowances, invitations and audit records stay
in place. Existing project workshop IDs, builder directories, execution scopes,
requests, revisions, immutable request snapshots, storage objects and receipts
are preserved. The project workshop ID becomes immutable after assignment.
New workshop memberships and guidance use separate records. Existing singleton
storage binding stays in its original table; additional workshop bindings and
storage jobs carry explicit workshop identity. Signed completion checks and
allowance changes use the project's workshop membership.

## Tower registration and activation

Site administration registers public HTTPS Tower origins. Select a workshop and
click **Connect Tower**. Its signed-in administrator chooses an authorized Tower
workspace, or explicitly creates one using Tower's direct
`POST /api/v4/admin/flightdeck-pg/workspaces` route. That route requires the
signer to be a Tower admin. This flow does not depend on hosted signup.
Creation uses the BYO app identity, signer creator identity and a stable service
identity derived from the installation/actor/Tower/creation intent. The browser
retains that public intent across reloads; the server persists its exact payload
and completed response. Uncertain retries reuse Tower's same identity tuple.
Creating a workspace does not change a workshop destination: selecting it is
an explicit subsequent action.

Selection automatically requests exact browser signatures to register BYO's
own app namespace and grant its managed identity guest membership. The app
then dispatches a private probe through the managed connector, provisions the
BYO receipt table/migration, uploads an object, verifies its exact bytes/hash,
and waits for the correlated signed storage delivery. Only then does the UI
show Ready. An already verified namespace/guest authority is reused only for
the same installation/Tower/owner/app and, for membership, exact workspace. A
new workshop still runs a fresh probe, so revoked authority cannot become ready.
Failures remain visible with a saved-setup retry; no manual
namespace/probe checklist is needed. Existing bindings are immutable. Reconnect
returns their saved ready state without polling a completed historical run.
Use another workshop for a different destination; existing versions require an
explicit migration before a binding can move.

`FREEDOM_STORAGE_CONFIG` retains the legacy installation and
`FREEDOM_WORKSHOP_STORAGE_CONFIG` retains explicitly installed workshops.
`FREEDOM_STORAGE_TEMPLATES` supplies an operator-approved managed connector for
each exact Tower origin. Additional workshops on that Tower automatically save
an installation configuration in `managed_workshop_storage`; configuration
includes only public identity and server-local credential references, never key
or bearer values. The saved installation, Tower, app identity, local root and
workspace destination remain pinned. Pipeline execution authority resolves from
the installation's current template so an immutable definition/grant rotation
cannot leave existing workshops submitting an old definition with a new grant.
The saved row is not rewritten during resolution. Existing definitions, grants,
jobs and targets are retained.

Install the template once with `scripts/storage-install.ts` using an ignored
`ManagedStorageScope` with `installationWorkshops: true`, register its immutable
definition/function hashes with Autopilot's `clis/wapp-pipeline-grant.ts`, then
run `scripts/storage-template-setup.ts <ignored-grant-receipt.json>` in the app
repository. The latter updates only the template environment setting and
preserves legacy configuration. Activate only the authorized BYO managed app.
The connector's bootstrap reads the app's signed internal job API. It accepts
only this installation, an explicit valid workshop UUID, the pinned Tower/app
identity and durable job ID. Every namespace/storage operation remains pinned
to that job's workspace, object, exact migration/receipt, bytes and method.
The browser and builder receive no signing key or operator capability.
The host's existing approved HTTP-origin allowance must include that exact
Tower; registering an arbitrary new Tower cannot confer platform authority.

App-db namespaces are Tower-owner/app scoped. Multiple PG workspace UUIDs owned
by one person can share the BYO schema; every receipt still records the actual
selected workspace UUID and app installation. BYO does not use Flight Deck's
product schema. Participants and workshop owners without the site-admin role
cannot configure this connector.

New workshops do not inherit any legacy trusted native execution. They can use
runnable starters, private revisions, workshop sharing, preview and forks; saved
instructions explicitly report unavailable execution without charging allowance.
Activating workshop native execution is separate platform/operator coordination.

## Validation

Run `bun test`, `bun run check`, `bun run build`. The role/workshop suite tests
profile ownership/CSRF, independent workshop roles, gallery/fork/project/preview/
request/moderation isolation, guidance snapshots, registration/readiness separation,
repeated-start preservation and an actual pre-workshop SQLite schema migration.
Existing suites retain native execution, callback, receipt and publication checks.

`scripts/roles-browser-acceptance.ts` runs desktop/mobile journeys against a
registered disposable Freedom Tools browser fixture. Set
`FREEDOM_ROLES_FIXTURE_APP_ID`, `FREEDOM_ROLES_FIXTURE_URL`,
`FREEDOM_ROLES_FIXTURE_ROOT` and `FREEDOM_ROLES_EVIDENCE_DIR` (ignored paths). It verifies the
fixture's registered label/root/URL before changing its public test configuration
and invoking managed appctl. Synthetic signing keys stay in memory. Operational
screenshots, fixture data and receipts remain ignored under tmp/docs/handoffs.
Fixture HTTPS raster URLs are intercepted with deterministic PNG bytes; decoded
image width is verified after reload. Production configuration/authentication is
never rewritten for these tests.

Managed-runtime WebSocket refresh checks use the selected workshop and fresh
membership on every message. The fixture also records the hosted proxy result.
If Autopilot's hosted WebSocket proxy omits the browser Origin upstream, it cannot
satisfy the app's exact origin upgrade check; the proxy must preserve Origin along
with the cookie. Report that platform requirement separately, without weakening
app authorization or changing shared runtime contracts as part of this app change.


`scripts/tower-connect-browser-acceptance.ts <ignored-host-api-adapter.ts>
<ignored-evidence-directory>` exercises the hosted actual-button UI at desktop
and mobile sizes using explicitly synthetic Tower API responses and an in-memory
signer. It checks exact direct-admin and scoped grant signature payloads,
explicit destination confirmation, failure/retry, one creation and no overflow.
It supplements backend tests; it does not establish live Tower provisioning.
Live acceptance must separately use an authorized Tower-admin browser signer,
create/select a workspace, reach Ready through actual signed storage delivery,
and verify a private version's upload/readback.
