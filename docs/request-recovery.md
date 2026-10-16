# Saved request recovery

Saving an instruction and dispatching it are separate transitions. `queued`
means saved and not started; only `building` means the managed run was accepted.
An exception during preparation leaves an actionable saved request and a public
failure reason. Authorization, pause and revision errors still reject execution.

A queued or unavailable request is safe to cancel only if it has no run binding,
dispatch outbox, recovery snapshot, epoch/history, local artifact allocation,
activity authority, attempt history, or delivery/publication/completion receipt.
The check and cancellation run in one immediate SQLite transaction. Cancellation
preserves the prompt, history, current app and allowance. It does not stop a
possibly running agent. Once dispatch evidence exists, reconnect the saved
execution and reconcile uncertainty instead of starting another writer.

The recovery sweep considers the latest saved instruction per project. A proven
never-sent queued request must be at least 30 seconds old. Recovery has a durable
four-attempt budget, with at least 60 seconds between attempts. Expired dispatch
claims reuse their saved execution key and snapshot. Manual retry remains
available after the automatic budget is exhausted; it does not change identity.
Ownership, admission, pause, allowance, expected revision, generation and pending
native deletion fences remain authoritative. Old callbacks cannot bind a newer
request or publish over a newer generation.

Preparation may await dataset discovery or verified run polling. Dispatch
rechecks terminal state inside its transaction after those awaits, before any
artifact allocation or generation mutation. If cancellation wins that race,
the old request cannot resume. If dispatch wins, cancellation is refused.

Requests saved before builder-engine snapshots were introduced use their original
managed recovery grant. They do not silently adopt the current administrator
selection. A missing compatible grant or a mismatched Canvas broker destination
is a blocker, not permission to bypass a fence.

Publishing remains an explicit agent tool operation. The publication receipt and
ordinary final-message webhook stay separate. Recovery success is not evidence
that an app was published; verify the managed artifact, registered app version,
frontend link and independent final-message receipt.
