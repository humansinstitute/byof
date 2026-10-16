# Stage-1 integration gate and implementation path

The gate is blocked. The current generic pipeline agent operation cannot bind a
project conversation and await its correlated completed turn. The Codex SDK
adapter runs with `danger-full-access` and `approvalPolicy: never`; its working
directory is not a filesystem, process, network or capability boundary. Stop before
participant builder execution until both prerequisites are resolved.

## Selected application design

Use Bun with native HTTP/WebSocket handling and `bun:sqlite`. SQLite uses foreign
keys, WAL, explicit transactions and unique constraints for project bindings,
request idempotency and delivery receipts. This is a selected implementation
direction, not an installed application or a proven capacity claim.

Store immutable source/build objects by SHA-256 in an app-private durable volume,
outside static routes. Promote only independently validated manifests/assets;
use atomic write/rename and never overwrite content-addressed objects. Separate
generated previews from workshop authentication with a restrictive sandbox and
deny network by default. Builder execution needs a separate enforced boundary.

Keep membership, ownership, queue order, bans, allowances, immutable revisions,
forks, consent and publication in the WApp. Neither Tower workshop routes nor
Flight Deck Agent Direct routing are required. No deployment destination or Git
remote has been selected. Provision a separate server-only app identity in the
managed environment and authorize its exact generic pipeline execution scope.
Never substitute the implementation worker's broker identity for the app identity.

## Verified native source contracts

References are relative to the active Autopilot repository, not the archived one.

| Operation | Verified boundary |
| --- | --- |
| `POST /api/pipelines/definitions/{id}/runs` | `mode=webhook`, immutable input, request idempotency, durable run/delivery; HTTP acceptance is not completion. |
| `GET /api/pipelines/webhook-signer` | Authenticated discovery of public delivery signer only. |
| Signed terminal webhook | NIP-98 exact receiver URL, method, body hash, freshness, pinned signer, delivery/run/attempt tags; immutable payload and durable retries. Public HTTPS receiver on port 443 required. |
| `POST /api/sessions/{id}/messages` | Prompt delivery followed by message-count update, not a typed request-correlated completed-turn receipt. |
| `POST /api/sessions/{id}/resume-native` | Source supports owner-checked native resume using saved provider conversation reference. Missing reference fails explicitly. New process/session binding must be persisted. |
| `GET /api/sessions/{id}/events` | Authenticated owner/admin session SSE; backend must authorize and filter participant progress before browser relay. |
| Generic `agent` pipeline step | Creates its own session; schema has no existing-session/native-binding selector. Finalization stops the session. |
| Codex native completed turn | `CodexAdapter.sendCompletedMessage` requires successful native `turn.completed`, but is not exposed as a generic public project-session operation. |

Inspect `src/pipelines/declarative.ts`, `pipeline-runner.ts` and
`agent-session-finalization.ts`; `src/server/session-api-routes.ts`,
`session-agent-message.ts` and `prompt-dispatch.ts`;
`src/sessions/native-resume-launch.ts`; and `src/agents/codex-adapter.ts`.
`src/agents/prompt-submission.ts` explicitly races native completion against the
user-message acceptance event; public delivery can therefore return while the
native turn continues.
The internal White Noise bridge uses the existing completed-turn method; that
business-specific bridge is evidence of a reusable primitive, not a workshop API
or an authorized substitute architecture.

## Smallest capability remedies

1. Expose a generic completed-turn session operation to the pipeline runtime.
   Reuse the native adapter primitive and native resume launch. Bind owner, session,
   request and native conversation; return a durable correlated terminal receipt.
   Serialize one active turn per conversation, preserve exact queued prompts and
   ensure retries cannot redeliver an already accepted request. Recover uncertainty
   without treating message-count growth as completion. The WApp keeps project
   binding and domain state; the platform keeps generic execution and turn receipts.
2. Provide a managed isolated builder profile. Run under a nonprivileged isolated
   process/container with only the project mounted, a private native conversation
   store, restricted network and process namespace, and explicitly scoped tools.
   Do not mount host home, other projects, service signer or manager credentials.
   Keep provider credentials behind a narrow proxy and app signing outside the
   builder. A broker capability must not grant general service management or
   unrestricted signing. Enforce resource/time limits for build scripts as well as
   agent tools. Validate denial with synthetic sibling-project, credential,
   process, network and capability fixtures in that actual managed profile.
3. Resolve the latest hosted suite architecture and rendered artifact access
   before modifying shared contracts. The current Artifact WApp authenticates
   broker NIP-98 on selected API families, including comments and flow state; it
   does not do so on catalog/frame/whiteboard routes. Use supported authenticated
   browser access or obtain a narrowly supported read path. Do not weaken ACLs.

These remedies are proposals for managerial review. No shared repository changes
or Autopilot activation were performed. Platform activation requires explicit
operator approval after source validation.

## Pipeline and receiver after prerequisites

Keep three meaningful operations visible: typed Jev screen, completed project
turn when allowed, terminal result. Use a trusted reusable function library for
WApp adapters rather than adding workshop rules to platform core.

The live [TypeSafe HTTP API](https://docs.typesafe.ai/api.md) and
[Noul guidance](https://docs.typesafe.ai/primitives/noul.md) specify one
`POST /v1/systemone` with two `questions` of `type: noul`. Read
`answers.<question>.noul`; require finite numbers in [0,1] and the expected answer
types. One question concerns malicious instruction bypass; the other unauthorized
private extraction. Explicit false criteria include normal edits and educational
quotations. Either probability at least 0.95 bans; 0.9499 does not. Missing,
malformed, nonfinite or out-of-range answers, timeouts and service failures return
retryable `classifier_error`, skip builder execution and never ban. Record actual
model and policy version. No live Jev integration has been implemented or tested.

Persist request/project/run/session/native-reference bindings before dispatch.
On webhook, verify signature and all tags, then resolve participant/room solely
from stored records. Atomically insert unique delivery receipt with result and
business effect; valid duplicate delivery returns 2xx. Preserve newer revisions
against stale callbacks. Allowance/ban checks occur before every dispatch.

The WApp backend subscribes to the bound native session SSE using fresh authorized
HTTP setup, filters to statuses and approved safe summaries, and relays through
membership-checked browser WebSocket. Never forward raw native tool/reasoning
events. Final state comes from the signed receipt. Reconnection does not submit a
new request; stream replay semantics still require verification.

## Required acceptance before the next stage

The native source validation command is:

```sh
bun test ./src/api-docs/openapi.test.ts ./src/pipelines/public-call-api.test.ts ./src/pipelines/result-webhooks.test.ts ./src/sessions/native-resume-launch.test.ts ./src/pipelines/agent-session-finalization.test.ts
```

These tests cover native contracts with fixtures, not live workshop acceptance.
Rerun stage 1 after the remedies: two real sequential prompts in one native
conversation, a stopped-session resume, terminal signed webhook receipts with real
request/project/run/session mappings, authenticated filtered progress and actual
managed isolation denial tests. Test duplicate submit/callback and classifier
injection/extraction branches, 0.9499/0.95, errors and quoted educational attacks.
Do not advance on delivery acknowledgement or synthetic UI timers.

Only after the gate passes proceed to participant identity/starters/build/reload,
host controls/moderation, immutable revisions/restore/fork/consent, then verified
Napplet/nsite publication. Publication requires fresh specification review,
configured approved signing/storage/relays and verified public receipts. Full v1
remains incomplete until all five stages and hosted operational checks pass.
