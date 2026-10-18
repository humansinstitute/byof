# Workshop starter Napplets

The starter catalogue contains exactly five self-contained Napplets:

- **SATCADE wallet** is a responsive 1990s-arcade wallet for receiving and sending sats. Receive generates a real scannable Lightning QR plus copy/open actions and honest pending/paid/issued states. Send accepts a BOLT11 invoice or Lightning address, shows an in-app review and then requires the trusted payment confirmation before funds leave. Its private per-user/project address book starts with `bitcoinbushbash@walletofsatoshi.com` and supports selection, additions and removal. The visible starter and catalogue copy deliberately contain no provider, hosting or internal architecture explanation; the trusted bridge documentation owns those details.
- **Bush Bash Nostr** reads verified kind-1 events with `#t: ["bussobushbash"]` through `napplet.relay.query` and `napplet.relay.subscribe`. It distinguishes complete empty results from partial, failed and truncated reads and renders event content only with text DOM APIs.
- **Bitcoin spinner** visibly spins and always answers the displayed question “Should I buy bitcoin?” with “Yes”.
- **100 D6 rolls** uses rejection sampling over `crypto.getRandomValues` to produce exactly 100 independent values in the inclusive range 1–6 and displays both rolls and counts.
- **Pong** is immediately playable with keyboard and pointer/touch controls, live scoring, pause/resume and score restart. It has no Lightning Address, invoice, donation, settlement or unlock UI/state/network path.

Todo, Meme Generator and the other historical starters are no longer offered in the catalogue. Existing projects and immutable revisions are independent database records and are not removed or rewritten when catalogue entries change.

## Existing Cashu projects

The database does not retain a starter ID or starter-version provenance on a
project. It retains immutable revision hashes, but a project may have been
forked, restored, published, renamed or rebuilt while keeping similar source,
and its persistent project directory can contain later supporting work. There
is no established catalogue-to-project migration ledger or idempotent activation
operation that can update only proven untouched starter instances while keeping
active/shared revision and local version history coherent. Startup therefore
does not rewrite any existing Cashu project.

The safe existing-project path is owner-driven: open that project's builder and
ask it to replace the current app with the SATCADE wallet behavior while keeping
the project, conversation and private storage namespace. Review and activate the
new immutable revision normally. Alternatively, create SATCADE from the current
catalogue as a new project and keep the older wallet available until the new one
is verified. A future automatic migration needs explicit persisted starter ID +
starter source version and a migration receipt before it can be safe and
idempotent.
