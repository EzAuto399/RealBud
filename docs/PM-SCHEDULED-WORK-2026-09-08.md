# Scheduled work and current-book preparation — 8 September 2026

This continuation closes specific reliability gaps in daily PM work: recovering a run after a lost response, retaining clock state through disk failures and restarts, using the current saved book, and opening the result that needs a PM's attention.

## Implemented behavior

- Manual routine requests retain a device-generated UUID and the original clock revision. The server returns the same retained receipt after completion, pause, retune, or restart. A new stale request is rejected. Client storage contains IDs and revisions only. Storage failure prevents submission; connection loss preserves the request for checking.
- Scheduled occurrences and their queued receipts are committed together before worker execution. Restart reconciles retained scheduled receipts, including completed receipts written by older versions before their watermark. Paused work stays paused. Ancient downtime produces a bounded missed-work summary instead of replaying an unbounded backlog.
- Missing history is first run; malformed, unsupported, unreadable, or uncertain history enters recovery. Clock changes and new work stop with an actionable message. Known results and Desk remain available; original damaged files are preserved. Atomic writes use private file permissions, with rollback before rename and a hold after uncertain durability.
- A deadline stops waiting, not the underlying worker. An overdue attempt remains running with an unconfirmed-outcome message and blocks another attempt for that routine. Other routines can proceed; late success or failure settles the original receipt.
- Each prepare job with read-book capability captures the current saved Desk snapshot directly. Its revision, capture time, training/office scope, and omission warning are saved before Hermes runs. A stale shared summary is not used as that run's source. Missing, invalid, recovering, or unsavable source context stops preparation before the worker.
- The bounded context includes modern cases and legacy work, deduplicated and restricted to the supplied properties. It excludes contacts, recipients, draft bodies, credentials, and recovery material. Source capture is explicitly distinguished from a live PMS or inbox refresh.
- Schedule shows Needs you for held results. Selecting a calendar result opens its exact saved outcome. Run submission returns control to the PM while durable receipts and live updates track progress. Recovery is visible on small and large layouts.

## Validation

- Full regression suite: 1,309 passed, 8 skipped across 147 files. The first run encountered a transient machine-wide ENOSPC failure; the retained log records that failure. Free space recovered without deleting anything. The successful retry used one worker.
- Scheduler failure/recovery suite: 56 passed, covering corrupt and invalid files, private writes, failed commits, startup reconciliation, retained request identities, clock rollback, deadlines, and late settlement.
- Independent HTTP smoke: five checks passed using isolated fictional data and a nonfunctional worker sentinel. Includes duplicate replay through restart, invalid/stale requests, and corrupt-history availability without overwriting the file.
- Final focused tests: 143 passed across nine files, including 21 stale-response/state reconciliation cases. Completed routine and job receipts cannot regress to queued/running; full prepared outputs and approval requests stay attached, newer clock revisions win, and a same-process stale healthy response cannot clear recovery.
- Browser checks: 12 passed at 390, 600, 900 and 1,440 pixels, including calendar-to-result navigation, actual lost response/reload recovery, a stale second-window control, recovery messaging, continued Desk access, and checking a saved request despite a stale Running display.
- Real Hermes canary: a fictional property was added after the shared summary was written. Bud reported its current AUD 734 weekly rent from the new saved book, retained the source stamp, and described the training/live limitation. One worker invocation completed in about 22 seconds. Reopening the receipt store and replaying the same request retained the result without rereading the book or calling the model again.
- Portal-job end-to-end harness: all green, zero skips. This remains local harness evidence.

- Production build passed. The arm64 review app is Developer ID signed; strict deep signature verification and the packaged renderer/harness/shutdown smoke passed. Packaged UI, server, shared and helper resources match the compiled source.
- Native review passed with 200 fictional properties, saved Schedule output, and an actual Bud readiness response in 8.081 seconds. The app uses a separate review data directory and UI profile. This candidate has not been notarized or published.

Review app: [Open review app.command](../outputs/pm-scheduled-work-2026-09-08/Open%20review%20app.command).

Evidence and reproduction scripts: `outputs/pm-scheduled-work-2026-09-08/`.

## Operational limits

The work is preparation and review. Sending, paying, submitting, statutory actions and PMS record changes still require the existing human decision flow. Current saved facts are not proof of current provider facts. Actual named-office PMS/inbox operation, phone pairing and two-way handoff on a real device, and sustained model throughput across a 200-property office still require separate live checks.

The clock retains up to 2,000 receipts; its duplicate lookup is limited to retained history. A corrupted history file requires restoring a known-good copy and restarting; this change does not add a one-click restore wizard. A genuinely unresolved worker is not restarted blindly. UI widths exercise responsive layout, not a deployed mobile web service.
