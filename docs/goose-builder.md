# Goose GLM 5.3 builder

The version 69 builder definition uses Goose native ACP with the managed
OpenRouter model `z-ai/glm-5.3`. This is the base model, not Prime or Flash.
Publication still requires the agent's `napplet.publish` CLI call; the ordinary
final answer travels through its separate signed message webhook.

Activation requires the compatible Autopilot source to be running. The managed
activation script checks the platform's completed-turn capability advertisement
before changing any routing. Installing source or a pipeline alone does not
activate the runtime, and Autopilot restart needs explicit operator approval.

After reviewed platform activation:

1. Install v69 with `scripts/followup-install.ts`, using ignored installation
   scope, receipt and storage-scope files. Keep the existing Codex grant valid.
2. Use `scripts/goose-builder-activate.ts` with the new ignored grant/evidence
   files. It preserves old Codex configuration under `receiptRecovery`, and
   pins the new runtime on every capable workshop scope.
3. Build and restart only the registered Freedom Tools managed app through
   Autopilot. Verify health and the served build, then exercise an answer, a
   build/publication, a resumed follow-up and a migrated existing project.

An existing idle Codex project moves to a new conversation generation on its
next request. Its directory, supporting files, app revisions and visible
conversation remain. Saved messages/current source/admin guidance seed the new
Goose session; historical instructions are inert and only the latest prompt is
executed. Codex's native transcript is preserved rather than converted or
claimed to be portable. Subsequent turns resume the native Goose conversation.

Pending or uncertain older Codex requests continue through the original Codex
recovery grant. They cannot migrate or replay as Goose. Generation changes run
inside the existing revision, membership and active-request fences.

Goose final completion uses durable host-side terminal evidence. If the process
crashes after publication but before recording its definitive final answer, the
app version survives but conversational completion can remain uncertain. The
platform fails closed without replaying that turn. Live provider credentials,
Goose tool behavior and publication must be smoke-tested after platform
activation; local simulated tests alone do not prove the switch is live.

Goose native-history deletion is not enabled by this configuration. Retiring a
builder preserves its history; it does not claim to erase Goose storage or the
terminal journal. Scoped native deletion remains a separate platform capability.
