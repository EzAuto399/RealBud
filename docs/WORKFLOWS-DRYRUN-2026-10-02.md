# W1–W3 dry run — 2 October 2026

**Evidence tier: local tests and lab only.** Source modules and the local HTTP app on this Mac, fictional bank rows, a fictional REI-style portal, a fictional mailbox connector and a deterministic stand-in for the model. Not packaged, not installed, not live, not customer acceptance. Nothing was sent, no real bank or REI was touched, and nothing was submitted to REI. Scratch data directories only.

Receipts: [`outputs/workflows-dryrun-2026-10-02/`](../outputs/workflows-dryrun-2026-10-02/) (first run, kept as evidence) and [`outputs/workflows-dryrun-2026-10-02-r2/`](../outputs/workflows-dryrun-2026-10-02-r2/) (W1 rerun after the fixes) and [`outputs/workflows-dryrun-2026-10-02-r3/`](../outputs/workflows-dryrun-2026-10-02-r3/) (W1 after the switch to the live REI read: File Format ANZ(csv file), account scoped by the top-bar business code, reicid optional). The UI for the renderer scripts was built to scratch (`pnpm exec vite build --outDir <scratch>`, [log](../outputs/workflows-dryrun-2026-10-02/vite-build.log)) and passed as `REALBUD_UI_DIR` / `OMB_STATIC_DIR`; `dist/` was not touched.

## Results

| Workflow | Check | Pass | Fail | Skip | Receipt |
|---|---|---|---|---|---|
| W1 | `scripts/qa-workflows-dryrun.mjs` (r3: business-code-only settings, ANZ(csv file), top-bar mismatch check) | 17 | 0 | 0 | [r3 w1/receipt.json](../outputs/workflows-dryrun-2026-10-02-r3/w1/receipt.json), [log](../outputs/workflows-dryrun-2026-10-02-r3/w1-dryrun.log) |
| W1 | `scripts/qa-w1-simulated.mjs` (HTTP + renderer, r3, read-only use) | 13 | 0 | 0 | [r3 w1-simulated/receipt.json](../outputs/workflows-dryrun-2026-10-02-r3/w1-simulated/receipt.json), [log](../outputs/workflows-dryrun-2026-10-02-r3/w1-simulated.log) |
| W1 | vitest r3: browser-grants, browser-broker, browser-authority, native-browser-runtime, attended-run, portal-recipe-runner, portal-recipe-task | 297 | 0 | 0 | [vitest-browser.log](../outputs/workflows-dryrun-2026-10-02-r3/vitest-browser.log); `pnpm typecheck` passed ([log](../outputs/workflows-dryrun-2026-10-02-r3/typecheck.log)) |
| W1 | r2 (after the W1 fixes): `qa-workflows-dryrun.mjs` 16 / 0 / 0, `qa-w1-simulated.mjs` 12 / 0 / 0 | | | | [r2](../outputs/workflows-dryrun-2026-10-02-r2/) |
| W1 | first run, before the fixes: `qa-workflows-dryrun.mjs` 13 / 2 / 0, `qa-w1-simulated.mjs` 10 / 0 / 0 | | | | [w1/receipt.json](../outputs/workflows-dryrun-2026-10-02/w1/receipt.json), [w1-simulated](../outputs/workflows-dryrun-2026-10-02/w1-simulated/receipt.json) |
| W1 | vitest: w1-host, w1-workflow, w1-rei-workflow, w1-rei-reconciliation, bank-reference-match, browser-sign-in, fictional-rei-portal | 88 | 0 | 0 | [vitest-w1.log](../outputs/workflows-dryrun-2026-10-02/vitest-w1.log) |
| W2 | `scripts/qa-weekly-bills.mjs` | 6 | 0 | 0 | [weekly-bills/receipt.json](../outputs/workflows-dryrun-2026-10-02/weekly-bills/receipt.json) |
| W2 | `scripts/qa-source-bills.mjs` (month calendar, arrival predictions) | 30 | 0 | 0 | [source-bills/receipt.json](../outputs/workflows-dryrun-2026-10-02/source-bills/receipt.json) |
| W2 | vitest: source-bill*, weekly-bills-workflow, BillMonthCalendar (expected-payment forecasts) | 202 | 0 | 0 | [vitest-w2-rerun.log](../outputs/workflows-dryrun-2026-10-02/vitest-w2-rerun.log) |
| W3 | `scripts/qa-morning-mail.mjs` (45 threads, repeat, recovery, 390px) | 5 | 0 | 0 | [morning-mail/receipt.json](../outputs/workflows-dryrun-2026-10-02/morning-mail/receipt.json) |
| W3 | vitest: morning-mail-workflow, morning-mail-scheduler | 20 | 0 | 0 | [vitest-w3.log](../outputs/workflows-dryrun-2026-10-02/vitest-w3.log) |

The first W2 vitest run was 197 / 2 / 0 ([log](../outputs/workflows-dryrun-2026-10-02/vitest-w2.log)): both failures were in `server/weekly-bills-workflow.test.ts` while another session was editing that file and `weekly-bills-workflow.ts` (modified 13:27–13:28). The rerun after their edit settled was 202 / 0 / 0. That is a pass of their in-flight state, not a frozen candidate.

### W1 dry run: what it covers

One process, real `createW1Host` route handler (the one `index.ts` mounts at `/api/w1/*`), real review store, coverage cursor and durable run, the fictional portal behind the real `BrowserRuntime`, broker and recipe runner, and the real `openForSignIn` over the real `NativeBrowserRuntime` with a fake work-browser host that starts closed. Bank rows are the 27 rows of `server/testing/fixtures/anz-export-fictional.csv`, served by an in-process fake Redbark. The session gate is covered by `qa-w1-simulated.mjs`, not here.

Passed (r3): settings saved with the top-bar business code only (no reicid; File Format defaults to ANZ(csv file)) → masked account list → manual pull (12 rows, 2026-09-01..03); first pass over the ANZ file (6 import / 18 hold / 3 exclude); every Redbark batch has its own first pass (layout `bank-feed`, exceptions first, no exception row decided as import), applied as review decisions (run 1: 5 import / 7 hold / 0 exclude; run 2: 22 rows, 1 / 18 / 3; run 3: 1 / 18 / 0); cold start (no work browser open) → 1 launch, 1 `openForSignIn`, run past sign-in to the `browser_download` ask; warm path in its own run (browser open, REI signed out) → second `openForSignIn`, Stop during sign-in leaves the run at sign_in with no REI effect and no extra launch; run 3 (window 09-05..09-08) offered all 18 earlier holds, the pull summary's `carried` = 10 (the holds dated before the window), each a Hold exception "Held from an earlier pull · {date}"; a run with no new transactions and 18 holds open opened a review of exactly those 18 instead of "No new bank transactions"; REI import file built in the ANZ(csv file) layout (no header, DD/MM/YYYY, 8 columns, property reference in column 8; held rows left out); a different top-bar business code (FICT2) stops the run at sign-in with `account_mismatch` before any upload ask and nothing changed in REI; Stop at review, sign-in handover, upload ask, handoff and register read; sign-in handover with no typing by Bud; Stop with the upload ask open → outcome unknown → REI checked → nothing found → re-upload only on the person's choice; restart at handoff; duplicate posting report refused (409); readback 5/5 → covered through 09-03; run 2 (08-31..09-08, held rows offered again, 1 import, 3 exclude); restart mid-upload → boot recovery to check_outcome → re-upload by choice; posting "unsure" reconciled from the register; lost reply after REI accepted the file → pending found, no second upload; preview mismatch blocks handoff and posting (409); Bud pressed nothing that posts (4 approved uploads, 0 other effects); no network beyond the loopback broker.

**Interlock.** Every browser command URL, sign-in tab, sign-in site and recipe pack must be on `https://rei-mock.fictional.test` or its fictional sign-in host; anything else throws and fails the run. Negative cases (all pass): a real-REI navigate never reaches the browser; the real `rei-cloud` pack and the real b2clogin sign-in host trip it; a whole W1 host loaded with the real pack stops at sign-in with zero browser commands sent. Main run (r3): 0 trips over 3,819 portal commands.

## Bugs found (both fixed by another session; r2 asserts the fixes)

1. **W1-COLD-SIGNIN — sign-in fails instead of opening the work browser.** Fixed: r2 `scenarios.coldStart` = `{launches: 1, signInCalls: 1, step: "upload", ask: "browser_download"}`. Original report: Owner: `server/w1-host.ts` (`rei.session` → `context_`). With no work browser open, `browserId()` is null (production: `NativeBrowserRuntime.status().state` is `"off"`/`"disconnected"` at cold start), so `context_("session")` throws 409 "Connect your browser before Bud checks REI." before `openForSignIn` is reached. `openForSignIn` → `openSignInTab` would launch the browser (`connect()`), but it is never called. Reproduce: `node scripts/qa-workflows-dryrun.mjs` → step 3, receipt `scenarios.coldStart` = `{launches: 0, signInCalls: 0, note: "Connect your browser before Bud checks REI."}`. Existing `w1-host.test.ts` misses it because the lab `browserId` always returns `"work"`. Suggested fix: in `session()`, when `browserId()` is null and `openForSignIn` is wired, hand over sign-in first, then run the read-only check.
2. **W1-HELD-AGING — held rows silently stop being offered.** Fixed: r2 `scenarios.heldCarried` = 18 held, 18 offered again, 0 dropped, `carried` 10. Original report: Owner: `server/bank-reference-store.ts` (`RedbarkCoverage.window`, `confirmRedbarkImport`) with `server/redbark-source.ts` (`pullRedbarkReview`). Held rows are kept out of the confirmed set so "an overlapping pull offers them again", but coverage advances to the batch's last date and the next window starts 3 days before it. Reproduce: same script, step 7, receipt `scenarios.heldAging`: 18 held after run 2 (confirmed through 09-08); run 3 (window 09-05..09-08) offered 8; the 10 holds dated 09-02..09-04 were not offered again and nothing flags them as outstanding. The UI's "Hold: … don't import yet" implies they return.

## Gaps (not bugs in the code tested)

- ~~The first-pass matcher does not run on bank-feed batches.~~ Closed: Redbark batches now get a `bank-feed` first pass (r2).
- The lab server (`index.ts`, `REALBUD_TEST_W1_FICTIONAL_REI=1`) wires no `openForSignIn`, so HTTP-level QA cannot rehearse the sign-in handover.
- No browser QA asserts `expected-payment` calendar entries; forecasts are unit-tested only (`BillMonthCalendar.test.ts`, `source-bills.test.ts`).
- W3 backlog fairness and re-review of changed reviewed items (gap plan items 2–3) were not re-tested.

## Proposed recipe and site-map changes (not applied)

1. Add a read-only `bulk-receipting-pending` recipe to `rei-cloud-navigation/recipes.json` after a read-only study of REI's Bulk receipting page with a pending file. Today only the fictional pack has it, so after a lost upload reply live REI inspection is "unknown" and no re-upload is offered.
2. Record REI's accepted ANZ(csv file) column contract in `site-map.json` once a real preview of a tiny file is seen. The builder now emits the ANZ export layout (no header, DD/MM/YYYY); the fictional portal's ANZ(csv file) parser is still a guess.
3. Add `signIn.postLogin` paths (e.g. the dashboard path) to `site-map.json` so sign-in detection is exact instead of the login-path heuristic.
4. Confirm live REI's pagination landmark (null in the real pack; the fictional pack declares one).

## Learning notes for Bud

`pack/workflows/austin-accounts/support/learning/`: [W1](../pack/workflows/austin-accounts/support/learning/w1-bank-to-rei.md), [W2](../pack/workflows/austin-accounts/support/learning/w2-weekly-bills.md), [W3](../pack/workflows/austin-accounts/support/learning/w3-morning-priorities.md). Each lists step inputs, failure handling, Kevin's decisions and the first-live-run preflight, including that real REI runs read-only recipes only until the owner authorises an upload.

Not linked from `docs/GOAL-PROMPT.md` / `docs/END-STATE.md`: those files are outside this packet's ownership.
