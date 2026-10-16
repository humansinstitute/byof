# BYO Freedom pipeline integration

Current Napplet delivery uses [explicit native agent publication and independent final prose](agent-publication-contract.md). Receipt-based instructions below describe legacy owned-run recovery only; they must not be used for new requests.

The application pipeline has four visible operations: one typed Jev screen, a
true/false ban decision, a persistent project builder, and a terminal result.
Version 1 installs an explicitly unavailable builder operation. It never claims
that submission, prompt delivery or a configuration check completed a build.

`pipelines/freedomtools-build.v1.json` is the reusable definition. Function modules
are bundled from app-owned source by `scripts/pipeline-install.ts` and installed
through authenticated Autopilot file APIs. No runtime database edits or host
restart are required. Run the installer from this repository with `WINGMAN_URL`
and a current implementation session capability, passing an ignored, untracked
receipt file. This implementation capability is only for installation and proof;
it must not be used as the deployed application's credential.

```sh
bun scripts/pipeline-install.ts tmp/docs/handoffs/pipeline-install-receipts.json
bun test src/pipeline
bunx tsc --noEmit --skipLibCheck
```

The installer uses exclusively created versioned files. It does not overwrite
existing functions; changes require a new function version and definition version.
Use Autopilot's `POST /api/pipelines/definitions/{id}/manual-edit` for subsequent
definition versions. Keep historical function names available for pinned runs.
Operational IDs, signed run receipts and environment-specific public signer pins
belong on the task or in ignored evidence, not this reusable document.

## Screening

`screenPrompt` makes exactly one request to the [TypeSafe HTTP
API](https://docs.typesafe.ai/api.md), with both [Noul
questions](https://docs.typesafe.ai/primitives/noul.md). Questions explicitly exclude
normal edits and quoted teaching/test attacks. The server validates both answer
types and finite probabilities in `[0,1]` before applying
`injection >= 0.95 || extraction >= 0.95`. `0.9499` allows; `0.95` bans.
API failures, timeout, malformed output and missing configuration produce a
retryable `classifier_error`, `banRequired:false`, and no builder call.

Supply a new app-authorized TypeSafe credential only to the trusted classifier
service. Version 1's trusted function reads `FREEDOMTOOLS_TYPESAFE_API_KEY` from
its server environment. Never pass this value in pipeline input, logs or builder
environment. Adding a credential to an already-running Autopilot environment
requires operator-approved activation; do not restart it from a worker. An
alternative app-owned classifier service must authenticate server callers and
keep the same single-call/result contract. It cannot trust browser probabilities.

## Request and completion

The WApp persists request/ownership/queue/base-revision state before submission.
`PipelineClient` takes a fixed definition, public callback URL, app public key and
managed app signer. It signs exact transmitted bytes and requires fresh signatures
on every retry/poll. `submit` returns only an accepted run ID. Persist that run ID
before callback handling; a callback arriving before mapping must return a retryable
non-2xx response. Reconcile lost acceptance by retrying the same request ID and
unchanged immutable input, never a new ID.

Native signed completion envelopes retain `runId`, `deliveryId`, `terminal`,
`status`, `result` and `error`. Successful pipeline execution can still return a
business error. App result actions are `ban`, `classifier_error`, `build_failed`
and, after independent artifact validation, `build_completed`. Every business
result carries the stored `requestId` and `projectId`. Non-ban results require
`banRequired:false`. Ban evidence includes both probabilities, model, policy
version and threshold. The WApp derives member/room from trusted database rows.

`verifyDelivery` verifies the pinned Autopilot public signer, event signature,
kind/content, timestamp, exact public URL/POST/body hash, unique identity tags,
attempt and matching headers. `applyDelivery` must execute inside ONE WApp
database transaction using `DeliveryTransaction`: check consumed auth event IDs,
deduplicate immutable delivery hashes, resolve run mapping, apply business effect,
record receipt and auth event, then commit before HTTP 2xx. A captured auth event
replay is denied. A fresh valid retry of an applied delivery returns duplicate/2xx.
A changed payload for an existing delivery is denied. Retain replay IDs at least
through the signature freshness window; retain delivery/business uniqueness
durably. Database effects must also preserve a newer revision and prevent repeated
ban/allowance effects for the same request.

## Activation gates

Keep generation disabled until the generic `session.completedTurn` operation and
actual managed native-builder isolation pass acceptance. Integrate the trusted
conversation binding and native-resume reference from WApp state. A fork creates
an independent binding. Progress uses authorized backend session SSE filtered to
safe statuses/summaries; raw tool output, secrets and reasoning are excluded.
Progress and reconnect never promote a revision or resubmit a build.

The deployed app needs a distinct managed signing identity and a narrow execution
grant: this definition/version, configured callback, own runs/status/delivery reads
and trusted signer discovery. Existing generic application grants reject NIP-98
kind 27235, and publisher/Tower custody is not a pipeline grant. Do not broaden
those grants or reuse an agent/human key. A generic managed app pipeline broker
must authorize app ID/owner/root, expiry, exact target/method/body, allowed
definition and callback, and stored run ownership; audit grant use and denial.
The runtime must recognize that scoped grant separately from broad
`sessions:manage` access. This is a concrete platform activation prerequisite,
not functionality supplied by the client adapter.

Before room use, capture real two-prompt/native-resume/progress evidence, isolation
denial checks, real Jev allow/injection/extraction/service-error runs, exact signed
webhook receipts at a reachable public HTTPS receiver and durable duplicate/forgery/
replay tests. Unit fixtures and an installed definition do not satisfy these gates.

## Prepared managed and isolated definitions

Version 2 uses the generic `secrets.typesafeNoul` custody adapter and an imported
app-authorized service reference. It is a prepared source definition, not installed
runtime evidence. `ManagedPipelineClient` reads the private installation capability
file only on the server and verifies exact public app-signed request receipts from
the loopback broker. Native registration/activation is documented in Autopilot's
`docs/managed-wapp-pipelines.md`; its trusted local installation bootstrap does not
grant Tower publication or change scope ACLs.

Version 3 is explicitly disabled and has `executionEnabled:false`. Its actual
builder operation is `session.completedTurn` using pinned `isolated-codex` and
`/workspace`, a trusted durable conversation key and project file snapshot. The
backend selects these inputs. Native completion is only an artifact candidate:
request/project correlation is checked in code and the actual invocation run is
checked against the authoritative signed envelope by the receiver. Candidate files
still require WApp path/content/artifact validation and transactional revision
promotion; the prepared terminal result never reports build success. The whitelist
progress adapter requires trusted request/project/run mapping and emits status
names only, excluding all native text, tools and reasoning. Neither reconnect nor
progress can promote a revision. Activate a new version only after isolated native
execution, durable resume, dedicated provider custody and hosted receiver acceptance.
