# Live workshop desktop

The workshop is a DOM desktop of every active Napplet. Active means a project in
the selected workshop, not hidden, whose owner has admitted workshop membership.
There is one window per project, using its current immutable saved checkpoint.
Creating a starter creates a completed checkpoint; a blank starter explains that
it is ready to build. A project without a checkpoint shows a waiting placeholder.
Queued, running, failed and storage-pending drafts do not advance the displayed
checkpoint. A completed build or restore advances it automatically. The page
polls the authorized room every three seconds in addition to room events. An open
pop-out defers authorized revision changes until close, so the active frame
remains usable; membership removal or app moderation closes it immediately on
the next authoritative refresh.

Admission grants preview access to active current revisions and separately
selected publication revisions in that workshop. Other saved checkpoints remain
owner/host-only. Builder details, instructions, artifacts, grants and private
history retain their existing ownership and host gates. Cross-workshop preview
requests are denied. Hidden or banned-owner projects are excluded from the board
and other participants' previews; owner/host builder inspection remains separate.
The room's legacy `gallery` is retained for API compatibility and publication,
but does not drive desktop placement or revision selection.

## Shared arrangement

Only the server-derived workshop host role may write `POST /api/v1/board`.
Workshop owners and genuinely configured site administrators have that role;
ordinary Napplet ownership does not confer it. App rename/edit rights remain
separate, including the rule that a nonadmin workshop host cannot rename someone
else's app. Session, origin, CSRF and selected-workshop checks apply to writes.

Each workshop has an additive `workshop_boards` row with a monotonically increasing
version and JSON placements. Objects have ID, kind, x/y, width/height and optional
group ID. Napplet IDs are their project IDs and every active app must remain in a
save. Text, image and named area objects are host-created. Groups cannot nest.
Dragging a group title moves member objects by
the same offset; resizing an area does not resize its apps. Removing an area
ungroups its objects. Hiding an app retains its placement privately for restore.

Missing apps receive stable nonoverlapping slots without changing existing
placements. Automatic placement is persisted transactionally. Saving sends
`{expectedVersion,objects}`; the server validates the whole proposed layout and
updates only the matching version. A stale editor receives HTTP 409 and must
explicitly **Reload layout**. Incoming updates preserve unsaved local edits.
The UI uses explicit **Save layout**, avoiding autosave response ordering races.
No viewport, focus, minimized flag or arbitrary client fields enter persistence.

For rectangular objects, coordinates are finite and bounded to ±50,000; width is 240–4,000 and height is
100–4,000 (Napplet minimum 200). Layouts have at most 700 objects, with at most
100 decorations, plus the built-in donation window, and a 200 KB request limit. Text is plain escaped text, at most
4,000 characters; area names are at most 80 characters. Pictures use the existing
workshop HTTPS URL convention with stricter private-network rejection: no script,
data, credentials, fragment, local address or SVG-path URL. Descriptions are
required and bounded to 200 characters. The browser loads pictures with no
referrer; the server never fetches user-supplied picture URLs. Picture hosts must
serve usable images. This optional URL tool adds no public storage grant or Tower route. The
workshop-scoped pasted-byte upload is described below.

## Personal interaction and frame lifetime

Everyone admitted can use Fit all, 100%, zoom controls, keyboard background
arrows/+/−, background drag/wheel and background two-finger pinch. Pan mode adds
an explicit shield over apps for board gestures. App clicks and scrolling otherwise
stay inside the app. Window title bars move objects for hosts. Object options are inline controls for
group membership, names, descriptions and removal; geometry is always changed by
dragging and resizing, with no coordinate or dimension inputs. Resize handles and decoration tools
are host-only. Board changes are local until explicitly saved.

Focus raises a window through CSS z-index, without DOM reordering. An opaque
sandbox iframe sends a narrow focus signal; the parent accepts it only from that
exact live window. Minimize hides and makes the app wrapper inert while retaining
its dimensions and iframe. Pop-out promotes the original dialog into the browser
top layer and closes back into place, with focus return and native/fallback
fullscreen. Movement, resize, focus, title changes, personal viewport changes,
minimize and pop-out do not replace the frame. A changed completed revision loads
a new frame. Navigating away from the desktop or reloading the page creates a new
document; in-app persistence remains the app's responsibility. Pan/zoom is saved
in sessionStorage per workshop; focus and minimized presentation last this page
session. Neither changes shared arrangement.

Validation: `bun run check`, `bun test ./tests ./src`, and
`bun scripts/workshop-board-acceptance.ts`. The browser script uses real Chrome
at desktop/mobile widths and an isolated application API with in-memory synthetic
test signers; it registers no fixture app. It checks arrangement/save/reload,
groups/text/pictures, iframe score continuity, personal navigation, actual touch
pinch, nonhost UI/API denial, new app placement and automatic completed revision
updates. Operational screenshots/results belong only under ignored
`tmp/docs/handoffs/`. Hosted proof uses the supported broker identity and the
registered Freedom Tools runner, with health and served build hashes verified.

## Direct canvas tools and stored pictures

The board fills the viewport and has a plain white default background. The small workshop title, Edit/New icons, drawing
controls and zoom controls float over it. Branding collapses to a small mark;
About, introduction and workshop pictures remain in workshop settings, rather
than taking space above the desktop. Secondary arrangement/reload/URL-picture/file
controls are under More. All controls have accessible labels and touch targets.

The text tool arms placement: click a board position and type into a plain text
editor directly on the board. Text is content rather than a titled note window.
Selected text exposes a 12–144 pixel size control; text and font size save in the
same versioned layout. Bold, italic, underline and shadow toggles apply to the
selected text object; the server accepts only boolean effects, never CSS or HTML.
Existing text is edited directly on the board, with no editing modal. A move handle and resize corner
appear for selected/hovered decorations. Empty local text is removed on blur and
is never a valid persisted object. Inline typing defers background room polling
until the edit ends; server versions still fence stale saves.

The picture tool chooses an insertion point before clipboard paste. Normal paste
inside a focused Napplet, input, textarea or text editor remains untouched.
Desktop paste uses the clipboard event; Paste picture supports an explicit
clipboard-read gesture, and Choose picture supplies a file fallback. A raster
picture is decoded locally, resized to at most 1,200 pixels on its longest side
and progressively reduced until PNG bytes fit the 180 KB limit. Source files are
limited to PNG/JPEG/WebP under 10 MB; decoded dimensions/pixel count are bounded.
Coordinates use the inverse of the current translation and scale, so insertion
lands at the clicked point at any zoom level. Upload temporarily serializes board
controls against Save, preventing a late response from clearing newer dirty edits.

`POST /api/v1/board/images` is genuine-host-only, same-origin and CSRF protected.
It accepts only a bounded canonical base64 body and validates PNG checksums/chunks
or JPEG dimensions, with a 2,048-side/4-megapixel bound. MIME is inferred from the
bytes; SVG, HTML and arbitrary metadata are rejected. Immutable hash-addressed
bytes use the app's existing private object directory. A workshop/image row pins
scope and MIME/dimensions; each workshop can register at most 200 pictures.
Duplicate byte uploads reuse the same receipt. Uploaded bytes may remain after an
object is removed; this bounded immutable store preserves references and avoids
concurrent deletion races.

`GET /api/v1/board/images/:hash?workshop=:id` checks admission and exact workshop
registration, with no-store, nosniff and a restrictive CSP. Layout writes accept
only an uploaded image URL registered to their own workshop. Other admitted users
can load shared board picture bytes; another workshop or anonymous user cannot.
External public HTTPS picture URLs remain an optional secondary tool. No Tower
upload grants, public anonymous storage or shared platform API are added.

A built-in **Support this workshop** Napplet-style window holds the existing
Lightning donation link, or a useful not-configured message. Its native DOM link
retains the original wallet behavior without adding sandbox navigation authority.
It participates in host geometry/grouping and personal minimize/pop-out/focus,
uses the same compact chrome, and must remain in a saved layout. The host's
workshop settings remain the source of the donation address.

## Pointer arrows

Hosts select Draw arrow and drag between two board points. Selected arrows expose
start and end handles for direct adjustment and a move handle; inline object
options provide group membership and removal. Arrows count toward the existing
100-decoration limit and share the same host-only, versioned layout saves. Group
movement translates the arrow start while retaining its relative endpoint.

Arrow geometry stores x/y as the start, endX/endY as a finite relative endpoint,
and width/height as the absolute endpoint deltas with a minimum of one. Deltas
are bounded to 4,000, both endpoints to ±50,000, and length to at least eight.
Horizontal, vertical and reverse-direction arrows are supported. Tiny pointer
strokes are discarded. Fit and automatic placement consider both endpoints.
Legacy layouts and text without effects continue to render with normal styling.
Effects and arrows do not change sandbox iframe lifetime or authority.

## Arrow styling and curves

Selected arrows show an inline Arrow colour input, Dotted line checkbox and
Straight arrow action. The orange Curve arrow handle directly drags a quadratic
Bezier control point; start/end handles and moving remain available. Arrowheads
follow the curve's end tangent, with a straight-direction fallback for a degenerate
tangent. Dotted strokes use a solid arrowhead.

Optional `colour` accepts only a six-digit hex colour, `dotted` is boolean, and
`curveX`/`curveY` are a paired finite control point relative to the arrow start.
Control deltas are bounded to ±4,000 and absolute control points to ±50,000.
The persisted width/height continue to describe endpoint deltas for compatibility;
DOM geometry, Fit all and new-app placement include the full control-point hull.
Moving carries the control point; adjusting the start preserves its absolute
position. Straight arrow removes the curve fields. Legacy arrows render in the
original dark colour with a solid straight stroke. Styles and control points
remain covered by the existing host-only versioned save and decoration limits.

## Workshop invitations

The host's visible Invite control creates a ten-use, 24-hour invitation for the
selected workshop. Its dialog shows a locally generated QR, readonly copyable URL
and six-digit code. Both the QR and URL use the configured browser origin and
canonical `/?code=123456`; `/?code-123456` is accepted when opening a link.
No external QR service receives invitation or donation data. QR generation uses
pinned `qr` from [the maintained upstream library](https://github.com/paulmillr/qr).

Hosts can request `{uses,shortCode:true}` through the existing host invitation
endpoint; legacy long-token requests remain compatible. At most 100 live
invitations per workshop may be created. Codes use cryptographic randomness and
are checked against all historical invitation hashes before insertion. Only the
hash, expiry, remaining admissions and workshop are stored.

`POST /api/v1/workshops/redeem-code` accepts `{code}` with a signed-in session,
same-origin request and CSRF token. It resolves the invitation's workshop rather
than trusting the selected workshop header. Membership and remaining uses change
in one immediate transaction, including existing pending members in both legacy
and scoped workshops. Banned members cannot redeem; expiry/exhaustion and workshop
boundaries remain enforced. Existing admitted members do not consume another use.
A code grants workshop membership, never host privileges, private conversations,
other workshops or anonymous board access.

Manual Workshop code entry is available at sign-in and on Workshops. Incoming
codes persist in the tab until redeemed after Nostr extension or temporary
identity sign-in. Successful redemption selects the exact workshop and removes
the code from the URL/tab storage. Invalid codes keep the user on the joining
surface with an error, rather than silently opening the default workshop.

Invitation navigation has one deterministic parser. The generated `code` query
parameter takes precedence over numeric shorthand parameters even when shorthand
comes first; the first duplicate `code` value is authoritative. Numeric shorthand
is accepted among unrelated parameters, while nonnumeric names such as UI/theme
parameters beginning with `code-` remain unrelated. URL encoding is decoded once,
and fragments are not read. Values must be exactly six digits. An explicit
malformed invitation value clears older pending state instead of falling back.

Pending codes use structured, navigation-scoped session state. The current URL
always wins, opening a second invitation replaces the first, and ordinary new
navigations do not revive stale tab state. The scoped state permits reload while
authentication is in progress. History and back/forward navigation re-run the
same precedence rules. Successful redemption removes all canonical and shorthand
invite parameters plus the scoped state while preserving unrelated parameters;
failed or expired redemption keeps the authenticated profile on the retry form.

Short-code guesses require authentication and are limited by persistent ten-minute
buckets: ten attempts per Nostr public key and 300 per installation, including
invalid bodies and attempts through the old scoped join route. Proxy IP headers
are not trusted. String normalization precedes classification; whitespace cannot
bypass the limits. Direct numeric-token sign-in is rejected in favour of the
signed-in redemption path. Rates survive process restart. A shared installation
cap deliberately bounds guesses from newly created identities, so heavy invalid
traffic can temporarily prevent other code redemptions. Existing membership and
ordinary sign-in remain available.

## Donation QR

Revealed donation details include a local QR encoding the exact `lightning:` URI
of Open in wallet. Inline, enlarged and fullscreen views retain the same QR,
address and copy/wallet actions. Presentation state captures QR and displayed
recipient together; deferred room updates while a viewer is open cannot switch
the copied address or QR underneath it. Closing applies the latest recipient and
resets revealed details. No configured recipient means no QR or payment actions.

Validation adds `bun scripts/workshop-invite-acceptance.ts` and
`bun scripts/donation-browser-acceptance.ts`. These decode the actual rendered
GIF image pixels and compare them to the displayed invitation URL or wallet href
at desktop/mobile sizes. Join coverage includes temporary/extension identities,
manual and both link formats, pending membership, invalid-code recovery, reload
and UI/API authority checks. API tests exercise limits, collisions, restart,
expiry, exhaustion, atomic use and bans. No wallet is opened or payment sent.
