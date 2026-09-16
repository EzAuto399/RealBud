# Austin: interview evidence and working rehearsal

11 September 2026 · Internal delivery evidence · RealBud / Hermes + Cua

**The existing approval foundation has been exercised and two product defects repaired. Austin's complete bank routine is not ready yet.** The next implementation is a saved sign-in handover and bank-reference preparation, followed by actual Windows acceptance. Kevin should receive a configured routine; he should not have to design it in chat.

## What we ran

| Evidence | Result | Practical limit |
|---|---|---|
| Focused source tests | **181 passed across 9 files** | Includes real local HTTP, persistence and scripted provider tests; not live Austin systems |
| PM API journeys | **All 5 suites passed** | Desk, PM day, exceptions, portal jobs, walkthrough; fictional external services |
| Browser journeys | **50 checks across 4 journeys** | Actual built React UI and local server, with fictional setup/provider/worker responses |
| Type checking and web build | Passed | A web build is not a Windows installer |
| Grok evidence review | Four clip batches plus a UI review completed, following one visual canary | Requested `grok-4.6`, `xhigh`; CLI returned effective model `grok-4.6-build` |

The final focused tests cover attended runs, schedule recovery, job history, remote decisions, Hermes lifecycle, watchdog, rent configuration, HTTP routes and request validation. Existing lifecycle tests passing does not prove the proposed installation/update isolation requirements are implemented.

The browser checks consist of 21 workspace checks, 9 setup checks, 9 connected-app continuity checks and 11 Austin-specific checks. Setup installation responses and OAuth responses were simulated. A 390px second browser client is not a tested mobile notification service.

All work used a separate temporary RealBud data directory with fictional records. The browser was restricted to its local test server. The original videos were retained. No bank transfer, real REI import, message send, account connection or Windows installation was performed.

## What the clips establish

Grok reviewed 16 sampled frames extracted from the two supplied original clips with the existing full-clip ASR transcripts as context. Codex independently inspected key frames. This was not a new continuous audio transcription or frame-by-frame video review; speech and speaker attribution remain provisional where previously marked.

| Evidence | Observed or described |
|---|---|
| Clip 1, 01:26–03:52 | Spoken workflow: obtain bank CSV, inspect/edit in a spreadsheet, import into REI and resolve unmatched payments |
| Clip 1, 03:52–07:01 | Spoken exceptions: references may be codes, names, addresses or blank; checking roughly every two days. Arrears decisions remain with staff |
| Clip 1, 17:30 | Visibly shows REI Cloud Member Login with email/password and Sign in. No MFA challenge established by this frame |
| Clip 2, early spreadsheet sequence | Microsoft Excel on Windows; bank-derived narratives. ANZ appears in sampled narratives/bookmarks, but this does not establish the account product, permissions or export schema |
| Clip 2, 02:30 and 03:30 samples | REI Cloud Bulk Receipting, spreadsheet context and unmatched-reference warnings. This supports a reference-preparation workflow; it does not prove a completed import |
| Clip 2, approximately 05:57–10:14 | Spoken bill workflow: distinguish expected, received, missing, funds insufficient, payment arranged and paid; alert when an expected bill has not arrived |

The exact bank CSV header/order/encoding, REI accepted import format, property-reference mapping, MFA method and workstation CPU architecture are not established. Windows 11 appearance is an inference. Reuse these interview facts and request only missing artefacts or deployment details.

## What the Austin browser rehearsal actually proved

1. Mutations without the local session were refused.
2. An actual approval stayed waiting for two seconds, with no grant or worker advancement.
3. Clicking **Allow once** resolved the same request on both open browser clients. A stale replay returned 409 through both response routes; it could not save a standing rule.
4. Clicking **Deny** sent a rejection to the scripted worker.
5. Two simultaneous conflicting decisions produced one successful response and one conflict, with one run.
6. Clicking **Stop this turn** produced a cancelled run; a late approval could not revive it.
7. A scripted password-fill request was denied by the real server.
8. A scripted Pay click was denied by the real server.
9. Restarting with an unfinished run preserved it as interrupted and rejected its old approval.
10. A synthetic bank-shaped CSV was rejected without changing the property book.
11. No browser JavaScript exception occurred during the rehearsal.

These are permission and persistence checks. No actual Cua navigation occurred. Two seconds is not evidence of a long, quiescent authentication wait. Restart interruption is safe fallback, not same-step resume.

## Repairs made

**Stop status:** a worker could finish normally after its pending permission was denied during Stop. RealBud then labelled the attended run partial. Explicit user Stop now takes precedence; cancelled/interrupted reasons also override protocol success and old read-back. Unit cases cover both success values and multiple interruption reasons.

**Stale approval response:** both response routes now check the live pending-request registry. Old cards return a conflict before any provider response or standing-rule save. The browser rehearsal checks replay, restart, Stop and conflicting simultaneous decisions.

**Test harness:** the portal journey's restart timer could kill the replacement server. Cleanup now captures the old process, clears its timer and waits before removing temporary data. The fictional connected-app service now answers every app in a batched refresh. Stale schedule/connection wording assertions were updated without weakening their behavioral checks.

## Remaining acceptance work

| Priority / task | Test to build and pass | What we can prepare without Austin access |
|---|---|---|
| U02/U03 | Expired login → one saved Needs you case → release input/capture → Kevin signs in → Continue verifies correct account → resume exactly one step | Local sign-in surfaces with incomplete login, wrong account, MFA, logout and delayed verification; durable state and adapter contract tests |
| U02/U03 | Stop, restart, expiry, changed permissions and duplicate Continue during verification cannot dispatch stale work | Crash/restart and competing-client tests, fake clocks, controlled verification responses; no active model polling while waiting |
| P01 | Original bank export → proposed reference changes → reviewed REI-compatible copy | A format adapter, immutable originals, row change log, authoritative mappings, ambiguous/unmatched cases and amount/date/row-count invariants |
| P01/U02 | Duplicate/overlapping exports, identical-looking payments, reversal, coverage gaps and uncertain import outcome | Batch/row identities, held ambiguous duplicates, reconciliation fixtures; never infer duplicate solely from date and amount |
| U01 | Daily or explicitly anchored every-two-days routine delivers a prepared batch, with missed-run and timezone handling | An inactive first-party pack plus Austin configuration, schedule tests and bounded retries |
| Bills/M03 | Expected bill missing, arrived late, duplicate invoice, changed amount and insufficient funds create the right case | Fictional inbox and bill calendar; payment arranged remains distinct from paid; source-linked task creation |
| A03 | Desktop and the selected real phone resolve one intervention; offline delivery/retry does not duplicate or revive it | Shared action IDs, delivery receipts, expiry and stale-link fixtures. Real push/deep-link delivery remains a later device test |
| W06/Q02 | Actual installer on matching Windows 11 architecture; Hermes/Cua browser and native-app control; permissions, Stop, takeover and restart/update | Build from the exact intended revision and prepare the test script. Mac browser checks and ARM-only testing cannot establish x64 acceptance |

The bank sample above is deliberately illustrative: `Date,Amount,Narrative,Reference`. The existing importer requires ledger-aging fields such as `daysSinceDue`. Adding those to a bank fixture would hide the missing product capability, not solve it.

## Handover approach

**Build first:** RealBud owns typed steps, durable checkpoints, source coverage, account bindings, approvals and recovery. Hermes remains the execution adapter, with Cua providing computer actions. No Hermes source modification was made in this work. Engine replacement and phase-two CRM remain separate concerns.

**Then calibrate:** obtain one de-identified original export and the corresponding manually corrected/imported copy, a property-to-reference mapping, and confirmation of the Windows architecture/apps. We derive the schema and configure the pack. Kevin does not have to write a technical specification.

**Then prove on their account:** prefer a dedicated Austin Windows test user/device or VM matching their PCs. If testing on our device, use an isolated customer profile/VM and an explicitly agreed account/scope. Kevin signs in directly or grants a separate revocable account/connection with the needed access. Do not request his personal password or MFA codes. Start with read/export and review-only outputs; verify results against a known historical batch before enabling a recurring run. Actual REI processing remains under the agreed human approval boundary.

Measure staff active time, automated processing time, waiting-for-human time, unmatched rows, corrections, retries and attributable API usage separately. The rehearsal produces no defensible customer time-saving percentage yet.

## Lead review of Grok findings

Accepted: the login handover is missing; the bank importer is the wrong pipeline; permission approval is not evidence an external task succeeded; full Windows and notification acceptance remain open. Follow up on confusing normal-turn notes after a refused action and the wording of site-wide permissions.

Corrections: fictional text and the sample portfolio are intentional test labels, not customer-facing data leaks. The Check Bud warning comes from the fake worker's setup status; this test does not establish that real REI login causes a setup failure. Two renderings of one approval do not by themselves establish two independent permissions. A visible phone link does not establish either working or broken push delivery.

## Reproduce and inspect

Run `pnpm qa:austin` with Node 24+, `PLAYWRIGHT_MODULE` pointing to an installed Playwright module and, if needed, `CHROME_EXECUTABLE`. Set `QA_OUTPUT` to retain a separate run. This uses temporary fixture data; it never points at the user's real RealBud profile.

Evidence folder: `outputs/austin-validation-2026-09-10/` (work began on September 10 and continued after midnight). `austin-browser/result.json` contains checks, exact run outcomes and explicit scope. Screenshots, original failure logs, corrected-run logs, Grok request/finish receipts and `source-manifest.json` are retained there. The source manifest records 527 selected source/configuration files, including existing local changes; the Git HEAD alone is not the tested revision. No Windows installer was built or certified by this rehearsal.
