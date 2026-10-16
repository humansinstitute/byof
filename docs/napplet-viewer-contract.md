# Napplet titles and workshop previews

Owners and site admins can rename Napplets through the window settings cog or builder. Workshop hosts without site admin rights retain inspection/moderation access only. `POST
/api/v1/projects/:id/rename` takes `{title}` and returns `{project}`. The title is
trimmed, required, at most 120 input characters, and cannot contain line breaks
or control characters. Browser rendering escapes titles and uses text attributes
for accessible names. Authentication, CSRF, admission, workshop selection and
project ownership or site admin rights are required; workshop host inspection alone does not grant rename authority.

Renaming updates only project metadata. It does not change source bytes, immutable
revisions, shared revision selection, consent, conversation history, builder state,
storage records or allowance. Windows, builder headings and preview names use the
saved metadata after reload.

The workshop desktop automatically plays every authorized active Napplet's current
completed checkpoint, independently of the selected publication revision. Hidden
projects and banned-owner projects are excluded. See
[Live workshop desktop](workshop-board-contract.md) for layout, permissions and
personal viewport behavior. Historical preview access and publication consent
remain distinct from admission to active app previews.

Each card has an accessible pop-out button outside the iframe. The same inline
`dialog` expands with `showModal()` and returns to its original size on close;
its iframe is never moved, cloned or recreated by expansion. Fullscreen uses the
existing document-root API, with a viewport fallback. Close and Escape return focus
to the opener. Preview Escape messages are accepted only from the active iframe
window. Card updates preserve unchanged iframe nodes; authorized revision changes
load the new revision. Modern browsers also preserve frames when cards reorder
through `moveBefore`; older browsers can reload a frame if its card is reordered.

Sandbox permissions remain `allow-scripts allow-forms`, with no same-origin
privilege and no-referrer policy. The preview response's existing content security
policy denies network connections. No new app or storage privileges are introduced.

Validate with `bun run check`, `bun test ./tests ./src` and
`bun scripts/workshop-board-acceptance.ts`. The earlier embeds acceptance script
covers the superseded pinned-gallery UI. The browser script runs an isolated
real API with synthetic NIP-07 identities and Chrome, exercising desktop/mobile
interaction, persisted layout, active app admission, modal state continuity,
personal navigation, nonhost denial and automatic completed-version updates.
It does not register a managed browser fixture or authenticate as a human user.
Its screenshots and results are written under ignored `tmp/docs/handoffs/`.


Workshop windows show only the title and small minimize/restore, green pop-out,
and settings controls. Nonowners see a secondary options menu for Fork instead
of settings. The app viewport is 380px high, with full card width; the bar is
44px high and touch targets expand to 44px on coarse pointers. Author, version,
description, gallery headings and repeated builder buttons are omitted.

Minimize is reversible presentation state, scoped to workshop/project for the
current page session. It survives room events, rename and identity-menu rerenders.
The iframe remains mounted with its original dimensions but hidden, clipped and
inert until restored; data and saved revisions are never deleted. Pop-out also
restores a minimized window. Settings use a keyboard-accessible native dialog
with Escape and focus return. Site admin rename changes title metadata only:
sharing, consent, restore, generation and moderation keep their existing gates.

Authenticated preview responses inject the [Napplet bridge v1](napplet-bridge-api.md) before app scripts. Identity consent, participant signing and durable per-user project storage travel over a channel bound to the existing frame; sandbox and network-denying CSP stay unchanged. Removing/replacing a frame revokes its grants, while resize/minimize/pop-out preserve its channel with the document.
