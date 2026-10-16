# BYO Freedom

BYO Freedom is a Bun WApp that owns workshop identity, membership, private builder
conversations, a persistent live workshop desktop, runnable starters, immutable revisions, forks, sharing, consent and host
controls. Admin-created boards inherit the installed capable builder; invited
members can build immediately without board setup. Native execution still requires
the installation’s managed builder and app-only signing authority. Publication remains
unavailable until approved signing/storage/relays pass remote verification.

Install with `bun install`, validate with `bun test` and `bun run check`.
Copy `.env.example` to an ignored `.env` and configure the host public identity and
canonical managed URL. Register, build and activate through Autopilot appctl; do
not start standalone preview servers. See [WApp contracts](docs/wapp-owned-contract.md)
[live desktop contract](docs/workshop-board-contract.md),
[invite-member sessions](docs/workshop-session-contract.md),
[Napplet identity, signing and persistent-data API](docs/napplet-bridge-api.md),
and [publication prerequisites](docs/publication-contract.md).

`FREEDOM_ORIGIN` is the exact browser origin (scheme, hostname and optional port,
without a path or trailing slash). Alternate managed port or mesh entry URLs
navigate to it before reading sessions or requesting a login signature, preserving
the page path, query and fragment. A credential-free `/api/v1/browser-origin` GET
publishes that configured address. Mutation and WebSocket origins remain exact;
proxy headers, null origins and alternate origins cannot authorize requests.
This requires the canonical address to be reachable from the browser; it does not
enable independent mesh-only authentication. Validate with `bun run check` and
`bun test ./tests ./src` (scratch fixtures under `tmp/` are excluded).

The implementation path and capability prerequisites are recorded in
[docs/stage-1-contract.md](docs/stage-1-contract.md).

Run the synthetic host-boundary diagnostic with Bun:

```sh
bun scripts/probe-host-boundary.ts
```

This diagnostic uses disposable synthetic files and a subprocess with a minimal
environment. It reports access outside its working directory, parent-process
visibility, public HTTPS access and a synthetic injected capability. It does not
exercise an isolated managed builder, read existing secrets or enforce isolation.
Successful diagnostic execution must never be described as a successful security
acceptance test. Temporary fixtures are removed when it finishes.

Project follow-ups use the [conversation contract](docs/followup-contract.md). Activation is scoped to a configured trusted owner/project; general isolated participant execution and public publication remain gated.

Persistent local builders use the [Napplet directory contract](docs/napplet-directory-contract.md),
including per-installation setup, migration, native testing and immutable file receipts.

Profiles, site administration, Tower setup and per-workshop ownership follow the
[roles and workshops contract](docs/roles-workshops-contract.md). The legacy
workshop remains available under its original UUID with all existing projects.
