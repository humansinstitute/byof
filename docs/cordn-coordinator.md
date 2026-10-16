# Cordn coordinator on this Mac

The coordinator is an independent Docker Desktop service, separate from the registered Freedom Tools app. It uses the official [Cordn image and server](https://github.com/Cordn-msg/cordn), pinned in `ops/cordn/image.txt`. It exposes no local ports; clients reach its public identity through Nostr relays.

## Start and operate

Run from the repository with Bun, installed dependencies, and a running Docker Desktop Linux context:

```sh
bun scripts/cordn.ts init
bun scripts/cordn.ts validate
bun scripts/cordn.ts start
bun scripts/cordn.ts status
bun scripts/cordn.ts identity
```

`init` creates a dedicated random service key only if absent. The ignored `tmp/cordn-service/service.env` has mode 600; its parent and the SQLite directory have mode 700. The key is mounted read-only at `/app/.env`, which the official Node entrypoint loads. It is never supplied through Docker environment arguments or container environment metadata. The application `.env` is not read or changed. Run scripts without shell tracing; never dump the secret file, process environment, or full configuration.

`tmp/cordn-service/data/cordn.sqlite` and its WAL files persist outside the container. The non-root container runs as the host user's UID/GID, with a read-only root filesystem, dropped capabilities, and no host ports. Public settings in `ops/cordn/runtime.env` explicitly use SQLite, disable discovery announcements, and enable the ordinary rate limiter (500/minute, burst 160, idle TTL 3600 seconds), key package quotas (50 total, 1 last-resort), and rejection logging. Welcome/join retention is 30 days.

```sh
bun scripts/cordn.ts restart
bun scripts/cordn.ts stop
```

These commands operate only on `freedomtools-cordn-coordinator` after checking its ownership label. `unless-stopped` restarts the container when Docker restarts; Docker Desktop must itself be running. Mac sleep, network loss, or a stopped Docker engine makes the coordinator unavailable. No Autopilot, PM2, or Freedom Tools lifecycle command is needed.

The current official image is AMD64-only; `start` explicitly selects `linux/amd64` for Docker Desktop emulation on Apple Silicon. If the image is not cached, pull its exact pin with `docker pull --platform linux/amd64 "$(cat ops/cordn/image.txt)"`. If Docker's credential helper stalls for this public registry, use an empty dedicated Docker config and the local Desktop socket; do not modify existing credential settings:

```sh
mkdir -p tmp/docs/handoffs/cordn-docker-public
docker --config tmp/docs/handoffs/cordn-docker-public \
  --host "unix://${HOME}/.docker/run/docker.sock" \
  pull --platform linux/amd64 "$(cat ops/cordn/image.txt)"
```

Configuration changes require scoped container recreation; `start` of an existing container does not apply changed Docker settings. Stop only this coordinator, remove only its container, and start again. Preserve the entire service directory. To upgrade, resolve and review a new official image digest, change the pin, recreate only this container, and rerun the smoke test. Never delete its service key or database during recreation.

## Connect and verify

`identity` prints only public information: hex public key, both public relay URLs, and a [Cordn](https://cordn.net/) add-coordinator URL with an NIP-19 `nprofile` encoding those hints. Share that URL to add the coordinator; it does not publish a discovery announcement. Run-specific public identity and the join link are recorded in the ignored handoff, rather than hard-coded in reusable tooling.

Install the official test client into ignored storage and run the relay smoke test:

```sh
npm install --prefix tmp/docs/handoffs/cordn-client --save-exact @cordn/cli@0.9.0
node scripts/cordn-smoke.mjs
```

The test publishes a new disposable client's KeyPackage, creates an MLS group, sends a message through the coordinator, and fetches and decrypts it from two separately restored snapshots made **before** sending. It restarts only the coordinator between fetches and checks the running process identity, message ID, cursor, and plaintext. It waits for relay reconnection after restart and fetches KeyPackages through each relay separately. Requests use required encrypted ContextVM transport. Encrypted client snapshots and JSON evidence remain under ignored `tmp/docs/handoffs/cordn-smoke-*`; never use `whoami`, which exports client private material. Run one smoke test at a time: its restart can interrupt other clients' in-flight requests. Public relay delays can produce MCP timeouts; inspect scoped public logs and rerun after confirming the container is connected.

Back up the service key and complete SQLite state together to permission-restricted storage. For a simple consistent file backup, stop only this coordinator, copy its service directory securely, then start it. Losing the key changes the coordinator identity; losing SQLite loses stored delivery state. Do not commit backups, operational logs, client snapshots, or private material. This setup validates relay delivery and process restart survival; it does not promise relay availability, host uptime, a multi-user membership test, or disaster recovery.
