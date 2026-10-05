# Kevin's and Sherry's workflows: build order

Status: owner decisions and plan, 4 October 2026. Evidence tier: source review only. No new workflow is built, installed or accepted by this document.

## Owner decisions (4 October)

- **First promise is invoice review.** RealBud prepares Kevin's weekly invoice review with source evidence and exceptions.
- **Build in parallel with the core gates.** Work that needs no customer input starts now. Installed runs with real mailboxes and acceptance with Kevin and Sherry still wait for the [core completion plan](CORE-COMPLETION-PLAN-2026-10-04.md) gates, including the native Stop hold. This narrows that plan's department-entry rule for build work only.
- **Sherry's inspections (W5) come after maintenance (W4).** Meanwhile, a no-code check records which Property Inspect tools Zapier exposes.

Specs: Kevin W2 in [Gmail W2/W3 operating model](decisions/2026-10-01-gmail-w2-w3-operating-model.md) and [Kevin invoice rehearsal](decisions/2026-10-01-kevin-invoice-rehearsal.md). Sherry W4/W5 in [Sherry build plan](SHERRY-WORKFLOWS-BUILD-PLAN-2026-10-02.md), which supersedes the W4 section of the [30 September plan](AUSTON-KEVIN-SHERRY-WORKFLOW-PLAN-2026-09-30.md).

## What exists (source, checked 4 October)

| Step | Kevin W2: weekly invoice review | Sherry W4: maintenance history and alerts |
|---|---|---|
| Collect Gmail | Built: `server/weekly-bills-workflow.ts`, Monday loop paused by default | Collector reusable; no W4 loop |
| Extract facts | Partial: one PDF per message, text layer only (`server/bill-proposals.ts`) | `BillFacts` has no supplier reference or work description |
| Review and dedupe | Built: invoice number/version, forwards and versions | Same register |
| Check against REI | Missing: paid status is entered by hand; REI read recipe has no observed steps | Supplier directory missing |
| Calendar | Built: expected arrival and payment (`BillMonthCalendar`) | Not projected |
| Exceptions and alerts | Partial: missing-arrival and follow-ups; no unpaid/low-funds/advance sweep | Missing: sender-verification and multiple-invoice findings, notify-once |

Highest proof so far: an installed device collecting from a test Gmail account (negative case only), `outputs/auston-department-rehearsal-2026-10-01/`. There is no real positive invoice, REI read or customer acceptance yet.

## Phase A: build now (no customer input)

1. **Supplier reference and work description on bill facts.** Optional reviewed fields, compatible with stored facts and audit hashes. Both workflows need them.
2. **Supplier directory.** Import the REI supplier list (reference, description, one or more emails), stored privately with revisions. Matching uses exact email or an accepted alias only, never display name or domain.
3. **Maintenance findings, pure function.** Sender-verification and multiple-invoices findings per the W4 spec. Copies, reminders and forwards don't double count; stable finding ids; a third invoice updates the same finding; window rule is a setting (default: calendar month by invoice date, pending Sherry).
4. **Kevin positive-path check.** Accepted bill, approved pattern, calendar readback, using fictional data. This waits until the session currently editing `scripts/qa-weekly-bills.mjs` finishes.
5. **Wiring (later, one owner).** Directory routes, the W4 loop in `server/routines.ts`, seen/dismissed state and the Desk view, after the files other sessions are editing settle.

### Progress, 5 October (source + local tests; not wired, not packaged)

- Item 1 done: `supplierReference` and `workDescription` on `BillFacts`, review form and "Save for later" (`shared/source-bills.ts`, `server/source-bill-rules.ts`, `server/source-bills.ts`, `src/lib/source-bill-form.ts`, `SourceBillsPanel.tsx`, bill-review drafts). Legacy facts and audit hashes are unchanged (test: "keeps legacy facts and their original audit hashes…"). Open: the model doesn't yet propose a work description. That needs an optional field in `server/accounts-review-schemas.ts` and the `pack/workflows/austin-accounts/contracts/` schema. The new inputs haven't been checked by eye in the running app.
- Item 2 done: `shared/supplier-directory.ts`, `server/supplier-directory.ts` (CSV import, aliases, exact-email match, conflicts, private revisioned store).
- Item 3 done: `server/maintenance-findings.ts` (`computeMaintenanceFindings`, `newOrChanged`). Its limits are marked with `ponytail:` comments.
- Checks: 108 tests in 6 files pass; `pnpm typecheck` and the server typecheck pass.
- Questions for Sherry: calendar month or rolling 30 days, and by invoice date or received date? Should an unresolved revision get its own alert? How common are invoices without numbers?

### Progress, 5 October afternoon (local tests; not packaged)

Owner asked for Kevin W1–W3 and Sherry W4–W5 ready and tested. Every result below was rerun by the integrating session.

- **Item 4, Kevin's positive path:** `scripts/qa-w2-calendar.mjs` passes 5/5. An accepted bill lands on its reviewed due date with the expected payment beside it, predicted arrivals start the next month, and a replay adds nothing. The replay reports `changed: 1` with nothing duplicated, so check that before W2 notifications go live. Receipt: `outputs/w2-calendar-2026-10-05/`.
- **Item 5, W4 wiring:** `server/maintenance-review.ts` adds a findings store with notify-once, seen/dismissed and a saved month rule, plus supplier-directory and findings routes behind the owner-session gate. A "Maintenance checks" loop runs weekdays 08:30, off until enabled. `MaintenanceFindingsPanel` is mounted in `ExpectedBillsBoard`. The loop id was added to `shared/contracts.ts` and to the tests that pin the loop list. `scripts/qa-maintenance-review.mjs` passes 12/12 against the W4 acceptance list. Receipt: `outputs/maintenance-review-2026-10-05/`.
  - Not built yet: a screen for importing the supplier list (HTTP only), links from a finding's source entry to its bill, reading the original sender of forwarded mail, and a desktop pop-up for this loop. The alert is the unseen-run attention on Desk.
- **W5 planner (offline only):** `server/inspection-plan.ts` is a pure six-month planner grouped by area/day/time, with holds, stable ids and pinned bookings. 10/10 tests pass. Fixture and Sherry's questions are in `pack/workflows/austin-inspections/`. No Zapier/MCP call and no wiring.
- **Gate (current working tree, scratch UI build):** qa-w1-simulated 13/13, qa-workflows-dryrun 17/17, qa-bank-bytes and qa-bank-amendments pass, qa-weekly-bills passes, qa-morning-mail passes (needs `OMB_STATIC_DIR` set to the scratch build), 145 unit tests in 7 files pass, `pnpm typecheck` passes.
  - Failing: `qa-source-bills.mjs:143` never connects its second page after the HTTPS/owner-token migration. The fix is one line, `await connectOwnerPage(other, data)`, and belongs to the session that ran the migration.
  - Running the scripts in parallel under load made W1 time out, so run the gate one script at a time.

### Progress, 5 October evening: Bud as the office's daily employee (local tests; not packaged)

Owner direction (5 Oct): Bud works like each person's own daily employee. It tells them in chat, learns how they work and saves their rules after approval.

- **Findings in chat:** `server/loop-chat-cards.ts` posts one card into Bud's active Ask thread when weekly-bills, morning priorities or maintenance checks settle with something new. It follows the same rules as the desktop notification: an unchanged rerun posts nothing, and a repeated hold posts once. Duplicates are prevented across restarts. "Open" goes to Desk (`OptionCard` `opens: "desk"`). It is wired in `emitLoopAndPulse` in `server/index.ts`.
- **Bud saves rules after approval:** `server/workflow-settings-broker.ts` adds the MCP tools `workflow_settings_read`, `workflow_settings_propose` and `workflow_settings_restore`. Each change shows before → after on an approval card (once only), saves with a revision check and keeps the last 10 versions. Targets:
  - maintenance month rule, which now has its own `ruleRevision` so a loop run can't make an approved change conflict
  - inspection rules, in a new store `server/inspection-rules.ts` with `GET/PUT /api/inspection-rules`
  - morning priorities. No restore history yet. Saving resets agency-setup review, which is existing behaviour, and the card says so.
- **Learning skill:** `pack/property/skills/working-rules/SKILL.md`. Bud asks a few plain questions during a person's setup, sends work rules through the approval card and personal habits through memory review ("What Bud learned"). It ships with Install/Repair. `SOUL.md` now says memory is for a person's working preferences, not property facts.
- **Gate (sequential, scratch UI build):** all 8 workflow QA scripts pass. qa-maintenance-review now also checks the chat card and that Open goes to Desk. 422 unit tests in 24 files pass, and `pnpm typecheck` passes.
- **Not proven:** a live Hermes turn using the skill and tools, a packaged build, and an installed device.
- **Shared-tree note:** Codex's HTTPS/owner-token change is being replaced by the session-token approach (`claude/mac-integration`). On branch `claude/kevin-sherry-showcase` the QA scripts use `scripts/local-session.mjs` (readSessionToken, primeBrowserSession).

### Progress, 5 October night: live Sherry test, growth fixes, desktop shell

- **Live GUI test (local GUI run, real model, real office link):** Sherry's setup chat produced two approval cards (maintenance basis → received date; inspection rules). Both saved with history. Receipt: `outputs/sherry-live-setup-2026-10-05/REPORT.md`.
- **Never blocked by a loose folder:** an owner-owned data folder that is too open is tightened to 0700 at launch and on use. A too-open file stays refused, because its secrets may already have been read. Foreign owners and links get a plain reason, which the office link passes through. See `.claude/rules/server.md`.
- **Storage and memory keep growing:**
  - Desk backups now sort by number, keep the newest 5 and delete the rest, and auto-restore falls back to the newest valid backup.
  - Bud's memory limits are 12k / 6k chars, and Bud merges old entries when full.
  - Shipped SOUL and skill files that the office hasn't edited update on startup after a pack change.
  - Open risks from the audit: a write-size guard in `writePrivateJson`, a `.prev` last-good fallback, chat thread growth and archiving, and per-store schema upgrade steps.
- **Desktop shell (owner decision 5 Oct, `docs/decisions/2026-10-05-desktop-shell-and-ui-components.md`):** rail, context sidebar, tabs, right panel, status bar, Arrange Desk with Show/Hide and Reset, ⌘K "Find or do" (open only), plus a toast, metric card and empty-state kit. `qa-desktop-shell.mjs` passes.
  - Stale selectors not owned here: `qa-screen-loading.mjs` still checks over http, and `qa-sidebar-refinement.mjs` still expects the old "Ask" name.

## Phase B: inputs only Kevin, Sherry or the owner can supply

**Kevin:**
- Gmail account and folders to scan
- the property directory with council, water and levy ids
- 5–10 real invoices (normal, forwarded, corrected, scanned)
- confirmation of recurring patterns and what "predicted payment" means
- weekly run time
- which REI screen is the source of truth for paid status, plus an attended REI sign-in for read-only recipe study

**Sherry:**
- the full REI supplier export with emails
- Gmail account and folders to scan
- ~~month rule~~: **calendar month** (owner for Sherry, 5 Oct). Invoice date or received date is still open; the default is invoice date
- ~~where alerts go~~: **desktop notification**, visible while she is in chat (5 Oct). `maintenance-review` was added to `src/lib/notify-routine.ts` and fires once per run with new or changed findings. An in-chat card is not built
- ~~inspection cycle basis~~: **completed date** (5 Oct)
- her working days, inspectors, appointment length, travel time, capacity and area groups: **Bud collects these with Sherry during her own onboarding/setup** (5 Oct). Until Ask can apply settings, Bud records her answers and a person enters them
- samples: repeat repairs, unrelated repairs, forwarded copies

**Owner:**
- who approves payments and notices
- who signs acceptance
- the REI sign-in rule ("reuse session" or "fresh login each run" — the two decision docs conflict)

## Phase C: completion

After the core gates pass, package and install the build, run it on the real mailboxes with Kevin and Sherry, rerun it to confirm no duplicates, and record acceptance in `outputs/kevin-sherry-acceptance-<date>/`. Each workflow counts as complete only at the customer-acceptance tier.
