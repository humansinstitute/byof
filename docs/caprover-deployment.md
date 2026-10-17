# Separate CapRover deployment

Build the committed source with the root `captain-definition` and `Dockerfile`.
The image builds browser identity assets and runs Bun as its non-root user.
Package an explicit committed-source allowlist (`Dockerfile`, `captain-definition`,
`.dockerignore`, `package.json`, `bun.lock`, `src`, `public`, `scripts/build.ts`,
and `templates`) with `git archive HEAD <paths>`; never include
`.env`, local runtime directories, broker capabilities, or local workshop data.
For accurate health metadata, provide the source SHA as Docker build argument
`FREEDOM_SOURCE_SHA` using a deployment-specific captain definition.

Create a new persistent app, one instance, container HTTP port 3000, and a named
volume mounted at `/data`. SQLite, immutable objects and workshop state live in
this volume. CapRover persistent apps are node-bound: retain that node and back
up the volume before migration. Configure `PORT=3000`, `FREEDOM_DATA_DIR=/data`,
`FREEDOM_ORIGIN` to the exact HTTPS browser origin, and `FREEDOM_HOST_NPUB` to
the authorized owner's public identity. Enable default-domain SSL and force SSL.
Do not attach the local runtime data or reuse a different app's volume.

Nostr login uses the browser signer with a server challenge pinned to the exact
canonical `/api/v1/login` URL. This basic hosted app does not need a server private
key. It has independent sessions, workshop IDs and files. A separate managed
application signing identity must be provisioned before adding privileged remote
integrations; an existing local app identity or signing capability is not copied.

Managed execution from a separate CapRover host uses Autopilot's dedicated
server-to-server remote managed-pipeline route. Register a fresh remote grant for
this exact WApp installation, app, human owner, CapRover HTTPS origin, pinned
pipeline definition/function hashes, callback URL and short expiry. Install only
that new remote capability in a dedicated CapRover environment variable and point
the Freedom Tools pipeline configuration at the exact public Autopilot origin.
Never copy a loopback capability file, WApp/Tower signing key, human key or another
deployment's credential. The public route rejects browser Origin calls and an
envelope that changes the installation, app, owner, deployment origin or operation;
the underlying grant rejects route, definition, callback, run, expiry and revocation
drift. It remains a pinned pipeline caller, not an HTTP proxy or signing endpoint.

Canvas datasets use a separate backend-only `BYO_NSEC` on CapRover. It is not the
managed-pipeline credential and must not replace or be included in pipeline
configuration. Freedom Tools derives its dataset npub at runtime, keeps the managed
publication/private-file identity unchanged, and saves a separate per-Canvas dataset
target only after the administrator reviews the exact Tower namespace and workspace-
guest operations for that dataset npub. Each descriptor, migration, query, create or conditional-update request
gets a fresh NIP-98 signature over the exact HTTPS URL, method and JSON payload hash,
with a short deadline and redirects disabled. Keep `BYO_NSEC` out of source, browser
responses, logs and deployment evidence. Managed/local deployments continue to use
the explicit loopback database-broker capability when present.

Older Canvases with only the publication/storage binding remain usable for their
existing artifacts but show **Complete setup** until the dataset identity has been
authorized and real descriptor, migration and query proof has been stored. Never
rewrite the existing storage target to repair dataset access.

Configure installation-wide storage only after the remote grant is active. Its
storage template must use the same installation app identity in Autopilot custody,
the exact NStack origin and the production callback. Keep builder/publication
features disabled unless their own definitions, callbacks and grants have also
been reviewed and activated. Source tests or a successful image build do not prove
the running Autopilot route, grant or private Tower readback is active.

Verify `/health`, `/api/v1/browser-origin`, all five browser assets and the login
challenge origin. Invalid and missing mutation origins must return 403. Check
that asset hashes match health metadata, HTTPS works, and the configured volume
survives an app-scoped redeployment. Record CapRover version and exact source SHA.

The native client config POST is a replacement operation: always supply the full
intended environment, volumes, instance count and HTTP port, even when changing
only `forceSsl`. Its PATCH method requires an upstream partial-update endpoint
and must not silently fall back to POST. Re-read the app definition after updates.
For rollout tests, use another source tarball deployment. Image deployments pull
from a registry and cannot reuse a local `img-captain-*` image by name.
