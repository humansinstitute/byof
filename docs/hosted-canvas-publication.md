# Hosted Canvas publication

Freedom Tools can publish the current saved Canvas at `/p/<name>`. This is the
first public target; the snapshot model is deliberately separate from hosting so
a later Nsite/Blossom target can consume the same public data boundary.

## Contract

- Workshop setup is the publication agreement. Active current Napplet revisions
  are included by default; no per-owner or per-revision consent gates this target.
- A Canvas host can publish and update the stable generated three-word alias. A
  site administrator can choose or change a canonical available name.
- The database unique constraint is the alias authority. Publishing uses an
  immediate transaction and compare-and-swap version when supplied, so stale or
  concurrent actions cannot silently replace a newer snapshot.
- Per-Napplet exclusion is host-controlled and immediately updates an existing
  hosted snapshot. It does not hide, delete or revise the private Canvas app.
- A snapshot contains only public workshop presentation, saved board objects and
  exact active revision metadata. It excludes conversations, prompts, requests,
  capabilities, grants, storage configuration, unpublished builds and dataset
  values.

Unknown aliases and unavailable Napplet/image resources return `404` without a
listing API. Deleting a Canvas removes its current hosted route. Changing a custom
name removes the old route. Historical or immutable external publication targets,
when added, may retain artifacts; the administrator UI states this explicitly.

## Visitor runtime boundary

Published Napplets keep the existing opaque-origin sandbox and injected
`window.napplet` client. An anonymous parent supplies capability discovery and an
explicit `AUTH_REQUIRED` result for identity-backed methods. If the browser has a
real active Freedom Tools Nostr session and is admitted to that Canvas, the parent
uses the existing bridge host, consent UI and server-side workshop/project/session
checks. The child never receives the session cookie, CSRF value, service
credential, workshop-host role or server capability.

Self-contained HTML continues to work anonymously. Identity, durable storage,
datasets, wallet and other service calls remain bound to the visitor, project,
revision and Canvas through the existing capability routes.

## Read-only spatial navigation

The hosted page renders the saved board coordinates and dimensions as world
geometry. It opens on one useful content area rather than shrinking the whole
board into the viewport. Visitors can drag empty Canvas or group background to
pan, use the view controls to zoom/reset/fit, and use touch panning and pinch
zoom. Pan mode temporarily places an explicit navigation shield over Napplet
frames so a visitor can traverse the Canvas without turning embedded app input
into accidental movement; with Pan mode off, iframe controls and scrolling keep
their normal behavior. The Napplet menu centers the selected saved object and
does not move or rewrite it.

Public navigation is camera state only. It exposes no selection, edit, add,
move, resize, delete, save or other persisted board mutation. Geometry is
applied by the trusted renderer without weakening the page's strict style CSP.

## Deployment verification

Build metadata includes `public-canvas.js`, `public-canvas-camera.js` and
`public-canvas.css`. A release must
verify their hashes from `/health`, check anonymous desktop/mobile `/p/<name>`,
exercise pan, zoom, reset, fit and menu focus on a deliberately spread-out board,
use an included Napplet without moving it, and confirm an anonymous bridge denial
plus a signed-in consent path. Activation must use the registered Freedom Tools
managed app/deployment path and preserve the persistent data volume.
