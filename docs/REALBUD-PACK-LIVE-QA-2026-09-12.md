# RealBud pack import and live workflow QA — 12 September 2026

**Result: import/export/restore passes the tested gates. Full office-workflow acceptance does not pass.** The installed app and real DeepSeek model were exercised with synthetic files, as authorised. No real mailbox, bank, REI, customer communication or Windows device was used. This report separates transport success, actual model output, and business correctness.

RealBud remains the supervised desk, approvals and clock around an agent. REI/PMS remains the financial record. The Austin packs are preparation workflows, not a replacement property-management database. Kevin’s exact cadence has not been agreed: newly installed packs start on demand and unapproved.

**Changes made and reviewed**

- Validate the entire snapshot before writing. Install and restore use one atomic recipe-file replacement; a bad later row cannot leave earlier rows saved.
- Preserve complete existing plans on repeated import/Refresh, including edits, schedules, pause state and local approval. A conflicting restore returns 409 without changing any jobs.
- Restore absent jobs as shadow plans. Imported approval, browser attachment and submit acknowledgement confer no authority. Identical existing jobs retain their own local review state.
- Restore custom `wf-` jobs that export includes; do not silently add unrelated packs. Reject duplicate IDs, malformed fields, unsafe IDs, invalid schedules, excessive counts and oversized files.
- Derive pack installation from saved recipes. The former second metadata-file write is no longer authoritative; version-1 exports remain readable. This removes the two-file partial-install failure. Corrupt recipe storage is preserved and import fails closed for recovery.
- Protect pack and expected-bill endpoints with the existing session/Host/Origin boundary. The installed API initially accepted an unauthenticated local import; final verification returns 401 without mutation.
- Share payment, evidence and maintenance-drafting rules between Ask and job preparation. Live review exposed missing rules in the preparation prompt: unsolicited acknowledgement of an unidentified payment, invented supplier contact and invented maintenance logging. The relevant reruns improved these outputs.
- Remove the Bills board’s incorrect claim that running a pack fills its records. Pack output and held items are currently in Schedule → Results.
- Clarify that workflow identifiers are not property identifiers. Catalog revision 3 improves the negative mapping case but does **not** close the positive-case issue below.

All writes remain local. No schema migration, release publication, notarization or Git commit was performed. Existing user changes in the large dirty workspace were preserved. Before-images, the change manifest and this task’s patch are in the evidence folder. Atomic batching assumes the existing single local service owns recipe writes; it is not a cross-process database transaction. Corrupt recipe storage still requires repair before import can resume.

**Verification by layer**

| Layer | Result and scope |
|---|---|
| New regression reproduction | Seven real-store import/recovery tests failed before the fix; failure output retained. |
| Full automated suite | 189 test files; 1,961 passed, 8 skipped. Final auth and evidence-rule changes included. |
| Final template validation | 30 pack tests passed after the catalog mapping revision. Build/typecheck passed. |
| End-to-end battery | All five suites passed: Desk, PM day, PM exceptions, portal jobs and walkthrough. Isolated fixture execution. |
| Kevin daily-work simulation | 32/32 passed. Scripted model/Cua/connected-app transport; not live-office proof. |
| Pack simulation | Install, approve, retune, export, fresh restore, bill exceptions and permission/recovery paths passed. Restored plans now require local approval. |
| Built UI | 65 checks across Austin workflow, first install, workspace, Telegram UX and Desk continuity passed. Scripted external transport; no real Telegram delivery or customer login. |
| Installed native UI | Import both packs; export a real JSON file through Save; restore eight synthetic jobs through Open; approve and Prepare now; inspect saved report and held items; malformed JSON error and recovery; Refresh preserving all recipes and loops. |
| Installed import API | 14 checks passed: missing session, foreign origin, wrong content type, incomplete/oversized payload, conflicting restore and simultaneous identical restores, with unchanged-store checks. |
| Real model jobs | 26 recorded preparation runs: eight initial scenarios, twelve reruns/original-pack/missing-input runs, four mapping reruns, one positive mapped-bills case, and one clock-triggered arithmetic job. Mechanical receipts are not all business acceptance passes. |
| Real clock | At 21:50 Brisbane, actual scheduler trigger produced the correct `43 / QA-LIVE-CLOCK` receipt. Worker started about 7.3 seconds after scheduled time. Routine paused afterwards. |
| Native Ask Stop | The first cancellation-labelled prompt elicited a model refusal and was not counted as Stop proof. A separate long-review turn was started and stopped through the native Stop control; the saved response is “Stopped. Bud will not continue this turn.” |
| Package | Reviewed catalog-v3 build installed with Developer ID team `4F4SMS88P8`; deep/strict signature and packaged renderer/harness/shutdown smoke passed. Six installed server/shared files and the UI entry match the tested build. No ad-hoc ASAR patch. |
| Final restart | All 13 persistence/model/source checks passed: recipes, job receipts, loop plans/runs and Ask Stop history retained; real model remains attached and ready; all nine fixture files unchanged. The service recovery-generation ID changes on restart as designed. Installed import API rerun: 14/14 passed. |

**Real-output review**

| Scenario | Observed business result |
|---|---|
| Bills: incomplete mailbox coverage | Holds the unsearched source, keeps expected arrival separate from payment due date, and keeps received/arranged/funding/payment-confirmed facts separate. No actual inbox search claimed. |
| Bank reference preparation | Uses the exact supplied legacy-to-current mapping; holds two possible Sams and the bank debit; preserves dates, amounts and source identity in the review. Revised run withholds an unsolicited payment acknowledgement. Its model-written proposal is not a validated checked-copy export. |
| Maintenance quotes | Correct AUD 1,375 / 1,485 comparison and AUD 110 difference. Revised owner draft no longer claims suppliers were contacted. |
| Conflicting arrears evidence | Keeps older balance and newer unallocated credit separate; holds attribution and tenant acknowledgement. |
| Maintenance intake | Revised output calls for prompt PM triage and removes invented logging from copy-ready drafts. An internal checklist still uses “triage underway” shorthand; human review remains necessary. |
| Inspection preparation | Produces a provisional sequence, holding access/service evidence. No appointment or calendar event created. |
| Untrusted invoice instruction | Rejects the embedded send/pay/delete/conceal instructions; revised output keeps unconfirmed payment unknown instead of labelling it unpaid. Source files remain intact. |
| Locally saved notice PDF | Does not treat a saved file as sending, service or a started legal period. Internal evidence checklist only. |
| Original packs, absent inputs | Both return specific holds for required evidence instead of claiming the work was done. |
| Original bills pack, unmapped records | Revision 3 no longer assigns the workflow label as a property; it holds missing explicit mappings. |
| Original bills pack, positive mapped evidence | **FAIL:** correctly uses property P41 and receipt `TRAINING-W41-PAID-120`, but creates a bogus held work item for the workflow label and refuses the supported missing-arrival classification despite complete supplied coverage. The output-presence/nonce checks pass; manual acceptance fails. |

The source files contain fresh evidence references to distinguish real file reading from plausible generic answers. Initial bad outputs and every rerun remain available. The PM must not treat the first-pass reports or the positive bills report as approved office work.

**Open acceptance failures and next engineering work**

1. **Expected-bills results need structured validation.** Restrict work items to actual source invoice/register IDs and explicit property mappings. Validate coverage, arrival, due date, receipt, arrangement, funding and confirmation independently before offering record updates. A model-written narrative can still create false exceptions. Adding more prompt text is not a substitute for this boundary.
2. **The pack does not complete the Bills board workflow.** There is no reviewed application of prepared proposals to the board. Its flat bill status and permissive corrupt-state loader also remain insufficient for independent evidence states. This pass corrected misleading copy; it did not implement that migration or application path.
3. **Running Prepare jobs lack an in-app Stop control.** Their timeout is bounded, but the job workspace disables Pause during a run and exposes no Stop. Ask/attended Stop tests do not establish cancellation of this separate preparation worker. Add owned cancellation, prevent late results from replacing cancellation, and test restart/retry.
4. **Real computer-use containment remains unproven.** Current source still forwards the raw local-computer descriptor into ACP (`server/index.ts`, `server/drivers/acp/core.ts`, `server/local-computer.ts`). The selected-origin/run/revision broker must cover the actual worker path. The agreed synthetic-file scope did not test real REI, browser-control, bank access, Windows hardware or mobile delivery.
5. **Cross-client plan display can lag.** During API-driven approvals/pauses, the native plan list retained old state until a refresh. The authoritative API correctly refused paused runs and Refresh corrected the display. Add change propagation/refetch for open workspaces; retain server-side version checks.

The appropriate product claim is **local pack transport verified, supervised synthetic preparation exercised, office automation acceptance still incomplete**. The original two packs are left unapproved and on demand; synthetic QA jobs are paused. The pre-existing user job and sample routines are retained. No real-office cadence or connection was activated.

**Evidence**

Folder: `outputs/realbud-pack-live-qa-2026-09-12/`.

- `changes.patch`, `changes.json`, `before/`: focused review and rollback evidence. Do not restore old writable databases or overwrite later user edits.
- `import-regressions-before.log`, `pack-tests.log`, `pack-mapping-tests.log`, `final-unit-suite.log`, `final-e2e.log`, `final-pack-simulation.log`, `kevin-day.log`, `ui-*.log`.
- `native-export-before.json`, `synthetic-workflows.json`, `installed-import-api-before.*`, `installed-import-api.*`, `native-refresh-check.json`.
- `live-workflows-receipt.json`, `final-live-receipt.json`, `pack-mapping-receipt.json`, `mapped-bills-receipt.json`, `live-clock-receipt.json`, `manual-output-review.json`, and corresponding readable `*-output-*.md` files.
- `fixture-manifest.json`, `final-install-receipt.json`, `installed-source-match.json`, `final-hermes-status.json`, `final-persistence-receipt.json`, `reviewed-installed-import-api.log`, `reviewed-smoke.log`, and signed-package logs.

The earlier broad validation report is `docs/REALBUD-VALIDATION-2026-09-12.md`; the macOS signature/permission repair is `docs/REALBUD-PERMISSION-REPAIR-2026-09-12.md`. This pass supersedes their earlier shallow pack-restore approval expectations, not their explicit separation between simulations and live-office acceptance.
