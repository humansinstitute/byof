# Mobile Napplet workbench

At widths of 900px and below, Preview and Chat are tabs beneath a compact
symbol, project title, Options disclosure and identity button. Preview opens
first; the selected tab is remembered per project for the current page session.
Desktop retains the side-by-side chat and preview layout.

Tab switches change panel visibility and inert state without replacing or moving
the preview iframe or chat elements. This preserves the running app, unsent
inputs, history and scroll position. Arrow keys, Home and End select tabs. The
inactive panel is excluded from keyboard focus and accessibility navigation.

The native Options disclosure contains the existing navigation, rename,
inspection, sound, session lifecycle, version/publication controls and permission
revocation. Escape closes it and returns focus to its summary; clicking outside
also closes it. These are the same controls with the same authorization
conditions. On desktop they return to their original locations. The identity
menu remains available separately.

Run `bun scripts/mobile-builder-acceptance.ts` for local Chrome coverage against
the production server with isolated signed-in fixtures. Set `FREEDOM_BROWSER`
when Chrome is installed elsewhere. Screenshots and evidence go under ignored
`tmp/docs/handoffs/mobile-tabs/`. Coverage includes a running starter's state,
iframe/window identity, no reload on switching, drafts, history scroll,
keyboard tabs/menu, narrow viewport overflow, host inspection permissions and
desktop layout restoration. This is local browser coverage, not deployed-device
or live builder verification.
