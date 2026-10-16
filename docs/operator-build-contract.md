# Approved saved-request builds

Current Napplet delivery uses [explicit native agent publication and independent final prose](agent-publication-contract.md). Receipt-based instructions below describe legacy owned-run recovery only; they must not be used for new requests.

The host can execute an explicitly approved saved instruction without rewriting
it or creating a replacement participant request. The operator pipeline template
is `pipelines/operator-build.v4.json`. Install its bundled user functions through
Autopilot's supported file API, and fill its approval defaults from the
authenticated workshop record. Pin the exact request ID, project ID, prompt,
conversation key and dedicated working directory. Register an installation
pipeline grant for the resulting definition and function hashes.

`FREEDOM_OPERATOR_BUILD_CONFIG` contains the loopback broker URL, opaque
credential-file reference, Autopilot origin, definition ID, callback URL,
publisher public key and approved request ID. The capability stays on the server;
the browser never receives it. The configured public callback signer is separately
discovered through Autopilot's authenticated API.

The host-only `POST /api/v1/host/requests/:id/build` requires the ordinary signed
challenge login, browser origin and CSRF token. It sends the stored prompt and
expected revision's source to the installation broker. It returns quickly with a
run reference, stores the public signed acceptance receipt and binds that run to
the existing request. Repeating the operation recovers the same run; the saved
request ID is also Autopilot's immutable idempotency key.

The pipeline uses the existing managed OpenRouter Decisions classifier with
`~typesafe/jev-latest`. Both typed probabilities are validated before applying the
inclusive 95% moderation threshold. Service errors never ban or authorize the
builder. No direct TypeSafe key provisioning or credential export is needed.

For this trusted operator path, `session.completedTurn` creates or reuses a
dedicated Codex SDK conversation. The prompt requests a response-only generated
HTML document, without tools or host-resource access. The current SDK transport
uses host permissions: the dedicated directory and instruction are **not enforced
container isolation**. Accordingly, this path is pinned to a reviewed instruction
and general participant generation stays unavailable. Do not turn it into an
unrestricted public builder. The separately prepared `isolated-codex` pipeline
remains the required path for that wider boundary.

The signed terminal webhook is verified against its exact URL, bytes, run,
delivery, attempt, freshness and pinned signer. Promotion requires a completed
native receipt correlated to the stored request/run/project, a bounded
self-contained HTML document, unchanged expected revision and active membership.
The preview's sandbox and CSP enforce separation from parent cookies, host UI,
network and embedded frames. The WApp stores an immutable source hash and new
revision, marks the request succeeded and charges once, in the same transaction
as the delivery receipt. Fresh signed retries create no second revision or charge.

The host can read dispatch, native build and callback receipts through
`GET /api/v1/host/requests/:id/receipts`. Project links use `/?project=<id>` and
retain existing authenticated ownership checks. Neither room sharing nor public
publication is implied by building a private revision.
