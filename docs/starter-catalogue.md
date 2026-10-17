# Workshop starter Napplets

The starter catalogue contains exactly five self-contained Napplets:

- **Cashu wallet** uses Freedom Tools' managed Minibits Ippon capability. A participant explicitly creates or reuses one short-lived wallet scoped to their signed-in identity, this Canvas and this Napplet project; the host retains the Ippon access key and returns only wallet/balance and deposit invoice/status data. The starter has honest no-wallet, connecting, connected, invoice-pending, paid-awaiting-issuance, issued, expired and failure states. It can refresh balances, copy/open a BOLT11 and forget local managed authority. It does not read the older starter's browser-stored key, store Cashu tokens in a shared dataset or claim that invoice creation received funds. Only Ippon's `ISSUED` state means ecash was issued.
- **Bush Bash Nostr** reads verified kind-1 events with `#t: ["bussobushbash"]` through `napplet.relay.query` and `napplet.relay.subscribe`. It distinguishes complete empty results from partial, failed and truncated reads and renders event content only with text DOM APIs.
- **Bitcoin spinner** visibly spins and always answers the displayed question “Should I buy bitcoin?” with “Yes”.
- **100 D6 rolls** uses rejection sampling over `crypto.getRandomValues` to produce exactly 100 independent values in the inclusive range 1–6 and displays both rolls and counts.
- **Pong** is immediately playable with keyboard and pointer/touch controls, live scoring, pause/resume and score restart. It has no Lightning Address, invoice, donation, settlement or unlock UI/state/network path.

Todo, Meme Generator and the other historical starters are no longer offered in the catalogue. Existing projects and immutable revisions are independent database records and are not removed or rewritten when catalogue entries change.
