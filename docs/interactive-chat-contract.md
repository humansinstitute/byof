# Interactive builder chat

Freedom Tools receives public Agent Step activity through the Autopilot v1 contract
published in `docs/agent-step-activity-webhooks.md` in the active Autopilot source.
The native builder stays a `code` step calling `session.completedTurn`. Progress
never validates or promotes artifacts, charges allowance, completes a request, or
permits a new question. The signed final pipeline result retains that authority.

The installation's hash-pinned definition configures the literal public HTTPS URL
`/api/v1/pipeline/activity` and these root input selectors:

```json
{
  "requestId": "$.requestId",
  "projectId": "$.projectId",
  "workshopId": "$.workshopId",
  "nativeRequestId": "$.nativeRequestId",
  "generation": "$.activityGeneration"
}
```

The original request ID is distinct from the native request ID. The dispatcher
stores these identities, the generation string, workshop, project, accepted run,
receiver URL and definition ID in one transaction with managed acceptance. The
completedTurn step separately receives `requestId` from `$.nativeRequestId`.
Participant/model input cannot choose a receiver, run, session or owner.

## Receiver and lineage

The receiver validates fresh kind-27235 NIP-98 authorization from the pinned,
authenticated `/api/pipelines/webhook-signer` identity. Exact configured URL, POST
method, SHA-256 of raw UTF-8 bytes, event/run tags and event/run headers must agree.
Queries and alternate receiver paths are rejected. Stable accepted event IDs are
deduplicated with immutable raw-body hashes before freshness rejection; retries
cannot substitute a payload, sequence or tuple. Unseen expired authorization is
rejected. A callback is acknowledged only after its durable transaction commits.

The first instance-signed activity attests the generated original execution
run/step, Wingman session and durable turn receipt. Freeze that tuple after checking
saved application authority. `turnId` is `receiptId`, not `executionId`. The final
native receipt preserves `runId`, `stepId`, `sessionId`, `executionId`, `receiptId`,
`nativeSessionId`, sequence, generation/context hash, and current invocation IDs.
Reconcile original execution IDs with progress; current invocation IDs identify
accepted pipeline calls and can differ on recovery. Recovery's allowed original
receipt lineage comes only from an owned-run broker poll or its already verified
stored final receipt. Progress cannot authorize recovery or another writer.

Missing progress never gates a valid final. A final received before activity is
processed normally. Late events are receipted as tombstones without publishing
content or changing terminal state. Revoked participant activity is likewise
receipted without content. Retired generation and unrelated request/run/turn
bindings are rejected. Existing native continuity, mode, artifact validation,
revision checks, storage verification and charging remain in final processing.

## Ordering and browser delivery

Persist up to 256 public events plus one terminal hint per turn. Commentary is
limited to 4,000 characters; tools and hints are fixed strings. Sequence uniqueness
and event/body conflicts are enforced. Snapshots sort each turn by source sequence,
record `gapBefore` when delivery exhausts an earlier event, and fill gaps if lower
sequences arrive later. Out-of-order arrival cannot reorder the restored transcript.

`/api/v1/events` retains same-origin cookie authentication. A socket subscribes to
one explicit saved request under an authorized private project and workshop.
Every publication rechecks session lifetime, current membership and project access.
Workshop sharing never grants private conversation access. After reconnect, the
server sends the full durable request snapshot; it never dispatches or resubmits
work. HTTP project detail restores the full history after refresh and remains the
fallback while sockets are unavailable.

Chat renders escaped public commentary and one `Using tools` indicator per
consecutive group; commentary starts another group. Terminal activity hints say
that final checking is pending and leave Send disabled. The complete public final
response is retained for answer-only, app-changing and failed-validation outcomes,
with failure/completion shown separately. Unsent drafts survive updates. Final
responses are never shortened for display: the explicit receiver bounds are
512,000 response characters and a 1 MiB signed callback body; oversized results
fail validation rather than silently truncate. The generated app's source remains
subject to its separate 256,000-byte limit.

## Installation and validation

`scripts/activity-install.ts` versions the exact installed definitions, preserves
native/storage routing, rebuilds scoped preparation/candidate/storage functions,
configures the confirmed selectors, reads the definition back, and registers a new
managed grant that pins definition/function hashes and the final callback URL.
It requires ignored/untracked installation plans and evidence. It does not change
live environment configuration or activate services. Keep old grants available for
already accepted run polling and explicit saved recovery.

Run `bun run check`, `bun test ./tests ./src`, `bun run build` and
`bun scripts/chat-acceptance.ts`. The last command exercises production routes,
signed callback verification, WebSocket subscriptions and browser behavior using
synthetic callback data; it is explicitly local evidence, not native/live acceptance.

After the reviewed Autopilot prerequisite is activated by its authorized operator,
apply the staged managed configuration and activate only Freedom Tools through the
managed app runner. Verify health/build manifest and exact assets, error log,
request-scoped progress, a full answer-only turn, an app-changing turn, two real
native turns, and participant boundaries. No fixture proves live native delivery.
