# Recoverable workflow-pack history

Local continuation dated 22 September 2026. Installed workflow packs can now keep a long history without permanently stopping at eight previous configurations. This follows the [pack upgrade and managed-mail checkpoint](WORKFLOW-PACK-UPGRADES-MANAGED-MAIL-2026-09-22.md). Nothing was published, deployed or installed over the user's application.

## User flow

Under Schedule → Import packs → Previous configurations and rollback, review which older configurations will move into the private archive. The two most recent prior configurations remain in the active journal. Confirming archival keeps current plans, approvals, schedules, retired-plan ownership and business records in place. Older configurations remain available through paginated browsing, published-definition download and normal reviewed rollback. A rollback still creates a new generation and clears affected approvals and schedules.

The preview binds the exact installation generation, published digest, complete history, previous archive head and private workspace/profile/workroom scope. Stale confirmations fail. An already completed request reconciles its receipt, including after later updates or another archival, without moving history twice. The UI exposes a saved interrupted decision through Resume reviewed history archival.

## Persistence and recovery

Archive batches live at `customer-pack-history/<pack-id>/<digest>.json` under private application storage. Each immutable batch references its predecessor, preserves complete configuration snapshots and has a canonical SHA-256 content identity. The active journal retains a compact head and counters. A durable intent precedes archive creation; the file and directory entries are flushed and read back before the journal drops its archived snapshots.

Recovery recognizes only private, owned, single-link staging files for that exact saved intent. Their raw bytes must match a prefix of the reviewed archive. Identity and raw-byte digest are checked again before cleanup. Linked, foreign or modified files are preserved and the operation remains held. Complete generation continuity across archive batches, recent history and the current installation is required; a missing intermediate configuration is a recovery error.

Both private backup formats include the archive tree and validate its complete reference graph. Missing, truncated, foreign, detached, duplicate or inconsistent archive content prevents a usable backup or restore. An unfinished archival must be resumed first. Version 2 reads one archive payload at a time during graph validation. Restore retains the historic configuration data, uses the destination's encryption key and requires normal plan review and native instruction repair before work can run.

Hashes detect inconsistent bytes and references. They do not authenticate history against an operating-system owner who can replace both archive and journal coherently. Archive files are private local state; portable backups encrypt them.

Capacity is explicit: eight recent snapshots in the journal, two retained after archival, up to six snapshots and 2 MB per archive batch, and at most 10,000 batches per installation. Exceeding supported limits preserves records and holds the change. This is not an unlimited-storage promise. The separate 100-version limit for reviewed skill instructions still needs its own archival path; this implementation does not discard those versions.

## Verification

The source application rehearsal passes eight scenario groups, including the existing upgrade/recovery coverage and the new archive flows. It reaches the eight-configuration limit, previews six older configurations, verifies a genuine EACCES write failure, restarts, resumes after a lost HTTP reply, upgrades again and rolls back to archived configuration one. A second archival is interrupted by SIGKILL after the real service writes half of its temporary file. Cold restart and the mobile Resume action recover that exact history and remove the owned partial staging file. Older-page browsing still reaches the first configuration. Business-book bytes remain unchanged; no browser errors or off-origin requests occur.

Source receipt: `outputs/pack-history-2026-09-22/gui-source-final/receipt.json`. Desktop and 390px screenshots were rendered and inspected. The rehearsal uses the actual bootstrap and built UI with fictional records; no real provider or customer action is performed.

Both encrypted backup formats pass actual new-key cold restore with exact archived bytes, retained active and retired plans, archive browsing/export, omitted native-file repair and rollback to an archived version. Authenticated missing, truncated, wrong-pack and orphan archive cases are rejected. Pending archive intent blocks backup until resumed. These seven additional scenarios bring `server/private-backup-pack-upgrade.test.ts` to 14 passing tests.

A separate source integration run passed 134 tests. The final pack-focused run passed 66 tests, including two independent review regressions and the raw UTF-8 staging-byte case. Counts overlap and are not additive unique totals. The final full suite passes **4,521 tests, zero failures, 149 environment-gated skips** across 355 actual test files in 343.107 reported seconds. The admitted Hermes runtime fixture was enabled. Exact results: `outputs/pack-history-2026-09-22/full-source.result.json`; consolidated proof: `verification.json` beside it. Source remained unchanged through the final suite.

## Fresh macOS artifact

The unsigned arm64 app is `outputs/pack-history-2026-09-22/package/mac-arm64/RealBud.app`, using Electron 43.4.0 and bundled Node 24.18.1. The installed application was not replaced.

- **Eight packaged browser scenario groups pass**, including the actual SIGKILL/partial-write recovery and mobile Resume flow. No browser errors or off-origin requests; all owned processes and temporary directories cleaned. Receipt: `outputs/pack-history-2026-09-22/gui-packaged/receipt.json`.
- Native Mac renderer, capability, embedded-service and shutdown smoke passes (`mac-smoke.log`).
- Exact-artifact fresh-profile smoke passes with seven private files and six directories, shipped safeguards and skills, manual approvals and no attached model/ready worker. It measured 435 ms startup and 10 ms profile inspection on this Mac; these are observations, not an SLA (`profile-packaged.json`).
- Package preparation, frontend/server type checking and builds pass. All 334 compiled server files, 48 shared files, three supporting files and 342 renderer files match their packaged counterparts (`built-file-comparison.json`).
- The frozen source manifest contains 1,106 files, digest `884bc4bd98bacb785a860e99bebe0f6f06b2e2da71f86c1616412eaea4723a3f`. The app has 2,421 files and 14 symlinks, digest `ae457f7ef8923974a349fa8d64aa7c3115462ddc552078078c3d645a0730cb9b`. Source and package manifests remained identical through the rehearsals.

The browser rehearsal uses the selected app’s compiled service in Electron Node mode with a separate browser; native Electron startup is checked separately. Neither is Windows or installed-customer acceptance. The previous two-agency managed-mail rehearsal is historical evidence linked above; it was not repeated against this new artifact.

## Review and negative evidence

One Grok CLI 4.7/xhigh design review completed with actual `grok-4.7-build`, one call and one turn. It returned `end_turn`, exit 0, in 189.608 seconds; collection and cleanup completed in 192.830 seconds. No tool or permission requests were observed; reported MCP server/tool counts were zero. The private review home was removed and global configuration remained unchanged. See `outputs/pack-history-2026-09-22/grok-history-review.md` and its exact run/cleanup receipts. This advice is not an implementation approval or proof of complete model-context isolation.

Independent review reproduced a missing-generation acceptance defect and an interrupted temporary-file backup obstruction. Both regressions now pass; it also prompted parent-directory flushes before publishing the first archive reference. Red and green receipts are retained in `review-red.json` and `review-green.json`.

The first SIGKILL browser rehearsal completed recovery but failed its final network assertion: the old browser page issued reconciliation reads after the harness changed its service port. The harness now closes the dead page before starting the new port. Network restrictions remain intact. The negative receipt is retained at `gui-source-crash/receipt.json`. A discarded duplicate child-test setup attempted an unavailable `tsx` loader; it produced no production evidence and added no dependency.

## Remaining goal work

The [website command protocol](WEBSITE-COMMAND-PROTOCOL-2026-09-22.md) now maps the current account portal, installation reporting and reusable run ledgers to a concrete request/approval/recovery flow. It is a proposed implementation plan, not working remote execution. Implementation must preserve the distinction between billing ownership and local workspace/member authority.

Continue with that protocol and separate reviewed skill-history archival. Native Windows installation, privacy, update/uninstall and current Hermes/memory admission; physical two-device office operation; protected hosted connector commissioning; real Gmail consent and source acceptance; bank/REI recognition/import evidence; and observed customer operation remain separate gates. Local tests and an unsigned Mac artifact do not satisfy them.
