# Pinned publication contract

Publication is unavailable in the hosted UI until approved managed signing,
Blossom upload/read and relay publish/read integrations are configured and live
acceptance passes. Private snapshot preparation is available for selected exact
shared revisions with explicit public consent. Preparation creates no remote asset
or event. Source tests use synthetic transports; they are not remote receipts.

Reviewed current primary sources on 11 October 2026:

- [NAP registry README](https://github.com/napplet/naps/blob/e5308ac92cfd49e4fb026812c60886571515e219/README.md).
- [NIP-5A nsites](https://github.com/nostr-protocol/nips/blob/5d6b432267d4046464490b1923b96844ac4559d0/5A.md).
- [NIP-5D web applets draft](https://github.com/dskvr/nips/blob/020cb8b33a9e4c6b8ca4b2f9d0ed0a67843b68f7/5D.md), upstream PR 2303 was open at review.

The current registry points to NIP-5D, whose manifest kinds are 5129/15129/35129.
Do not copy old draft Napplet fields into NIP-5A kind 35128, which now describes
named nsites. Current Napplets are single self-contained HTML artifacts with one
lowercase SHA256 `x` tag and nonempty plain-text description in event content.
Capability `R`/`O` tags declare domains; they do not grant capabilities. The local
workshop preview is an opaque-origin, network-denied iframe, not a claim that it
implements the signed-manifest NIP-5D runtime.

`src/publication.ts` prepares immutable private snapshots and provides a publisher
with injected approved managed transports. It uploads selected source plus a
standalone workshop page and public credits/lineage metadata. It creates immutable
Napplet snapshot manifests (5129) and a named nsite (35128). The nsite aggregate
hash is SHA256 of lexically sorted `hash path\n` path lines. Public output excludes
private instructions, cookies, session IDs and native binding metadata.

A durable five-minute execution lease permits one publisher per snapshot. Heartbeats renew the claim; token fencing prevents a superseded worker recording success. After an expired claim, pending operations are marked interrupted and recovery rechecks remote state before retrying. Transport adapters must enforce bounded request timeouts shorter than the lease; an upload already in flight cannot be withdrawn.

Every remote operation retains durable status/error receipts. Upload verification
reads and hashes remote bytes. Event verification reads the exact ID back and
verifies its signature and exact event template. A different valid signature for the same event ID is accepted. A failed relay leaves partial_failure; retries verify
existing remote assets, reuse saved signed events, and complete missing operations.
Receipt history does not substitute for current remote verification. Consent,
visibility and member state are rechecked before each operation and final success.
Revocation after a partial upload prevents further publication but cannot retract
already-public immutable bytes; the private receipt retains that partial reality.

Required activation inputs are an approved publication public key and nonexportable
managed signer allowing the exact 5129 and 35128 templates, approved HTTPS Blossom
servers with scoped upload/read, approved WSS relays with event acknowledgement and
exact-ID query, and a supported nsite resolver/public link that can be independently
verified. No implementation-worker or personal signer may be substituted.
The publisher returns a verified site coordinate, not a guessed gateway link.

Before exposing live publication, review BUD upload authentication and relay protocol
against the selected deployed services, bind these ports to managed custody, and
run remote asset/event verification plus partial-failure recovery acceptance.
Fork lineage in the export credits identifies the exact workshop origin revision;
no public parent Napplet coordinate is invented for an unpublished fork origin.
