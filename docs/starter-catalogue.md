# Workshop starter Napplets

The starter catalogue contains exactly five self-contained Napplets:

- **SATCADE wallet** is a responsive 1990s-arcade wallet for receiving and sending sats. Receive generates a real scannable Lightning QR plus copy/open actions and honest pending/paid/issued states. Send accepts a BOLT11 invoice or Lightning address, shows an in-app review and then requires the trusted payment confirmation before funds leave. Its private per-user/project address book starts with `bitcoinbushbash@walletofsatoshi.com` and supports selection, additions and removal. The visible starter and catalogue copy deliberately contain no provider, hosting or internal architecture explanation; the trusted bridge documentation owns those details.
- **Bush Bash Nostr** reads verified kind-1 events with `#t: ["bussobushbash"]` through `napplet.relay.query` and `napplet.relay.subscribe`. It distinguishes complete empty results from partial, failed and truncated reads and renders event content only with text DOM APIs.
- **Bitcoin spinner** visibly spins and always answers the displayed question “Should I buy bitcoin?” with “Yes”.
- **100 D6 rolls** uses rejection sampling over `crypto.getRandomValues` to produce exactly 100 independent values in the inclusive range 1–6 and displays both rolls and counts.
- **Pong** opens ready with a stationary ball. Arrow Up/Down move the player's left paddle, Space starts or pauses, and R resets scores and positions and immediately starts a fresh round. On touch screens, a discrete tap in the court's upper or lower half moves the paddle in that direction. Its visible and announced status reports ready/running/paused/reset plus the score. It has no Lightning Address, invoice, donation, settlement or unlock UI/state/network path.

Todo, Meme Generator and the other historical starters are no longer offered in the catalogue. Existing projects and immutable revisions are independent database records and are not removed or rewritten when catalogue entries change.

## Existing Cashu projects

Startup upgrades the original SATCADE release only when the project can be
identified by its exact source hash, unchanged catalogue title and description,
original (non-forked) lineage, and a single untouched revision. The upgrade adds
a second immutable revision with the fee-buffer guard and compatible 42-sat
receive/21-sat send defaults. Repeated startup is idempotent.

Renamed, edited, restored, multi-revision and forked projects do not satisfy
that proof and are never rewritten. Their safe update path remains
owner-driven: open the project's builder and request the current SATCADE wallet
behavior while preserving its project, conversation and private storage, then
review and activate the new immutable revision normally. Creating a new
SATCADE project remains the alternative when retaining the old app unchanged is
preferable.

## Existing Pong projects

Startup upgrades either known untouched built-in Pong release only when the
project has the exact built-in source hash, catalogue title and description,
and original non-forked lineage. This includes a single-revision project made
from either release and the exact two-revision automatic upgrade from the
original release. The upgrade appends the keyboard-and-touch-only controls as
the next immutable revision. Repeated startup is idempotent.

Renamed, redescribed, edited, restored, deleted, forked and other
multi-revision Pong projects are never rewritten. Their owners can opt into the
newer controls through the normal builder and revision workflow.
