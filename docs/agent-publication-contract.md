# Native Napplet publication and conversational completion

The app owns admission, project routing, version allocation, storage jobs,
publication receipts, conversation messages and allowance charges. Autopilot
owns native execution, session capabilities, immutable pipeline function pins
and completed-turn delivery. Tower owns shared authority and private S3 storage.

Each Napplet keeps `ROOT/<workshopId>/<projectId>` across turns. The app allocates
an immutable request draft and saves its exact context. The native builder edits
and tests that draft and preserves supporting files. New requests declare
`fileBuild.publication = agent-tool-v1`.

The native agent explicitly calls:

```sh
bun .agents/napplet-publish.js publish "Actual browser check and result"
```

This CLI sends its opaque session capability to Autopilot's loopback
`POST /api/mcp/wingman/project-tool`. Only one live leased native turn in that
session can call a tool registered on its immutable `session.completedTurn`
step. Tool names resolve to hash-pinned app-owned functions. Request/project,
run/step, receipt/session/native identity, sequence and saved pipeline input come
from trusted execution state, never CLI arguments. Builders can supply validation
results but cannot select another path, grant, workspace, object or callback.

`publishNativeNapplet` calls the app's signed publication-intent endpoint, then
uses the existing managed Tower storage transport and jobs. For a remote builder,
the installation-pinned tool reads only the assigned regular file and sends its
bounded bytes and hash to the app's exact app-authenticated candidate endpoint.
The app rechecks request authority, path/version, encoding, hash and HTML before
staging those bytes under its own allocated draft path and creating the intent.
Retries accept only the same bytes. Signing keys remain in callback-only custody.
Scratch, history, instructions and supporting files are never transferred. Tower
object ownership, uploader, filename, size, completion hash and exact byte
readback are independently verified. Namespace receipts retain recovery evidence.

The signed `/api/v1/publication/version` webhook checks the immutable intent,
request/run/project/generation/native lineage, admission, allowance, base revision,
assigned path/version, completed local hashes and verified storage job. A single
transaction registers the immutable revision, URL, hash, storage reference and
charge. Repeated matching publication receipts acknowledge the same version.
Changed or stale receipts cannot create an effect. The request remains building
until its conversational turn completes; the frontend already receives the
registered authenticated app URL and can load it. Private S3 content is relayed
through the app's authenticated preview using a managed verified content read.

The completed-turn pipeline separately returns `message_completed` with native
lineage and the ordinary final prose verbatim to `/api/v1/pipeline/message`.
It does not discover artifacts, parse prose, upload storage or register versions.
The app saves a separate final-message receipt and finishes conversation state.
Answers do not call publication and create no version or allowance charge. A
claimed implementation without publication is shown as unpublished. Durable
publication failure remains pending, with the last app playable and a useful
error; storage retry resumes the same job without rerunning the native turn.

Normal HTTPS anchor citations are navigation and pass validation. External
runtime resources and embedding remain rejected; CSP enforces the network
boundary even for dynamically constructed URLs. Public Blossom/Nostr publication
remains a separate consented feature.

## Installation and activation

`pipelines/followup.v65.json` retains independent preparation, screening,
moderation, native turn, final message and delivery steps. Publication is a tool
called inside the native turn, with its own durable app state, rather than a
storage step after completion. `scripts/followup-install.ts` installs immutable
function/definition versions and pins the managed installation scope.

Register a managed grant whose callback is `/api/v1/pipeline/message`. Route all
capable scopes to the new definition with `agentPublication:true`; retain prior
scope grants and definition versions for already owned receipt-protocol recovery.
Do not route old immutable requests into the new protocol. Editable known stock
HTML/JSON-receipt guidance is migrated; immutable old request snapshots remain
recovery evidence. The new preparation function requires the explicit protocol
marker, so missing state cannot fall back to prose artifact parsing.

Autopilot must run the generic native project-tool dispatcher before routing
new requests to this definition. Check its capability endpoint using an ordinary
implementation session capability. The activation helper checks dispatcher readiness
and the exact managed grant. Autopilot source activation requires explicit
Autopilot restart approval. A previously live unscoped native session needs a
newly scoped native resume, preserving its native thread. Never silently reuse
its broad capability or erase conversation history.

The dispatcher narrows signing and record authority for scoped project sessions.
That capability boundary alone is not a filesystem sandbox: the existing native
SDK launcher uses `danger-full-access`. Host filesystem isolation must be audited
and enforced before claiming participant builders cannot read unrelated files or
host credentials. Do not treat prompt restrictions as that enforcement. Live
native tool publication, real S3 readback, independent message receipt, browser
controls, managed asset hashes and post-activation logs are separate acceptance
requirements; local tests are not live acceptance.
