# Source-linked bills and arrival calendar — 21 September 2026

The full **Bills and calendar** saved view supports collecting the reviewed Gmail scope, selecting an actual saved message, asking the reviewed invoice plan for suggested fields, accepting checked bill facts, and separately approving an arrival pattern. Desk opens this full view through a compact summary. Filtered saved bill views retain their selected filter and offer a link to the full calendar.

## Authority and data

The desktop resolves account, scan receipt, conversation and message from its private mail store. The form supplies only message selectors, the reviewed source digest, checked facts and an explanation. The HTTP host verifies the current source binding and workspace property before the register changes. Model output is displayed as a proposal; it cannot create a bill or recurring pattern. Attachment metadata and truncated bodies require an explicit limitation acknowledgement. This workflow admits AUD facts; other currencies are rejected, not silently converted. It does not infer payment confirmation.

The new register is encrypted in the existing transactional WorkflowDatabase, separate from the earlier `expected-bills.json` v1 file. Legacy records remain readable and unchanged. Source-linked IDs cannot be written through the legacy bill endpoint. A malformed legacy register or new aggregate places changes on hold without filtering or rewriting the damaged content.

The stable source digest covers account, thread and exact saved message content/attachment metadata, excluding the changing scan receipt. A rescan therefore does not accept the same message twice. Receipt provenance remains saved with each accepted version. One bill per message is supported in this pass. A replacement message can be explicitly reviewed as a correction; previous source identity and facts remain in history. Every correction requires the current revision, and source identities cannot be reassigned to another bill.

## Calendar and recovery

Actual invoice due dates are nullable staff-reviewed facts. Arrival predictions are separate transient calendar entries from an explicitly approved monthly, quarterly or yearly pattern. Predictions are never bill records and never become paid. The first anchor window must contain the founding message's observed arrival in the selected timezone. Month-end and leap-year dates use the original date-only anchor, without UTC-offset or repeated-clamping drift. Explicitly linking a received bill to a recurrence period suppresses that period's prediction.

Pattern edits retain history. An anchor or cadence cannot move while non-cancelled bills are linked to those dates; staff must pause the pattern and approve a replacement from a new received bill. Pausing still permits correcting or cancelling an existing linked bill without erasing its historical link. New links to paused patterns remain blocked. Founding source changes require pausing first, and a changed founding source cannot silently resume its earlier pattern.

The first bounded register admits 500 bills, 100 patterns and 50 historic revisions per record. Capacity exhaustion holds new writes instead of deleting history. Calendar queries are limited to 550 days and lists offer further pages. Bulk archival/export and a pattern cutover editor are remaining product work; this limit is not an unlimited enterprise-retention claim.

Proposal requests retain a request identifier during an uncertain/in-flight browser request and replay the same request for readback. The host rechecks source and setup authority before replay. Worker receipts remain in Schedule. Source ingestion, invoice suggestions, accepted facts and recurrence approval are distinct steps.

## Reproduction

```sh
pnpm typecheck
pnpm exec vitest run server/source-bills.test.ts server/source-bills-api.test.ts server/expected-bills.test.ts src/lib/source-bill-form.test.ts
pnpm exec vite build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/qa-source-bills.mjs
```

The actual-app QA script creates a disposable isolated workspace, private fictional connector and deterministic worker. It drives the real HTTP authority layer and built UI, records source acceptance and recurrence, exercises correction history, duplicate rescans and rejected authority changes, and writes desktop/mobile evidence under `outputs/source-bills-2026-09-21`. It cannot establish live Gmail quality, real model extraction, customer attachment parsing, installed Windows behavior or payment/REI acceptance.

Observed domain/API/form check: **90** tests passed, including the independently identified paused-pattern correction regression. The actual-app rehearsal passed **7 checks** with the current built frontend and source HTTP service. Desktop and 390px mobile screenshots were inspected; no browser exceptions or horizontal overflow were observed. This uses the isolated test-lab mode and does not test managed subscription provisioning. Receipt: `outputs/source-bills-2026-09-21/receipt.json`.
