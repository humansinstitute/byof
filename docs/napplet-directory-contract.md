# Persistent Napplet projects

The current delivery model is documented in [the agent publication contract](agent-publication-contract.md).
Agents work and test in a dedicated permanent project directory and publish using
an explicit native tool call. Their final response is ordinary prose delivered
through an independent message webhook. Final prose is never an artifact protocol.

Choose an absolute canonical Napplet root on the Autopilot host, accessible to the
managed WApp and builder. `scripts/napplet-setup.ts` preserves legacy supporting
files and creates `ROOT/<workshopId>/<projectId>`. Browser paths and owner keys do
not select directories. Back up the app database, objects, configuration and
Napplet root together; do not move the root while requests are active.

The app writes request-specific immutable context and authoritative current
source, allocates `.drafts/<request-or-generation-hash>/vN/index.html`, and refreshes
managed local guidance. The agent preserves research, notes, data models and other
supporting files across turns. `vN/index.html` and exported historical revisions
are immutable completed versions. Symlinks, nonregular files, hard links, changed
completed hashes and conflicting migration destinations are rejected.

Questions and planning create no version. Successful publication promotes only
the selected tested HTML, after verified private Tower/S3 readback, and allocates
one revision and charge. Failed drafts consume no completed number. Matching
retries use the same request, job, artifact hash, revision and URL.

Old receipt-based definitions and grants exist solely for already owned-run
recovery. They are historical implementation, not the active delivery contract.
New native project tools require the generic Autopilot dispatcher and narrowed
session authority to be activated; do not claim source-only work is live.
Filesystem read isolation remains a separate prerequisite from broker scope.
