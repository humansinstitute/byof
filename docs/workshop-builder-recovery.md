# Dedicated workshop builder recovery

Autopilot owns execution and session recovery. Freedom Tools owns the saved
instruction, app revisions, member authority, promotion and allowance charges.

Dedicated completed-turn sessions exclude ordinary prompt dispatch. Native resume
leaves ordinary queues on their original session. Readiness supersedes only
pending unsent prompts, preserving their content and a supersession audit. A
claimed ordinary delivery requires reconciliation or scoped abandonment.

Known pre-send failures are recoverable. The WApp verifies its owned run through
the managed broker and checks request, project and conversation correlation. It
first retries the exact immutable native request. It uses fresh context after a
verified missing/idle transcript failure, or after a signed abandonment receipt.
Historical instructions remain context; only the latest saved instruction runs.

Uncertain sends first reconcile the original native checkpoint without replay.
After bounded reconciliation, the activated pipeline may explicitly abandon that
exact owned turn. Autopilot revokes the old completion claim, drains the aborted
SDK turn, stops matching dedicated sessions and retires the conversation. A
failed stop never produces `writerStopped` evidence or authorizes a new writer.
Native history and ordinary claimed prompts are preserved. Late old completion
cannot commit to the retired receipt or promote through the retired WApp run.

The WApp then creates a fresh generation with immutable source, revision, guidance
and history. File drafts use a generation-specific path, so an old candidate is
never mistaken for the replacement. Promotion rechecks current revision,
allowance, authority and generation; retries do not charge an allowance.

Automatic recovery allows four attempts, at least 60 seconds apart, persisted
across restarts. A newer saved instruction supersedes older automatic recovery.
Deliberate retry of a saved request remains available after that budget ends.
During outages the last saved app remains available.

## Activation

Source installation alone does not activate Autopilot. Its operator must approve
and perform the server restart outside the managed worker. Never restart the
Autopilot process as part of workshop recovery.

Preserve the exact current installed definition's routing, screening, storage and
activity settings when creating a new immutable version. The native
`session.completedTurn` step must forward `abandonUncertain` from the server input;
the candidate function must support `builder_abandoned`. The v23 template and
followup installer provide this contract for new installations. Existing live
installations should version their current definition rather than replacing it
with a historical template.

Set `abandonmentEnabled: true` in only the dedicated workshop routes after the
Autopilot prerequisite and updated definition/grant are active. Then build and
restart Freedom Tools through its registered runner. Use the authenticated
`POST /api/v1/projects/:projectId/requests/:requestId/resume` route to recover an
existing saved request, or let the bounded server sweep recover it. Verify the
new accepted run, signed final receipt, unchanged prior app bytes, and exactly one
promotion/charge. Never change runtime SQLite rows or clear global queues.
