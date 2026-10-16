# Project follow-up conversations

Current Napplet delivery uses [explicit native agent publication and independent final prose](agent-publication-contract.md). Receipt-based instructions below describe legacy owned-run recovery only; they must not be used for new requests.

BYO Freedom owns user instructions, request state, answers, project revisions and
allowance. Autopilot owns durable native completed turns, inference and signed
terminal delivery. `pipelines/followup.v5.json` uses coherent app-local preparation
and candidate functions around the existing `session.completedTurn` operation.
The previous approved operator definition remains available as v4.

This activation supports only an explicitly configured trusted owner/project.
Both the WApp configuration and the installed preparation function pin the owner
public key, project and conversation. The function also fixes the dedicated native
working directory. A caller cannot substitute another project or native binding.
This is a trusted response-only Codex SDK path with host permissions; prompting
against tools is not isolation. Ordinary participant execution remains gated until
the separately managed isolated native transport and its provider are activated
and actual filesystem/process/network/credential negative checks pass. Existing
managed Codex and Jev credentials support the trusted path without user key export.

`FREEDOM_FOLLOWUP_CONFIG` extends the installation broker configuration with
`projectId`, `ownerPubkey` and `conversationKey`. The server retains its opaque
credential-file reference. Install with `scripts/followup-install.ts`, supplying an
ignored scope JSON (`projectId`, `ownerPubkey`, `conversationKey`, `directory`) and
ignored receipt path. Installation preserves existing version files, verifies
identical retries, and rejects changed contents under an existing version. Register
a definition/function-hash-pinned app execution grant through the supported
Autopilot WApp pipeline management CLI before managed WApp activation.

Owners submit `POST /api/v1/projects/:id/requests` with `requestId`, exact `prompt`,
`expectedRevisionId` and optional `mode` (`auto`, `answer`, `build`). Questions and
suggestions in auto mode receive an answer; explicit implementation requests return
a complete candidate. Answer mode forbids a source result. An update must return
validated self-contained HTML and a readable explanation. Both results require a
completed native receipt correlated to the stored request/run/project, with the
same native conversation and an increasing sequence. Stopped dedicated sessions
resume through the existing generic native runtime.

New requests persist before dispatch. Only one request runs per project. The
transactional outbox retains the exact source snapshot and payload for retry;
Autopilot uses the saved request ID as its execution idempotency key. Dispatch
uncertainty is visible as `dispatch_pending`, and retries reconnect the same
request. A recent active claim is not dispatched again. A process-lost claim may
be reclaimed after 30 seconds using the same immutable payload. The browser keeps
a draft/request ID across response loss and reload. Changed content under that ID
is rejected. Terminal executions are never automatically replayed.

`POST /api/v1/projects/:id/requests/:requestId/resume` recovers an existing saved
unavailable or dispatch-pending request. Owners may reconnect their own requests;
the authenticated host may explicitly recover a saved request in the configured
trusted project. Recovery does not rewrite the instruction or its expected
revision. Origin, CSRF, membership, ownership/scope, pause and allowance checks
still apply. Unconfigured projects save requests without execution or charge.

A signed answer is persisted without changing revisions or charging allowance.
A signed update promotes only after native correlation, active membership,
unchanged expected revision and artifact validation. Invalid/stale candidates
produce a durable failed result; the last playable version and allowance remain.
Successful promotion, one allowance charge and the immutable delivery receipt
commit together. Fresh signed callback retries have no repeated effects; changed
payloads, stale signatures, auth replay or foreign correlations are rejected.
Jev's two independent probabilities keep the inclusive 0.95 ban threshold;
classifier errors never ban or run the agent.

The UI shows saved, connecting, working, reconnectable and terminal states, with
readable escaped answers. Agent commentary retains its server-accepted receive
time, while tool activity retains the signed source-event time. The UI renders
both in Perth/AWST, discloses the date outside the current Perth day and folds
consecutive tool events to the newest valid instant so late replay cannot move
the displayed time backwards. Historical events without a receiver timestamp do
not acquire a fabricated time. Polling reads the membership-protected project API.
Answer/progress refresh replaces only the conversation panel, preserving the
running preview. Larger/fullscreen controls remain available. Room sharing,
exact-version public consent and publication stay separate and unchanged.

Focused tests cover concurrent submissions, uncertain acceptance, immutable
retry payloads, recovery, native continuity/mode rejection, answer-only effects,
invalid/stale candidates and duplicate promotion/charging. Broader workshop v1
and public publication are not completed by this change.

## Explicit recovery before native send

V7 adds `recoverPreparation` to the generic completed-turn invocation. It is an
internal WApp recovery flag, never a browser-supplied native receipt or run ID.
The supported resume route may recover a failed request only after polling its
stored run through the signed managed broker and verifying the exact
`Completed-turn bound session unavailable` preparation failure, the same
request/project/conversation, and no execution/session/native/reply references.
The original immutable dispatch snapshot is reused. One durable recovery key is
used for the new pipeline invocation; the original run/dispatch/callback receipts
remain intact. The current request/run mapping changes only after new acceptance.
An uncertain recovery acceptance reconnects the same key. No general failed or
uncertain native send is replayed.

The generic runtime checks the original immutable completed-turn fingerprint,
owner and archived/live dedicated session binding. It resets only that known
pre-launch source lookup failure with no checkpoint or launch/send references,
no active claim and zero lease. It preserves the native receipt ID and sequence;
the exact original prompt completes once in the resumed native conversation.
Repeated recovery returns the same completed native receipt. Foreign bindings,
changed prompts, uncertain launches/sends and active claims remain fenced.

If a new definition is used for recovery, server-only `previousDefinitionId` and
`previousCredentialFile` allow polling the old run under its original pinned
grant. The new grant executes the recovery. Set `suspended: true` while required
native runtime activation is pending; scoped project requests then save without
execution. This suspension does not change any saved instruction or revision.
Install the new definition with an explicit version argument, for example `7`,
leaving previous versions unchanged. Native harness activation requires separate
Autopilot restart authorization; routine WApp restart alone does not activate it.

Explicit answer mode remains usable with zero build allowance. Auto/build mode
requires available build allowance. A version completed while the larger viewer
is open refreshes the saved preview after the viewer closes; the running expanded
preview is preserved until then.

## Builder retirement and replacement generations

The project conversation ID is stable. `builder_epochs` records explicit generation,
conversation key, reason and missing-session evidence. `request_epochs` stores an
immutable snapshot and maps each stable application request ID to its internal
native request ID (`<request>:generation:<n>`). A first replacement must complete
at sequence 1 with a different native ID; subsequent turns must retain that native
ID and increase sequence. Signed completions must match generation, internal ID,
context hash, project, current run and conversation key. Retired callbacks cannot
apply moderation, answers or builds to the active generation.

`DELETE /api/v1/projects/:id/builder` with `{generation}` is owner scoped and
idempotently retires the app association. It rejects active and uncertain requests.
It returns `nativeStorageDeleted:false`: native runtime/history deletion needs a
separate scoped platform capability. The UI calls this operation **Retire builder
session** and preserves app messages, revisions, consent and sharing.

A failed request can start a replacement only after a broker-signed owned-run poll
proves the known missing-bound-session preparation failure with no launch/send
references or native reply. The old native receipt stays fenced. An immutable
replacement snapshot contains the exact working directory, all saved user and
assistant messages in order, status/error evidence, authoritative current revision
and source, and a separate exact latest prompt. History is context; only the latest
prompt is actionable. Oversized context fails before dispatch rather than truncating.
Retries reuse the same generation, snapshot and execution key even after uncertain
acceptance. No restart of Autopilot is required for this WApp-owned fallback using
the existing generic `session.completedTurn` primitive.

Activation remains pinned to a trusted owner/project. General participant execution
and publication require their independent isolation and consent acceptance.

## Prepared native lifecycle activation

`POST /api/v1/projects/:id/builder/native` requires owner scope, the current
`generation`, and `confirmNativeTranscriptDeletion:true`. It stays disabled unless
a separately pinned `followup.nativeDeletion` managed pipeline grant is configured.
The prepared definition `pipelines/builder-deletion.v1.json` uses the generic
`session.deleteConversation` primitive, which currently requires separately
approved Autopilot activation. The installer refuses to proceed while that live
function is absent:

```
bun scripts/builder-deletion-install.ts ignored-scope.json ignored-install.json 1
```

Register the resulting definition with the supported managed grant CLI and use its
server-only metadata as `followup.nativeDeletion`. Routine BYO appctl activation
then exposes an explicit confirmation UI. The app fences the generation before
sending and persists one deletion ID, payload and accepted run. Uncertain acceptance
reconnects that same operation. Signed completion checks the exact generation,
conversation, native ID and Wingman session before retiring the association; it
never removes project messages, versions, consent or sharing. Native failure stays
fenced for reconciliation. Retirement cannot bypass a pending native deletion.

Deletion receipts explicitly distinguish runtime records and the JSONL transcript
from full provider storage. `nativeStorageDeleted:false` and
`metadataIndexesPreserved:true` remain truthful even after transcript removal.
The prepared platform implementation preserves its audit receipts and fences native
reuse of the deleted key. Hosted native deletion is still an activation acceptance
requirement; fixture tests and live association retirement are different evidence.

Repeated replacement is supported: `request_epoch_history` retains every immutable
snapshot for the same application request, while `request_recoveries` points at the
current attempt. `replacement_attempts` keeps prior acceptance and signed failure
proof. A verified missing session in an already replaced generation creates the
next generation with a new internal native request ID; a known preparation failure
before native execution retries the existing generation and snapshot. Neither path
rewrites old native receipts. Project revision is re-read after asynchronous proof
retrieval before dispatch, so an intervening restore cannot use stale source.

Native error callbacks whose execution is not proven absent or completed persist as
`execution_uncertain`, which occupies the project's single active slot. Retirement,
native deletion and new prompts refuse such projects. Current-run error evidence
also fences legacy records previously labelled `failed`; old failed-attempt receipts
are not confused with a replacement's current run. A later verified completion can
settle a current uncertain request once, without a resend or a second charge.

## Trusted owner multi-project routing

An installation may pin `ownerPubkey`, `builderRoot`, and the existing literal legacy project scope through `prepareTrustedFollowup`. Only that owner can create successive initial projects (up to the existing ten-project limit). General participants retain their existing gate. Newly created trusted projects use `byo:<owner>:project:<project UUID>` as their app conversation key; their cwd is exactly `<builderRoot>/<owner>/<project UUID>`. Routing rejects foreign owners, malformed UUIDs and another project's conversation key. The preparation function derives paths and rejects mismatching context; callers cannot supply a cwd. The installed directory helper refuses symlinks and noncanonical paths. This trusted account scope does not activate general participant isolation.

New projects bootstrap generation zero with exact saved history, current source/revision/hash and separately labelled latest prompt. No retirement or fabricated predecessor is required. Generation-zero native request IDs and context hashes use the same immutable mapping and signed callback validation as replacements. Later turns retain that native conversation, while explicit replacement advances the generation. The legacy project keeps its original conversation and directory. Jev policy, request/run idempotency, owner allowances and signed callback requirements remain unchanged. Native deletion remains independently gated and is unavailable for dynamically routed projects.

Install a new version with `scripts/followup-install.ts` using ignored JSON `{ownerPubkey,builderRoot,legacy:{ownerPubkey,projectId,conversationKey,directory}}`, then register its exact definition/function hashes with the existing managed app installation grant. Configure the matching `builderRoot` on the server; do not replace the legacy scope with a new test project.
