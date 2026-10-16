# Browser-authorized Tower storage

Site Admin selects a workshop, connects the selected Tower using its exact
browser-signed workspace-list request, selects an authorized workspace and
reviews app access before signing. Two exact NIP-98 POST signatures register the
managed app namespace (`wapp`, `app-db`) and invite its app identity as a native
workspace guest. Guest permission is Tower-native workspace access, not a
storage-only token. The UI explains this scope and how to revoke both grants in
Tower. The app never stores the browser signatures as background credentials.

Autopilot retains the managed app signing identity. Freedom Tools records exact
successful native operations and destination bindings; a new destination is
accepted by the installed worker only from the authenticated app job endpoint,
with matching installation, workshop, app, workspace, owner and native grant IDs.
Every signed operation still checks the exact method, path, object, bytes and hash.
Private upload, readback and namespace receipts precede the ready state. A successful
browser signature alone never establishes readiness or a published version.

Install one immutable `storage-install.ts` worker with `installationWorkshops:true`
and `browserAuthorizedDestinations:true`, register its existing managed pipeline
grant through Autopilot's `clis/wapp-pipeline-grant.ts`, then use
`scripts/managed-storage-activate.ts` with the ignored grant receipt. The resulting
`FREEDOM_MANAGED_STORAGE_CONFIG` is installation-wide. Adding another Tower requires
browser authorization, not another worker, env entry or human private key.
Existing exact configurations, bindings and version destinations retain their
original worker grants. Build and restart only the authorized managed app.

Publication pipelines version 68+ add implementation-intent screening and read
current readiness during trusted preparation. Unready explicit builds stay saved;
unready auto requests run only when clearly conversational (implementation Noul
below 0.05). This is a conservative routing policy, not an authorization grant.
Allowed conversation is answer-only and publication remains independently gated.
The threshold requires validation on real workshop prompts; malformed/missing intent
answers fail closed. Moderation and independent ordinary final-message delivery remain
unchanged. No final prose is parsed to publish an app.

Cancellation before the bind request sends no grant. Closing a dialog after a bind
has been accepted stops polling, not the accepted remote operation. Reconnecting
reauthorizes the same destination and runs a fresh probe; exact signed-operation
replays reconcile recorded results. Active or uncertain builds fence reconnection.
Authorization failures mark storage as needing authorization without moving targets
or deleting versions. Unknown prepare outcomes remain fenced until reconciled.
Revocation is detected on the next storage operation or explicit reconnection check;
there is no claim of continuous permission monitoring. Remove/disable native access
in Tower to revoke it. A deployment must not fabricate human signatures to prove
end-to-end onboarding: local fixtures and live checks are reported separately.

Canvas creation now includes destination setup. Choose a registered Tower (or add
one in the creation form), save the Canvas details, then choose or create an
accessible workspace and review access in the same flow. A saved Canvas stays
setup-incomplete until its private probe succeeds. The Canvases list and Canvas
page offer **Complete setup** directly; setup never redirects to Site Admin.
Leaving setup or refusing a signature keeps the pending Canvas and entered details.
Creation uses a persistent browser intent and server-side actor/intent receipt to
avoid duplicate Canvases after reload or an uncertain create response. A pending
probe can be checked after reload without creating a workspace or signing again.

The workspace chooser labels reusable connections. Reuse requires recorded native
namespace and guest operations for the same installation, app, Tower, workspace
and owner, plus a ready binding and matching namespace receipt. The actor recorded
on the original grant is audit history, not the app grant's authority boundary.
The current actor must freshly prove access through a signed Tower workspace list;
that list still controls which destinations are accessible. Reuse copies only
durable authorization evidence into the new Canvas; it never uses stored signatures
as credentials. The new Canvas records the current actor and a fresh scoped private
probe must succeed before readiness. Revoked access leaves setup recoverable and
offers a new access review. Existing destination pins and stored versions remain
unchanged.

Browser validation is available through `bun tests/canvas-creation.browser.ts` and
`bun tests/tower-onboarding.browser.ts`. These run the real UI with synthetic API
responses and disposable signatures; they do not prove live human consent or a
real Nstack upload. Backend authority/idempotency checks live in
`tests/tower-connect.test.ts`.

If creation was left unfinished, **Create BYOF Canvas** offers **Resume saved setup**
and **Start another Canvas** explicitly. Starting another clears only the browser's
creation draft/intent; it preserves the pending Canvas and its Complete setup action.
