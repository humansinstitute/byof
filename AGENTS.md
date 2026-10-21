# Freedom Tools agent instructions

## Required Napplet execution and delivery model

Pete's authoritative requirement, reaffirmed 2026-10-14. Apply this to the
builder instructions, local skills, tools, pipelines, backend and frontend.

1. An admin-created workshop board is ready for Napplet building. A user who
   signs in with Nostr and joins with its invite code can build immediately;
   there is no additional per-board activation or participant owner allowlist.
2. Each Napplet has a dedicated, persistent project directory on Autopilot.
   The agent works there, retains supporting files and conversation context,
   builds the app locally and tests the actual app. It can also answer
   questions, discuss ideas and improve the app over successive turns.
3. Publishing an app is an explicit **agent tool call**. That tool publishes
   the tested artifact to S3 through scoped managed authority and posts the
   resulting app link/version to the Napplet webhook. Credentials remain
   behind the capability broker; the agent does not handle raw storage secrets.
4. The webhook registers the next app version and makes its link available to
   the frontend. The frontend loads that version from the supplied link.
   Correlation, authorization, artifact verification and duplicate-delivery
   handling belong in the trusted tool/backend contract.
5. When the agent turn finishes, its ordinary final conversational message is
   delivered to the Napplet conversation through the webhook. This message
   delivery is separate from the app publication tool call. Answers without
   app changes deliver a message without creating an app version.
6. The final response is ordinary prose. Do **not** require a JSON artifact
   receipt, HTML, file manifest or special completion format in that response.
   Do **not** parse the final response to discover, upload or register an app.
   Neither the frontend nor a pipeline may use model prose as the artifact
   delivery protocol. Structured tool/webhook payloads are the protocol.
7. The pipeline coordinates the session and completed-turn message delivery;
   it must not substitute final-response parsing for the agent's publication
   tool. Keep successful publication, publication failure and conversational
   completion distinct so a claimed build is not displayed as a published app.

### Current implementation gap

At the time this requirement was recorded, the file-build path already used
persistent project folders, but required a JSON receipt in the agent's final
response. The pipeline parsed that receipt, handled artifact storage and sent
the completion webhook. **That implementation does not satisfy the required
model above.** Existing receipt-based code, tests, templates and documentation
are historical implementation evidence, not authority to retain that behavior.
Do not report this requirement as implemented merely because a receipt-based
test build passes. Verify the agent publication tool, S3 artifact/link webhook,
frontend version loading and independent ordinary final-message webhook live.

## Repository workflow

Default to main and preserve concurrent work. Keep operational handoffs and
private/run-specific evidence in Git-ignored tmp/docs/handoffs/. Commit tested
software and reusable documentation. Read the configured `flight-deck-workflow`
skill before writing Flight Deck task descriptions or comments. Validate the product with bun test ./tests ./src,
bun run check and bun run build as appropriate. Use Autopilot's managed app
runner for Freedom Tools activation; never restart Autopilot without Pete's
explicit approval.

## Active session queue handling

When running in an Autopilot session, inspect your own pending prompt queue at meaningful milestones during active work, when new work is reported, and before final handoff, using `bun /Users/mini/code/wm/autopilot/clis/wingman.ts session queue list`. Read each complete item and any referenced authoritative thread/task. Incorporate applicable steering; immediately consume only the exact item and revision actually incorporated using `bun /Users/mini/code/wm/autopilot/clis/wingman.ts session queue consume <id> --revision <read-revision> --reason <incorporation-reason>`. Consumption removes pending work while preserving history; merely listing or reading is not consumption. Keep unfinished/unrelated work and concurrent newer arrivals pending. Never clear the queue blindly or consume solely to suppress a follow-up turn. Recheck before handoff.

Supervised worker callbacks are separate: inspect `bun /Users/mini/code/wm/autopilot/clis/wingman.ts dispatch inbox`, review actual evidence and report/take necessary follow-up, then acknowledge and close only reviewed callbacks. Do not apply these commands to another session or imply monitoring after the process stops. Follow `/Users/mini/.codex/skills/wingman-sessions/SKILL.md` for revision conflicts and uncertain delivery, with Pete's explicit consume-on-incorporation policy taking precedence over older completion-only acknowledgement guidance.
