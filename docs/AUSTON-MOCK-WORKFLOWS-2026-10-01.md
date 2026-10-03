# Auston mock workflow checkpoint — 1 October 2026

This checkpoint does **not** establish a real invoice accepted against a verified property, REI access or entry, complete mailbox coverage, a production performance SLA, Property Inspect execution, or customer acceptance. It does establish installed RealBud-led Gmail collection, model preparation, saved results and a repeat-run check. Kevin remains the sole invoice reviewer. No email was sent, no REI record was changed, and no new recurring schedule was enabled.

## Installed RealBud results

The user authorized the connected Gmail for testing and then authorized the reviewed collector release. Source selection remains the existing test account, seven-day discovery window, sent history included, and ten retained/processed messages per scan. A fetched thread may contain more messages before that cap; coverage is explicitly partial. This is not Kevin's verified production mailbox. Property.csv remains an inspected attachment, not an accepted property/reference book.

All starts, workflow-setting reviews and the test note were made through the installed RealBud interface. Read-only local APIs inspected receipts. Codex did not supply the model's business decisions or write result records directly.

| Installed test | Actual outcome | Recorded time |
|---|---|---|
| Morning collection and preparation | Ten conversations collected; all ten returned in Bud's validated structured result and persisted. All ten were held for source/context review; the test mailbox did not establish agency business, complete history or complete coverage. | 85.983 seconds total; 61.433 seconds in the preparation job |
| Repeat morning run | Same ten item identities. The explicitly labelled mock note, reviewer, priority and status survived. No additional model preparation was needed. | 15.640 seconds |
| Kevin's bill source scan | Ten conversations retained for review; partial coverage shown. | 12.473 seconds for acquisition |
| Bill negative case | Bud identified a selected promotional message as insufficient invoice evidence. Amount/date/property facts remained unsupported; the proposal stayed on hold and the draft was saved for later. Zero received bills, arrival patterns or bill-calendar entries were created. | 28.519 seconds for model preparation |

The successful morning model run is `639585b2-7b9c-42da-b8be-4a1cb394b3a0`; the bill proposal run is `d12db521-f7f2-4395-bd14-7d594d32b942`. Both use the configured managed worker/model path, with the worker recording `claude-sonnet-5.5`. `awaiting-approval` means internal review remains; it is not authority to act in REI. Morning scheduling stays off. Existing unrelated schedules were left as found.

Evidence: [live workflow results](../outputs/auston-department-rehearsal-2026-10-01/live-workflow-results.json), [repeat comparison](../outputs/auston-department-rehearsal-2026-10-01/morning-repeat-receipt.json), [bill and earlier failure receipt](../outputs/auston-department-rehearsal-2026-10-01/live-before-readable-fix.json). Repository receipts omit message bodies and subjects; the promotional hold description contains no customer invoice facts.

## Repairs applied to the running test path

**Gmail collector — live gateway release.** Deployed only the reviewed `server/composio-gmail.ts` delta over the immutable existing image. All 55 runtime files were checked; the collector was the only changed runtime file. The fixed, exact-account Gmail GET preserves raw thread/message IDs and `internalDate` rather than substituting normalized dates. A volume snapshot preceded deployment. Health and readiness returned 200, and actual collection subsequently succeeded. No credentials, scopes or provider permissions changed. See [release receipt](../outputs/auston-department-rehearsal-2026-10-01/gateway-release-receipt.json) and [manifest](../outputs/auston-department-rehearsal-2026-10-01/gateway-release-manifest.json). The earlier checkpoint's pending-release statement is historical.

**Morning input paging — installed local QA update.** The first post-release model preparation failed honestly with `source-items-incomplete`: the host had written 125,234 bytes of JSON on one line. Hermes' 32,000-character line-reader budget cut the line, and its remainder could not be retrieved with a subsequent line offset. Bud returned only three of ten source rows; host validation refused the result.

The host now writes readable morning-input JSON using the same private atomic writer and checks the actual formatted size. The Prepare prompt tells file-capable jobs to follow read pagination and retain source gaps. No source validator or approval requirement was weakened. The installed rerun produced 243 lines, with its longest line 12,749 characters, and the worker reached the final page.

This local update contains only three compiled modules: `private-json.js`, `mail-ingestion.js`, and `job-executor.js`. Each unmodified baseline matched the installed bytes. Compilation used an isolated HEAD tree plus those exact source changes; unrelated shared-checkout edits were excluded. The copied application was re-sealed with its existing ad-hoc QA signature and passed deep strict verification. The native browser bytes were unchanged. The office service was stopped through its control UI, then started by Electron with the same workspace instance. This is an installed QA update, not a notarized public release.

Rollback application retained at `/Users/yo-da/.realbud-backups/2026-10-01-before-readable-input-fix/RealBud.app`. [Build manifest](../outputs/auston-department-rehearsal-2026-10-01/readable-source-build.json), [installation receipt](../outputs/auston-department-rehearsal-2026-10-01/readable-app-install.json).

Paging/private-write/executor/backup checks: **99 passed / 0 failed / 0 skipped**, four files ([log](../outputs/auston-department-rehearsal-2026-10-01/morning-readable-source-tests.log)). The new large-input regression reconstructs all ten messages through bounded line pages, including escaped text, and applies the full validated review. Isolated baseline and patched compilation both passed. An earlier shared-tree compile failed on duplicate-bill files while they were still being edited; its output was not installed.

## Department pack and duplicate-bill work

The [department acceptance matrix](AUSTON-DEPARTMENT-ACCEPTANCE-2026-10-01.md) separates Kevin's accounts, Sherry's maintenance/inspection preparation, and scoped management handoffs. The separate [maintenance rehearsal pack](../pack/workflows/austin-maintenance-rehearsal/README.md) is ready as a source artifact for review/import. It includes six fictional assigned-case scenarios: matching and repeated evidence, missing cutoff, ambiguous boundaries, identity/version collisions, missing evidence with an embedded instruction, and missing rehearsal provenance. It grants only analysis/drafting, has no schedule or website origins, and does not change Kevin's pack. It has not been imported or run by the installed model; company case assignment and reviewer authority are still prerequisites. Its custom business-result semantics remain reviewer-checked.

Maintenance pack/import/executor/department checks: **80 passed / 0 failed / 0 skipped** ([log](../outputs/auston-department-rehearsal-2026-10-01/maintenance-pack-tests.log)); root independently reran the new suite: **16 passed / 0 failed / 0 skipped** ([log](../outputs/auston-department-rehearsal-2026-10-01/maintenance-root-check.log)). These overlapping runs must not be added into a unique-test total.

The bill rehearsal reproduced a second defect: an identical invoice body and facts arriving under a new message identity could create another reviewed bill. The new source implementation adds an exact-evidence candidate hold, visible matching records, explicit distinct-invoice review, and a transaction-time stale-evidence recheck. It preserves correction history and backup references. Cancellation remains possible; reactivation checks afresh. This is deliberately narrower than business invoice identity: changed forward wrappers, PDF-only duplicates, invoice versions and different spellings still need a stronger reviewed supplier/invoice mapping. The duplicate fix is **source/local UI work, not installed in the current app**.

Final duplicate-repair verification:

- Core/API/storage/backup: **124 passed / 0 failed / 0 skipped**, followed by **20 / 0 / 0** in the duplicate suite with one additional graph regression; **125 unique source tests**. UI/helper/form/draft checks: **44 / 0 / 0**. Root independently reran the decisive duplicate server/helper suites: **43 / 0 / 0** ([root log](../outputs/auston-department-rehearsal-2026-10-01/duplicate-root-check.log)). Counts overlap; do not sum them.
- Actual disposable browser against the source HTTP app and a newly built isolated UI: **29 passed / 0 failed / 0 skipped**, 29.570 seconds, five fictional scans, one restricted PDF read, zero page errors. It exercised the hold on desktop/mobile, save-and-open/reopen, candidate changes in another session, explicit separate-invoice review and replay. [Browser receipt](../outputs/auston-department-rehearsal-2026-10-01/source-bills-duplicate-browser-final/receipt.json).
- Renderer and server typechecks passed, including root's consolidated `pnpm typecheck`; whole-tree diff whitespace checks passed. Independent source review found no concrete issue. [Consolidated typecheck](../outputs/auston-department-rehearsal-2026-10-01/consolidated-typecheck.log), [full repair summary and retained failures](../outputs/auston-department-rehearsal-2026-10-01/source-bill-duplicates-summary.json).

Earlier browser attempts are retained: the first used an outdated hidden-card assumption; the later duplicate test reached 27 checks before a test locator searched for the correctly rendered stale-review alert in the wrong container. Neither failed attempt is counted as a passed run. The final build used isolated output and did not replace the shared `dist` or installed app. Broader source bill checks before the repair were **309 / 0 / 0**, and the department audit's separate evidence is linked in the matrix; these are wiring/contract tests with fictional providers, not additional live customer proof.

## Performance and remaining acceptance

The timings above are single-device observations, not a throughput guarantee. The successful morning run recorded 292,850 cumulative input tokens over six model API calls and 6,408 output tokens in the worker's counters. These counters are not a billing statement. HTML-heavy source text and repeated context are an identified efficiency problem; the zero-model repeat is useful but does not make first-time preparation cheap. [Worker counters and paged-read metadata](../outputs/auston-department-rehearsal-2026-10-01/worker-performance.json).

Before claiming operational readiness:

1. Run a positive invoice example with original supported attachment and a verified property mapping. The live test proved a negative hold, not property matching, invoice acceptance or expected-arrival accuracy. Large extracted-PDF text also needs file-reader pagination qualification; the paging change here targets morning inputs.
2. User signs into REI in the private native work-browser profile and confirms the agency/account. Test the CSV-to-REI comparison read-only. Reuse that browser-managed session while valid; reauthentication and daily expiry behavior remain unverified. Do not copy a personal browser's cookies or bypass sign-in.
3. Build the explicit selected-evidence bridge between private mail/bills and authorized department cases. Private sources must not silently become office-wide department data.
4. Qualify Sherry's maintenance boundaries and durable review state, and the six-month inspection planner. Verify the supported Property Inspect actions and their notice side effects through Auston's own Zapier connection before any execution trial.
5. Package and separately test the new duplicate review UI before installing it. Preserve source/local/installed/live/customer evidence distinctions.

No complete-department or full-production stability claim is supported yet. The core now has real installed collection/preparation/repeat evidence and specific, reproduced next gates instead of assumed workflow completion.
