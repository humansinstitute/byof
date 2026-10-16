# Invite-member workshop builders

An admin-created board inherits the installation's capable Napplet builder.
An authenticated Nostr participant redeems the board's invitation code, creates
a Napplet and sends its first instruction immediately. There is no board setup
step, participant allowlist or board enable switch. Existing boards inherit the
same builder. Their saved instructions can use **Continue saved request**;
existing conversations, revisions and request IDs are preserved.

The server derives project conversations and directories. New projects use
`byo:<owner>:project:<project>` and the installation's
`<builderRoot>/<workshop>/<project>` directory. Existing UUID conversations remain
literal. Previously installed owner-specific routes and their grants are retained
for continuity. The shared installation route covers other admitted participants.

Every dispatch still checks the selected workshop, project ownership, active
membership, revision, pause, allowance and outstanding execution. Managed
preparation independently reads the installation-pinned SQLite database and
rechecks the saved request, owner, workshop, membership, allowance, pause and
replacement snapshot before preparing native execution. Caller-supplied database
paths, directories and membership declarations are never accepted.

Admin-created boards using the verified installation default are ready immediately;
invite members need no further activation. A workshop that explicitly selects a
Tower must authorize that workspace and pass private upload/readback before
publication-intended builds run. Answer-only conversations remain available.
Automatic intent screening rejects implementation requests while storage is
unready; the agent receives answer-only instructions for allowed conversation.
Existing allocations keep their storage requirement and immutable destination
through recovery. See [Tower onboarding](tower-storage-onboarding.md).

Installation upgrades must include the preparation and storage bundles as well
as the app source. `scripts/followup-install.ts` versions 64 and above generate
the membership-aware preparation bundle and pin `configuration().dataDir`; use
an unused immutable version. Preserve the current owner scope and existing
storage scope, register the definition with the supported
`clis/wapp-pipeline-grant.ts` CLI from the active Autopilot checkout, and update
only the root followup definition and credential reference. Retain prior grants
for owned-run recovery. This is an installation deployment, not per-board setup.
Build and restart only the authorized Freedom Tools app through Autopilot's
managed app runner; do not restart Autopilot.

Verify `bun test ./tests ./src`, `bun run check`, `bun run build`, managed health
and a real invite-member session. The scoped test command excludes ignored
scratch repositories under `tmp/`. `tests/workshop-session.test.ts` exercises
admin creation, invitation redemption, first managed dispatch/preparation,
existing saved-request resumption, optional unconnected Tower selection and
nonmember, wrong-board, banned, paused and exhausted-allowance rejection.
