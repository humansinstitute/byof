# Administrator-selected builder engines

The configurable v70 builder supports Codex, Claude and Goose. Site administrators
choose the engine for each BYOF Canvas from Site Admin or its management Settings.
Goose uses the base OpenRouter `z-ai/glm-5.3` model. Claude and Codex use their
supported configured harness defaults; this screen does not expose credentials,
provider editing or arbitrary model identifiers.

Selection is revisioned and survives reload. Saving requires administrator
access, CSRF protection and the current setting revision. Workshop ownership
alone does not authorize changing the engine. Participants cannot override
engine, model or provider in their instruction submission.

Every new request snapshots the engine revision and canonical runtime in immutable
server storage before dispatch. Settings changes affect new requests only.
Queued requests, uncertain turns and retries retain their original selection;
older requests without this snapshot continue through their original managed
grant. V70 preparation checks the immutable snapshot, project ownership,
workshop and separately saved context before selecting the native agent.

The installed Codex default remains until the administrator changes it. An
existing installation explicitly configured for Goose seeds that saved choice
once; reading settings never overwrites a saved choice. New Canvases inherit the
site's initial choice and subsequently store their own setting.

The same runtime resumes its native conversation. Changing engine creates a
fresh native generation in the existing project directory, preserving files,
app revisions, ordered visible history and saved guidance. Prior messages are
inert context; only the latest instruction executes. Native SDK/ACP transcripts
remain engine-specific and are not converted or erased. Existing failed or
uncertain requests retain their original engine rather than being replayed by
the new selection.

Publication remains an explicit agent tool call, independent of the ordinary
final-message webhook. All three runtimes require a genuine successful terminal
result. Claude and Goose additionally record trusted durable terminal evidence;
missing evidence leaves a turn uncertain without automatic replay. A crash after
publication can preserve the app version while its final conversation remains
uncertain.

The settings screen can save a choice before runtime activation. It reports
unavailable selections as awaiting compatible managed pipeline/platform
activation. An enabled installation means the transport path is installed; it
is not a promise that provider credentials, quota or every live build will work.
Claude/Codex configured-default snapshots preserve the choice of default, not an
exact provider-model version frozen independently of harness configuration.
Native-history deletion is not enabled by the configurable installation;
retirement preserves history.

## Activation

Source readiness does not activate the runtime. Autopilot restart requires
explicit operator approval. After reviewed platform activation, its
broker-authenticated project-tool capability response must advertise Codex,
Claude and Goose completed turns and the managed OpenRouter provider.

Install `scripts/followup-install.ts` version 70 with ignored pinned workshop and
storage scope files. Issue the supported managed installation grant containing
v70 preparation/publication module hashes and the complete definition hash that
pins the built-in `session.completedTurn` operation. Keep
existing grants valid for saved-request recovery.

Run `scripts/configurable-builder-activate.ts` with the new ignored grant and
evidence files (an optional third argument selects a later version, such as 71).
It verifies all three platform capabilities before replacing
the ignored `.env` routing entry, preserves the original configuration under
`receiptRecovery`, and enables administrator selection on all capable scopes.
Build/restart only the Freedom Tools registered managed app, then verify health,
served assets and errors. Smoke-test each engine's answer, build/publication,
follow-up resume and switches in both directions. Local tests and the disposable
browser settings fixture prove source behavior; they do not prove live provider
execution or publication.
