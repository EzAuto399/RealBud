# Property batch work — 6 September 2026

Desk now has a **Batch work** workspace: choose owner updates, maintenance briefs or inspection checklists, select properties, and give one shared instruction. Each property gets a separate saved source snapshot and prepared result.

## PM journey

1. Open Desk → Batch work. Search by address or tenant, select individual properties or add matching properties together. Adding search matches preserves existing selections. The limit is 50 properties per batch.
2. Prepare the batch. Bud works through one property at a time. Progress and results remain available when leaving the screen.
3. Pause after the current property. Resume processes queued properties; **Retry failed only** processes failed/interrupted properties without repeating completed work or starting unrelated queued properties.
4. Filter to **Needs attention**, inspect missing facts, and use **Mark reviewed & next**. Review is an acknowledgement inside RealBud, not permission to send or change records.
5. Copy one result or the entire review pack, or continue a property in Ask with its result and missing facts attached. An existing Ask draft is preserved.

The compact layout keeps the Prepare button visible at 900 × 600. Case-specific controls are hidden while reviewing batches. Recent batches and selection drafts survive navigation/reload.

## Verification

| Evidence | Result |
| --- | --- |
| Full regression suite | 1,042 passed, 8 skipped, 131 files |
| Final focused tests after supplied-name correction | 87 passed across batch service, HTTP API, worker cancellation and job execution |
| Batch-specific scenarios | 25 tests: invalid input, stale book/control revisions, duplicate requests, one active batch, mixed outcomes, pause/resume, failed-only retry, restart, unavailable worker, locked book, corrupted history, persistence failure, bounded source/output and 50 selected properties on a 1,000-property book |
| Real Hermes preparation | Five property results across four batches; owner updates, maintenance brief and inspection checklist |
| Real pause/restart/resume | First owner result preserved; second property resumed at attempt 1; neither repeated |
| Missing-information cases | Maintenance held unknown access/spending authority; inspection kept date/access unconfirmed |
| Supplied facts | Final owner update used the recorded tenant name, Sam Nguyen, without asking for it again |
| UI interaction | Search retention, no-match state, keyboard bulk selection, exceptions/review-next, reload, copy/paste and Ask handoff verified |
| Responsive evidence | 900 × 600 and 1,440 × 920; no horizontal overflow; compact action bar within viewport |
| Build | TypeScript, frontend production build, server build and updater bundle passed |

The full suite ran before the final tenant-name projection and heading alignment adjustment. The relevant 87 tests and production build passed after those final changes. The shutdown test caught and corrected a process-group fallback issue, then verified the owned worker exited on cancellation.

## Safety and recovery

- Session and loopback-origin controls cover batch reads and writes. Unsupported effectful actions are rejected. Creating/reviewing a batch does not change the Desk book revision.
- A request key and payload hash deduplicate uncertain submissions. Controls require the current batch revision. Scope is validated against the current book when created.
- Sources are scoped to one selected property, including its recorded tenant name, notes and case references. Long excerpts are explicitly labelled. Other properties' names and addresses are excluded from the worker prompt.
- Hermes receives preparation tools only (`todo`), at most three turns and 120 seconds per property. No file, shell, browser, sending or record-write capability is granted by this flow. Shutdown cancels the owned preparation worker.
- Atomic, owner-only local JSON stores source snapshots and complete results. A restart pauses in-flight work and marks incomplete attempts interrupted; it does not silently rerun them. Unreadable history is preserved and blocks new batch work; it needs operator restoration/repair. Failed persistence stops further dispatch.
- Recent-history listing returns small summaries instead of transferring every saved source/result during polling. History is bounded to 100 batches, evicting finished batches first when capacity is reached.

## Practical limits

These are **preparation batches**, not bulk email, contractor dispatch, PMS updates, payments or statutory actions. They use saved Desk facts and configured Hermes/model access, not a fresh PMS or inbox read. Results and batch history are stored locally with file permissions; this change does not add encrypted batch storage, and the configured model provider processes supplied preparation context.

The real runs used labelled fictional training properties. They do not establish named-office readiness, live integration coverage, a 50-property live-worker throughput benchmark, Windows process cancellation, notarization or a paid pilot. Full-history storage remains a bounded JSON store; a larger persistent-workload benchmark remains useful before increasing batch/history limits.

## Evidence files

- `outputs/pm-batch-2026-09-06/live-results-summary.json`
- `outputs/pm-batch-2026-09-06/ui-data/work-batches.json` — fictional source snapshots and complete worker results
- `outputs/pm-batch-2026-09-06/screenshots/review-1440.png`
- `outputs/pm-batch-2026-09-06/screenshots/selection-900.png`

## Installed desktop verification

The final arm64 RealBud 0.1.17 package was built with the final source and passed `codesign --verify --deep --strict` plus the isolated packaged renderer, capabilities, embedded harness and shutdown smoke test. The bundled batch service, worker and HTTP server match `dist-server`; bundled frontend assets match `dist`.

Installed at `/Applications/RealBud.app`. All **768 file/symlink entries** matched the tested package, and the installed signature verified. CDHash: `b8c8559dc878abde7de9594c183a54d49ec376f4`.

The installed app was reopened and Desk → Batch work displayed the three tasks, six existing sample properties, selection controls and disabled empty-selection Prepare button. The ordinary book and conversations were retained; test batches stayed in the isolated fixture.

Rollback copy: `outputs/pm-batch-2026-09-06/rollback/RealBud.app`. Tested package: `outputs/pm-batch-2026-09-06/final-package/mac-arm64/RealBud.app`. No notarization or publication was performed.

Build, test, signature, package/source matching and installation evidence are under `outputs/pm-batch-2026-09-06/logs/`.

The installed app also passed a fresh private Hermes readiness check (`ready: true`). Its ordinary batch history remained empty. The existing browser tab was refreshed onto the installed Batch work screen; isolated preview servers were stopped.
