# Austin — setup, workflow coverage and implementation register

Updated 2026-09-11. Windows-first planning register; decisions are recorded, implementation and installed-office acceptance remain open.

Edit `AUSTIN-DELIVERY-PLAN-2026-09-10.json` as the canonical task register. Run `proposal-v3/delivery.py` to regenerate the page, Markdown and CSV. This register describes work still to decide, build or verify; it is not a live completion tracker.

The [consolidated operating plan](AUSTIN-OPERATING-PLAN-2026-09-10.md) controls Windows delivery, commercials and the execution log. Windows acceptance remains open.

Latest rehearsal: 181 focused tests, 50 browser checks and 5 PM suites passed. [Local foundation verified; customer workflow and Windows acceptance remain open](AUSTIN-REHEARSAL-2026-09-11.md).

## Setup and handover

### 1. Prepare the office

**We do:** Yoda records scope, deployment, costs and a supported release path.

**Austin does:** Danny confirms ownership; Kevin supplies the native app names, PC architecture, bank sample, REI format and bill examples.

**Proof:** Scope, sample contract and seed bill register accepted.

**Tasks:** D01, D02, D03, D04, W01

### 2. Make the foundation safe

**We do:** Bind agency/runtime, preserve settings and prove backups. Keep first-party module work small and complete its independent lifecycle after the Windows slice.

**Austin does:** Confirm who owns credentials, backups and the support route.

**Proof:** Engine change and restore exercises pass without resetting office data.

**Tasks:** F01, F02, F04

### 3. Prove one Windows workflow

**We do:** Package and wire Hermes + Cua, build the intended source in GitHub Actions and test the actual installer on matching Windows 11.

**Austin does:** Kevin demonstrates the selected website/native-app task and confirms the reviewed output.

**Proof:** Clean install/login/persistence plus browser/native control, approval, Stop, takeover, update and recovery have recorded results.

**Tasks:** W02, W03, W04, W07, W05, W06

### 4. Connect and resume

**We do:** Provision technician settings; present one clear consent/recovery step.

**Austin does:** Account owners consent to the selected Gmail/provider/channel access.

**Proof:** Correct account, actual read scope and coverage verified; setup resumes after restart.

**Tasks:** S01, S02, M01, M02

### 5. Verify rent and bills

**We do:** Build the review cases and run ordinary/exception samples together.

**Austin does:** Kevin confirms mappings/cycles and checks the result in REI.

**Proof:** Balanced import result, trustworthy bill states and shared calendar cases.

**Tasks:** P01, P02, P03, B01, B02, B03

### 6. Test reminders and recovery

**We do:** Verify actual phone delivery, budgets, missed runs and installed Windows recovery.

**Austin does:** Confirm the recipient can reach the current case and understands incomplete checks.

**Proof:** Phone, outage, restart, restore and budget tests recorded. Kevin rehearses the routine and resolves one desktop/phone approval, with both views updated. Kevin signs in in the original app and uses Continue; premature/wrong-account continuation is held.

**Tasks:** A01, A02, C01, Q01, Q02, U01, M03, A03, U03

### 7. Hand over with evidence

**We do:** Train, measure, provide runbooks and record the accepted version/scope.

**Austin does:** Kevin demonstrates daily use; Danny accepts outcomes and commercial terms.

**Proof:** Dated handover acceptance; only then start the agreed subscription.

**Tasks:** Q03, Q04

## Workflow scope

### Recurring bank download → reviewed REI result — Phase 1

**Interview / decision evidence:** C1 01:26–06:07; C2 00:00–03:42; C3 10:07–10:10

**Before:** Download bank data, look up unclear references, edit the file and check REI receipts.

**Proposed:** Download the agreed export daily or every one-to-two days; prepare references and held exceptions; Kevin approves the copy, and the REI recognition/import result is verified.

**Staff retain:** Kevin owns ambiguous matches, import approval and final financial checking.

**Tasks:** D02, P00, U01, U02, P01, P02, P03, A03

### Expected bills → verified follow-up — Phase 1

**Interview / decision evidence:** C1 07:33–10:53; C2 05:57–10:14

**Before:** Look for arrivals, maintain expectations and manually track payment arrangements.

**Proposed:** One evidence-linked bill case shows missing/received/arranged/verified states and funding exceptions, with shared calendar and reminders.

**Staff retain:** Staff confirm cycles, funding/advance decisions, disputes and authoritative payment evidence.

**Tasks:** D03, M01, M02, B01, B02, B03, A01, A02

### Daily inbox → organised work and bill evidence — Phase 1

**Interview / decision evidence:** Kevin’s connection request; C1 17:26–17:46 and C3 08:38–10:15 plus subsequent Phase 1 direction

**Before:** Open messages and attachments repeatedly to find bill and receipt context.

**Proposed:** Consented daily reads organise internal payment, bill, maintenance and follow-up work with source links, owners and visible gaps. Mailbox changes and sending require separate authority.

**Staff retain:** Account owners consent; Kevin reviews unreadable or conflicting evidence. Email access is not sending authority.

**Tasks:** S01, M01, M02, M03, U01, U02

### Buyer/listing work → optional shared CRM — Phase 2

**Interview / decision evidence:** C2 11:57–18:21; C3 00:00–03:52, 10:15–14:34; Twenty is Yoda’s subsequent proposal

**Before:** Consolidate spreadsheet records, search price groups and prepare audiences manually.

**Proposed:** Twenty holds shared records; native RealBud views and Bud prepare reviewed updates and follow-up.

**Staff retain:** Staff resolve duplicates, confirm budgets, approve audiences and own customer relationships.

**Tasks:** R01, R02, R03

### Arrears notices and sent evidence — Later · scope first

**Interview / decision evidence:** C1 06:07–07:01; C2 03:45–05:57

**Before:** Generate notices in REI and retain or recover the sent evidence manually.

**Proposed:** Potential evidence gathering and filing assistance around staff-approved notices.

**Staff retain:** Legal eligibility, hardship judgment, sending and delivery verification stay with staff.

**Tasks:** X01

### Airbnb payout allocation — Later · scope first

**Interview / decision evidence:** C1 13:15–14:14

**Before:** Look up bookings and split a combined payout for entry/checking.

**Proposed:** Potential allocation preparation using verified booking/payout data and reviewed rules.

**Staff retain:** Staff resolve exceptions and verify final REI/owner totals.

**Tasks:** X02

### Maintenance handoffs — Later · walkthrough needed

**Interview / decision evidence:** C1 10:55–12:51; high-level discussion only

**Before:** Gather the issue, contact the responsible people and follow through to completion.

**Proposed:** Potential context/quote summaries and follow-up assistance after a PM walkthrough.

**Staff retain:** Emergency judgment, trade dispatch, owner/spend approval and completion checks.

**Tasks:** X03

### Outgoing follow-up and mailbox changes — Later · separate from bill intake

**Interview / decision evidence:** C1 17:26–17:46; C3 08:38–10:15

**Before:** Sort messages and look up context before deciding the handoff.

**Proposed:** Separately agree authority for replies, labels/archive and broader outreach. Daily internal inbox organisation is covered by the Phase 1 Gmail workflow.

**Staff retain:** Staff approve recipients and consequential mailbox/outgoing actions; read consent alone does not permit them.

**Tasks:** X04

## Task register

### 01 · Confirm the Windows pilot

#### D01 · Agree the office and pilot boundary

**Workstream:** Setup · **Owner:** Yoda + Danny + Kevin · **State:** Decision / input needed

**Depends on:** No earlier task

**Input needed:** Office timezone, property/bill volumes, Windows 11 workstation and CPU architecture, native apps, reviewer, operating hours and support contact.

**Implementation:** Record one-office scope, who reviews finance, supported formats/accounts/channel and which work stays outside Phase 1. Confirm delivery feasibility before accepting payment.

**Acceptance:** A dated scope record and named decision owner; no implied multi-user or always-on promise.

**Recovery:** New format, role or volume triggers a reviewed scope change, not an expanded permission.

**Source owners:** `shared/office.ts`, `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

**Latest evidence:** Office preparation and interview discovery are reported complete by Yoda. Reuse the clips and existing decisions; confirm only deployment facts absent from that evidence.

#### D02 · Collect one representative bank and REI sample

**Workstream:** Bank · **Owner:** Kevin + Yoda · **State:** Decision / input needed

**Depends on:** D01

**Input needed:** An authorised bank file, accepted REI import example/schema, reference map and ordinary plus ambiguous rows.

**Implementation:** Confirm actual CSV/XLSX parsing needs, amount/date conventions, reference field length, account identity and REI acceptance route. Store the original safely.

**Acceptance:** One documented input/output contract with all rows accounted for and an agreed way to verify destination totals.

**Recovery:** Unsupported format or missing REI evidence holds that format; never infer it from a screenshot.

**Source owners:** `server/import-inspect.ts`, `shared/rent-workflow.ts`

**Latest evidence:** Clip 1 describes CSV download; clip 2 shows bank-derived Excel narratives and REI Bulk Receipting. Obtain one de-identified export and its corresponding corrected/imported copy; do not ask Kevin to specify a technical schema.

#### D03 · Confirm bill cycles and reminder ownership

**Workstream:** Bills · **Owner:** Kevin + Danny + Yoda · **State:** Decision / input needed

**Depends on:** D01

**Input needed:** Examples of received and missing council/water/levy bills, recurring windows, staff responsibilities and payment follow-up rules.

**Implementation:** Create the seed register; record expected arrival separately from due date, partial evidence, issuer identity, advance/funding exceptions, quiet hours and escalation owner.

**Acceptance:** Kevin confirms the initial register and Danny confirms the review/escalation route. Unknown dates remain unknown.

**Recovery:** Disputed cycle or unknown payment evidence creates a review item, never an invented deadline or paid status.

**Source owners:** `server/desk-store.ts`, `shared/office.ts`

#### D04 · Choose the execution and account ownership model

**Workstream:** Setup · **Owner:** Yoda + Danny · **State:** Decision / input needed

**Depends on:** D01, W01

**Input needed:** Desktop operating hours, mobile channel, model/provider billing owner, Gmail consent owners and backup destination.

**Implementation:** Use Hermes + Cua on a suitable existing Windows 11 machine for the initial pilot. Confirm account/provider billing ownership, session/operating hours and mobile access. Hardware is optional; a Mac mini could host later CRM but cannot replace Windows applications. Defer another Codex engine until measured task reliability/cost or a customer need justifies it.

**Acceptance:** Written ownership, hours, costs and outage behavior; customer-facing setup contains no shared vendor project secret.

**Recovery:** If hosted access is not ready, scope a verified channel interaction and honest offline behavior before promising phone case access.

**Source owners:** `server/config.ts`, `server/composio.ts`, `server/channels/`, `electron/main.mjs`

#### W01 · Confirm Windows apps, architecture and one real workflow

**Workstream:** Windows · **Owner:** Kevin + Yoda · **State:** Decision / input needed

**Depends on:** D01

**Input needed:** Exact native applications/versions, website, Windows 11 version, CPU/app architecture, standard/elevated rights, display scaling, session setup and a representative authorised sample.

**Implementation:** Walk the current task with Kevin; record the website-to-native-app sequence, expected output and approval boundary. Match the test environment to Austin. ARM VM evidence is supplementary if Austin is x64.

**Acceptance:** Named app and workflow contract, architecture inventory and expected result agreed. Generic test apps do not count as customer workflow acceptance.

**Recovery:** Keep unknown apps/architecture as pending; do not assume Excel or buy hardware to resolve an unconfirmed requirement.

**Source owners:** `docs/AUSTIN-OPERATING-PLAN-2026-09-10.md`, `electron-builder.yml`

**Latest evidence:** Clip 1 at 17:30 visibly shows REI Cloud Member Login; clip 2 shows Excel, REI Bulk Receipting and a Windows desktop. Windows 11 appearance is an inference; exact CPU architecture, Excel version and any additional native apps remain unconfirmed.

### 02 · Preserve setup and agency identity

#### F01 · Bind one agency to one explicit engine identity

**Workstream:** Platform · **Owner:** Yoda · **State:** Build / extend

**Depends on:** D04

**Input needed:** Supported runtime/version policy and chosen isolation boundary.

**Implementation:** Make agency, data root, engine executable/version, profile/home, generation and credential owner explicit. Resolve Ask, status, OAuth and lifecycle through the same binding.

**Acceptance:** Wrong agency/binding is rejected; no personal-login fallback. Concurrent threads use a proved isolated-home policy or supported serialization.

**Recovery:** Missing/unsupported engine leaves retained records readable and presents one repair action.

**Source owners:** `server/contracts.ts`, `server/config.ts`, `server/harness/registry.ts`, `server/drivers/acp/`, `server/hermes-oauth.ts`

#### F02 · Preserve setup through engine changes

**Workstream:** Platform · **Owner:** Yoda · **State:** Build / extend

**Depends on:** F01

**Input needed:** Owned-file inventory, retained-state policy and supported engine versions.

**Implementation:** Persist enabled intent; stop unconditional pack reactivation. Drain active work and use a durable operation/generation before repair, update or uninstall. Remove only owned code; retain settings and data.

**Acceptance:** Off survives restart; update and remove/reinstall preserve setup; crash recovery, active jobs and stale/duplicate lifecycle requests are exercised.

**Recovery:** Reconcile unknown external outcomes before replay; restore a compatible snapshot when a schema change prevents binary rollback.

**Source owners:** `server/hermes-lifecycle.ts`, `server/hermes-pack.ts`, `server/index.ts`, `server/worker-bootstrap.ts`, `server/drivers/acp/core.ts`

#### F03 · Register reusable capabilities and scoped activation

**Workstream:** Platform · **Owner:** Yoda · **State:** Build / extend

**Depends on:** F01, F02, W06

**Input needed:** Small first-party PM/CRM contract and host compatibility policy.

**Implementation:** Add durable module registration, activation, permission/version checks and agency/module-scoped revocation. Reuse the existing broker and scheduler. Keep entitlement separate from action authority. Start with small first-party contracts after the demonstrated Windows slice; do not build a marketplace or another engine first.

**Acceptance:** A fake CRM can install/update/disable/remove/reinstall without changing PM data, jobs or permissions. Unknown modules remain retained and unavailable.

**Recovery:** Failed activation stays off with an actionable reason; an update requesting wider access cannot silently inherit it.

**Source owners:** `server/harness/registry.ts`, `server/connected-apps-broker.ts`, `server/connected-app-operations.ts`, `pack/property/`

#### F04 · Prove backup, key recovery and data retention

**Workstream:** Platform · **Owner:** Yoda · **State:** Verification still required

**Depends on:** F01, F02

**Input needed:** Approved backup destination, retention, recovery target and account ownership.

**Implementation:** Inventory encrypted/plain stores and key owners. Document backup/restore, exports, disconnect versus delete, and a safe recovery procedure without secrets in guides.

**Acceptance:** Restore synthetic agency records/configuration with the required key on an isolated installation; document what cannot be recovered and who owns that risk.

**Recovery:** Lost/corrupt key or backup must not overwrite retained records with an empty book. Keep evidence of the failed recovery.

**Source owners:** `server/desk-key.ts`, `server/desk-store.ts`, `server/store.ts`, `server/vault.ts`, `electron/main.mjs`

#### S01 · Provision connections before Kevin opens setup

**Workstream:** Setup · **Owner:** Yoda; account owners consent · **State:** Build / extend

**Depends on:** D04, F01

**Input needed:** Agreed provider, Composio account/project ownership, Gmail accounts and least-privilege consent.

**Implementation:** Separate technician provisioning from office consent. Store secret references at the owning boundary, bind the selected account and show verified capability/coverage instead of project IDs.

**Acceptance:** Kevin connects the correct office account without entering our project secret. Wrong account, revoked scope and interrupted OAuth stay unready.

**Recovery:** Resolve an unknown OAuth result before creating another connection; reconnect only the affected account and invalidate dependent checks.

**Source owners:** `src/components/GmailReadOnlySetup.tsx`, `src/components/ConnectedAppsCard.tsx`, `server/composio-gmail.ts`, `shared/office-sources.ts`

#### S02 · Persist a resumable outcome-based setup

**Workstream:** Setup · **Owner:** Yoda · **State:** Build / extend

**Depends on:** D01, S01

**Input needed:** The agreed office checklist and versioned workflow/account bindings.

**Implementation:** Use the existing setup sheet for Office → Sources → Rent sample → Bill cycles → Reminders → Handover. Persist non-secret progress server-side, preserve current drafts and show a single next action. Keep the initial office setup guided; the Phase 1 routine editor then uses approved templates and retained sample proof.

**Acceptance:** Reload/restart/cancel resumes at the correct step. A changed source, map or scope invalidates affected proof only; clicking a checkbox never makes access ready.

**Recovery:** Loading, partial, offline, stale and failed checks remain distinct; a failed step does not reset completed unrelated work.

**Source owners:** `src/components/WorkspaceSetup.tsx`, `src/lib/workspace-setup.ts`, `src/components/PmTaskStarters.tsx`, `shared/office.ts`

### 03 · Demonstrate one Windows workflow

#### W02 · Package the Windows Cua driver and SDK

**Workstream:** Windows · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W01, F01

**Input needed:** Supported, licensed Windows driver/SDK assets with the agreed architecture, version and digest.

**Implementation:** Extend staging beyond the macOS-only preparation script. Bundle Windows native resources outside ASAR and include them in package:win. Validate architecture/integrity and fail when required assets are missing.

**Acceptance:** Inspect the resulting installer contents and run the packaged Windows driver/SDK; no developer-installed dependency or macOS library fallback.

**Recovery:** Unavailable, incompatible or altered assets block the build/control capability with a useful error; preserve the prior working runtime.

**Source owners:** `scripts/prepare-cua.mjs`, `package.json`, `electron-builder.yml`, `electron/cua.mjs`

#### W03 · Wire Windows startup, permissions and bounded control

**Workstream:** Windows · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W02, F01

**Input needed:** Admitted Hermes/Cua contracts, user/session model, approved website and native-app identities.

**Implementation:** Replace the macOS-only Cua startup gate with a verified Windows path, transport and health checks. Scope browser origins and native app/window actions; wire approvals, Stop, human takeover and process cleanup without unrestricted fallback.

**Acceptance:** A packaged control session executes only the approved action on the intended surface. Denied/stale/wrong-app actions fail; Stop prevents queued actions and takeover revokes the agent lease.

**Recovery:** Handle crash, missing driver, login/session loss, UAC/secure desktop and unknown outcome explicitly. Human intervention is required where automation is unsupported; reconcile before retry.

**Source owners:** `electron/main.mjs`, `electron/cua.mjs`, `electron/cua-connection.cjs`, `server/cua-bounded.ts`, `server/hermes-hands.ts`, `server/attended-run.ts`

#### W04 · Build the exact intended Windows source through Actions

**Workstream:** Windows · **Owner:** Yoda · **State:** Verification still required

**Depends on:** W02, W03

**Input needed:** Reviewed release source including necessary local changes, lockfile, runtime pins and source manifest.

**Implementation:** Preserve unrelated work; prepare and push an isolated reviewed revision. Dispatch the existing active Package Windows workflow with its ref set to that full SHA. Inspect the actual checkout and download the artifact.

**Acceptance:** Record intended/actual SHA, run URL/ID, installer version/architecture, artifact identity and SHA-256. A stale main build is rejected as proof of the current work.

**Recovery:** Failed CI or missing assets stays open. Do not silently substitute another artifact or publish it; archive accepted candidates before the current 14-day retention expires.

**Source owners:** `.github/workflows/package-win.yml`, `package.json`, `pnpm-lock.yaml`, `electron-builder.yml`

#### W07 · Resolve Windows signing and customer update delivery

**Workstream:** Windows · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W04

**Input needed:** Signing identity/policy, artifact distribution owner and a customer-accessible update route.

**Implementation:** Resolve unsigned Windows packaging and the updater target that currently points at the private source repository. Keep source tokens off customer PCs; verify update metadata and the delivered replacement package.

**Acceptance:** Document expected installer trust behavior and verify update from the exact previous installer to a candidate without losing data. Customer release uses the agreed signing/distribution policy.

**Recovery:** Unsigned internal tests are labelled; blocked SmartScreen, inaccessible feed, wrong signature or failed update must not report success or delete the existing installation.

**Source owners:** `electron-builder.yml`, `electron/updater.mjs`, `.github/workflows/package-win.yml`

#### W05 · Verify the actual installer on matching Windows 11

**Workstream:** Windows · **Owner:** Yoda · **State:** Verification still required

**Depends on:** W04, W07, F02, F04, S01

**Input needed:** The downloaded installer digest and a clean interactive Windows 11 environment matching Austin’s CPU architecture.

**Implementation:** Exercise clean installation, Hermes setup, provider login, persistent data, close/reopen, OS restart, update/repair, browser/native control, approvals, Stop, takeover and failure recovery. Label ARM, emulated x64 and native x64 evidence separately.

**Acceptance:** Dated installer acceptance matrix tied to the exact artifact, OS/CPU/app versions and observable outcomes. If Austin is x64, an ARM VM or CI build alone cannot close the gate.

**Recovery:** Keep failed cases and diagnostics, retry only after a remedy and recheck affected paths for a rebuilt artifact. Preserve records on failed repair/update.

**Source owners:** `docs/AUSTIN-OPERATING-PLAN-2026-09-10.md`, `electron/main.mjs`, `electron/cua.mjs`, `server/worker-bootstrap.ts`

#### W06 · Demonstrate one Austin browser-and-native workflow

**Workstream:** Windows · **Owner:** Kevin + Yoda · **State:** Verification still required

**Depends on:** W05, D02, W01

**Input needed:** Confirmed Windows app/site, authorised sample, expected output and staff review boundary.

**Implementation:** Run one useful task through RealBud → Hermes → Cua across the website and named native app. Demonstrate ordinary and held/ambiguous outcomes, approval, Stop, takeover and a recoverable failure before broadening automation.

**Acceptance:** Kevin observes the correct application-owned result with recorded time, review, retries and attributable cost. This proves the selected slice, not the full future bank exporter or all Windows apps.

**Recovery:** If the selected task fails, narrow/fix that path and repeat. Defer additional engines, CRM expansion and hardware commitments until this demonstration passes.

**Source owners:** `docs/AUSTIN-OPERATING-PLAN-2026-09-10.md`, `server/drivers/acp/hermes.ts`, `electron/cua.mjs`

### 04 · Complete Phase 1

#### P01 · Create the bank batch and reference-review contract

**Workstream:** Bank · **Owner:** Yoda · **State:** Build / extend

**Depends on:** D02, F01, W06, P00

**Input needed:** Verified sample/schema and a versioned property/tenancy reference map.

**Implementation:** Parse deterministically into an immutable batch with original hash, account, row IDs, minor-unit totals, proposed reference edits and held reasons. Preserve leading zeros and date/money semantics.

**Acceptance:** Invalid formats, repeated/overlapping uploads, ambiguous matches, tenancy changes, splits and reversals are handled without dropped or duplicated money.

**Recovery:** Malformed input is rejected with a useful row/schema error; uncertain mapping stays held for Kevin.

**Source owners:** `server/import-inspect.ts`, `shared/rent-workflow.ts`, `server/desk-store.ts`

**Latest evidence:** The existing ledger importer rejects an illustrative bank transaction CSV (400, missing daysSinceDue). Build the separate bank-reference preparation contract; do not change bank fixtures into ledger snapshots to obtain a passing test.

#### P02 · Review changes and export the approved REI copy

**Workstream:** Bank · **Owner:** Yoda · **State:** Build / extend

**Depends on:** P01, F03

**Input needed:** Current batch, map revision and verified REI export rules.

**Implementation:** Add a Desk review showing old/new references, evidence, unchanged totals and held rows. Recheck approval/version at the server, then create a separate versioned export.

**Acceptance:** Stale or incomplete review cannot export. Every input row has a visible disposition; exported amounts/dates/totals match the original and accepted schema.

**Recovery:** Duplicate clicks return the same operation; changed data invalidates approval. A failed write leaves the original intact and no misleading finished result.

**Source owners:** `src/components/desk/`, `server/desk-store.ts`, `server/connected-app-operations.ts`

#### P03 · Close the loop on the actual REI import

**Workstream:** Bank · **Owner:** Kevin + Yoda · **State:** Verification still required

**Depends on:** P02

**Input needed:** Authorised test batch and a way to inspect REI import results.

**Implementation:** Record export identity, staff import action, accepted/rejected row counts, ledger totals and destination evidence. Keep exported, imported and reconciled separate.

**Acceptance:** Kevin verifies an ordinary and exception batch in REI, with no duplicate receipts or unexplained total difference.

**Recovery:** Partial/unknown import results are reconciled at REI before a retry. Keep unresolved rows open; do not assume an REI API.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`, `server/connected-app-operations.ts`

#### M01 · Add consented recurring Gmail intake

**Workstream:** Gmail · **Owner:** Yoda · **State:** Build / extend

**Depends on:** S01, F03

**Input needed:** Explicit recurring read permission, backfill window, account binding and run limits.

**Implementation:** Extend the bounded Ask-only path with permitted pagination, durable per-account checkpoints, deduplication, rate limits and scoped revocation. Keep source coverage visible.

**Acceptance:** Restart, partial pages, duplicate messages, expiry and outages cannot skip unseen mail or turn an incomplete check into no bill found.

**Recovery:** Advance checkpoints only for processed data; bounded retry/catch-up and a clear last-success/coverage range are retained.

**Source owners:** `server/composio-gmail.ts`, `server/connected-apps-broker.ts`, `server/routines.ts`, `server/routine-persistence.ts`

#### M02 · Read invoice evidence with attachment coverage

**Workstream:** Gmail · **Owner:** Yoda · **State:** Build / extend

**Depends on:** M01

**Input needed:** Agreed invoice formats, size limits and representative authorised examples.

**Implementation:** Fetch allowed attachments; validate file type/size, extract invoice fields with source provenance, preserve originals and quarantine unreadable or conflicting evidence. Treat all document text as untrusted.

**Acceptance:** Missing attachments, repeated forwarded invoices, revisions, extraction errors and conflicting totals stay visible for review; no model output alone confirms payment.

**Recovery:** Unreadable/encrypted/oversized files become a manual-evidence task. Failed extraction cannot silently mark the bill checked.

**Source owners:** `server/composio-gmail.ts`, `server/vault.ts`, `server/desk-store.ts`

#### B01 · Model recurring bills and individual occurrences

**Workstream:** Bills · **Owner:** Yoda · **State:** Build / extend

**Depends on:** D03, F01, W06

**Input needed:** Confirmed obligation register and source identity rules.

**Implementation:** Add obligation, occurrence, evidence and payment-evidence records with agency + obligation + period uniqueness. Project one case into Desk and Schedule.

**Acceptance:** Expected window, invoice due date, missing, received, arranged and verified paid remain distinct; duplicate occurrences and invoice revisions are controlled.

**Recovery:** Retired/changed obligations preserve history; cancelled/disputed cases need a reason. Unknown dates stay unknown.

**Source owners:** `server/desk-store.ts`, `shared/contracts.ts`, `src/components/desk/`

#### B02 · Turn bill evidence into reviewed exceptions

**Workstream:** Bills · **Owner:** Yoda · **State:** Build / extend

**Depends on:** B01, M02, F03

**Input needed:** Invoice evidence, source coverage and permitted review/payment evidence.

**Implementation:** Match bills to occurrences and expose missing, duplicate, amount/property conflict and funding/advance exceptions. Record a staff-authorised company advance/recovery follow-up where required; keep REI authoritative.

**Acceptance:** Ordinary, missing, amended, duplicate, disputed and advance-funded examples retain provenance and review history; arranged never auto-closes as paid.

**Recovery:** An inbox outage changes coverage confidence, not financial facts. Changed invoice evidence invalidates any affected approval.

**Source owners:** `server/desk-store.ts`, `server/connected-apps-broker.ts`, `src/components/desk/DeskCase.tsx`

#### B03 · Put the same bill cases in the existing calendar

**Workstream:** Bills · **Owner:** Yoda · **State:** Build / extend

**Depends on:** B01, B02

**Input needed:** Office timezone, expected windows, due dates and staff follow-up cadence.

**Implementation:** Extend the existing Schedule/WeekCalendar with bill occurrences and source/run freshness. Open the same case from Desk, Ask and Schedule; use clear text as well as colour.

**Acceptance:** All views show the current case revision; timezone/DST, overdue and missed-run examples remain accurate. Schedule completion never implies paid.

**Recovery:** Sleep/restart catches up without duplicate runs; expired source coverage remains visible on calendar items.

**Source owners:** `src/components/schedule/WeekCalendar.tsx`, `src/lib/schedule-week.ts`, `server/routines.ts`

#### A01 · Deliver alerts through a durable outbox

**Workstream:** Alerts · **Owner:** Yoda · **State:** Build / extend

**Depends on:** B02, F03, D03

**Input needed:** Agreed severity, owner, quiet hours, digest and escalation rules.

**Implementation:** Commit case changes and alert intent reliably; deduplicate/coalesce, revalidate recipient/current case, track provider outcomes and expose retry/failure states.

**Acceptance:** Repeated events do not spam; resolved/stale cases are not sent; accepted, acknowledged and resolved are separate. Failed/unknown delivery remains visible.

**Recovery:** Bound retries and reconcile unknown provider outcomes before replay; retain an office-visible delivery exception when exhausted.

**Source owners:** `server/channels/`, `server/remote-decisions.ts`, `server/routines.ts`, `server/desk-store.ts`

#### A02 · Verify the phone route and recipient authority

**Workstream:** Alerts · **Owner:** Yoda + Danny + Kevin · **State:** Verification still required

**Depends on:** A01, D04, A03

**Input needed:** One agreed channel, paired recipient and approved route to current case detail.

**Implementation:** Verify minimal lock-screen copy, delivery, actor binding and the case-opening/review route from an actual phone. Use authenticated reachable access or a proved bounded channel flow.

**Acceptance:** The intended person receives the test and can reach current case information; expired/wrong-person approvals fail safely. A localhost link does not pass.

**Recovery:** Lost phone, removed staff, revoked pairing or offline Windows workstation has a documented recovery and visible missed-check state.

**Source owners:** `server/channel-pairing.ts`, `server/channel-continuation.ts`, `server/remote-decisions.ts`, `src/lib/phone-connections.ts`

#### C01 · Implement attributable usage and budget behavior

**Workstream:** Commercial · **Owner:** Yoda · **State:** Build / extend

**Depends on:** D04, F03

**Input needed:** Billing owner, agreed budget, first billing period and written waiver terms.

**Implementation:** Reserve and settle chargeable work against a deduplicated usage ledger. Attribute connector/model costs; avoid billing customer-direct usage twice; separate entitlement, support and action permission. Keep API/provider billing separate from Hermes/Cua or any future engine. For customer-direct usage, do not charge the same calls again; apply the first-month excess benefit as a verified credit/reimbursement. Track eligible phase, billing period and currency.

**Acceptance:** Budget boundary, concurrent cost reservations, duplicate/late charges and restart are tested. First-month excess is absorbed once, never recovered later or reset on reconnect. Low usage is charged as actual usage, not the full budget; managed and customer-direct examples reconcile to one cost owner.

**Recovery:** Pause extra chargeable work at the ongoing limit and show coverage impact; handle delayed provider costs and disputes without hidden invoices.

**Source owners:** `server/connected-app-operations.ts`, `server/config.ts`, `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

#### P00 · Acquire the bank export on a reviewed recurring schedule

**Workstream:** Bank · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W06, U01, U02, D02

**Input needed:** Approved bank/account/download route, sample format, cadence semantics, timezone and coverage range.

**Implementation:** Download daily or at the agreed one-to-two-day interval through the owned Windows job stage. Verify a completed export, preserve its original and range, deduplicate overlapping data without discarding genuinely identical payments. Keep source coverage distinct from REI posting.

**Acceptance:** Late/repeated/overlapping exports, source identity, no-new-data vs failed check, partial files and MFA/manual-upload fallback are tested. The actual bank route is demonstrated; a manual upload does not prove automatic acquisition.

**Recovery:** Pause for login/MFA or unsupported steps; bounded re-download after verified failure. Unknown import outcomes require reconciliation; never repeat an external write blindly.

**Source owners:** `server/routines.ts`, `server/job-executor.ts`, `server/attended-run.ts`, `server/import-inspect.ts`, `shared/rent-workflow.ts`

#### U01 · Deliver a prepared workflow pack and Austin configuration

**Workstream:** Routines · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W06, S02

**Input needed:** Payment, daily inbox and expected-bill templates; selected sources, cadence, reviewer, limits and notification route.

**Implementation:** We configure first-party versioned payment, inbox and bill packs with typed steps, input/output contracts, prerequisite checks, retries, human handovers and acceptance fixtures. Keep agency accounts, cadence, references, reviewers and budgets separate. Rehearse and test before handover; Kevin connects accounts, confirms rules and accepts activation. Optional Ask edits produce the same reviewed draft, not a prerequisite for initial setup.

**Acceptance:** Install leaves routines off. Drafting never schedules. Changed source/action/schedule invalidates approval; stale save/activation is refused. Daily, selected weekdays and anchored two-day intervals are explicitly distinguished.

**Recovery:** Missing connections or sample proof leave the draft resumable and inactive; explain one next action. Stop/pause survives restart.

**Source owners:** `server/recipes.ts`, `server/recipe-draft.ts`, `server/schedule-intent.ts`, `src/components/schedule/JobWorkspace.tsx`, `src/components/WorkspaceSetup.tsx`

#### U02 · Resume routine steps with bounded recovery and no duplicate effects

**Workstream:** Routines · **Owner:** Yoda · **State:** Build / extend

**Depends on:** W06, F01, F04

**Input needed:** Versioned routine/run/stage contract; operation identity, coverage checkpoint, retry and time/cost ceilings.

**Implementation:** Persist stage progress and failure type. Proposed default: two automatic transient retries after the initial attempt, respecting provider delays and total limits. Diagnose only inside approved read scope; permission expansion or uncertain effects require human review. Release computer control while waiting. Persist the waiting checkpoint without an active model polling loop. Distinguish human waiting, approval, transient failure and uncertain dispatch; U03 supplies sign-in verification and handover.

**Acceptance:** Crash, missed slots, overlap, timeout with still-running work, exhausted budget, cancellation, Stop/takeover and unknown side effects preserve truthful outcomes and do not duplicate imports or approvals.

**Recovery:** Show what failed, what was tried and one next action. Keep safe unrelated work available; catch up missing source coverage rather than blindly replaying all missed runs.

**Source owners:** `server/routines.ts`, `server/routine-persistence.ts`, `server/job-runs.ts`, `server/job-executor.ts`, `server/attended-run.ts`

**Latest evidence:** Browser rehearsal confirms restart interruption and stale-approval refusal; no saved per-step resume yet. No duplicate conflicting approval was accepted in the two-client local test.

#### U03 · Pause for login or MFA and verify before continuing

**Workstream:** Routines · **Owner:** Yoda · **State:** Build / extend

**Depends on:** U02, S02, A03

**Input needed:** Named Windows apps and account bindings, prerequisite detectors, actor policy, capture/input controls, durable checkpoint and selected phone route.

**Implementation:** Implement the typed Needs you contract: quiesce owned calls and sensitive capture, persist a scoped intervention and notification intent, let the person sign in in the original app, then validate Continue and verify the correct account before one safe resume dispatch. Keep this in RealBud and the existing Hermes adapter.

**Acceptance:** Correct/incomplete/wrong-account login, MFA, duplicate cross-device Continue, stale scope, expiry, Stop during verification, crash/update and notification failure preserve the checkpoint and permission boundary. Prove no credential capture or active model polling during the handover. Verify the actual Windows installer and phone route.

**Recovery:** Failed access checks keep the same run waiting. Unknown prior effects require reconciliation; never replay blindly. Offline/busy host, unconfirmed control release or adapter incompatibility stays visibly paused. A fresh callback cannot revive stopped work.

**Source owners:** `docs/AUSTIN-HUMAN-HANDOFF-2026-09-10.md`, `shared/contracts.ts`, `server/job-runs.ts`, `server/attended-run.ts`, `server/turn-watchdog.ts`, `server/drivers/acp/hermes.ts`, `server/remote-decisions.ts`, `electron/cua.mjs`

**Latest evidence:** Scripted password fill is rejected by the real server, but the run settles partial. No durable awaiting-login state, account verification or Continue-to-resume implementation was found or demonstrated.

#### M03 · Organise the daily inbox into a single internal work list

**Workstream:** Gmail · **Owner:** Yoda · **State:** Build / extend

**Depends on:** M01, M02, U01, U02

**Input needed:** Agreed mailboxes, coverage window, read consent, task categories, ownership and evidenced due-date rules.

**Implementation:** Read daily and suggest internal payment/bill/maintenance/follow-up items linked to source threads and properties. Share evidence with bill cases; preserve Kevin’s edits, completion and dismissal. Labels/archive/delete/send require separate authority.

**Acceptance:** Repeat reads do not duplicate tasks; new replies update/reopen only with an explained material change. Unreadable attachments, multi-account threads, uncertain dates and partial coverage remain visible.

**Recovery:** Do not announce inbox clear after partial failure. Preserve checkpoints and human edits on retry/reconnect; hold ambiguous property/owner/date suggestions.

**Source owners:** `server/composio-gmail.ts`, `server/connected-apps-broker.ts`, `server/desk-store.ts`, `src/components/desk/DeskBook.tsx`

#### A03 · Resolve approvals once across desktop and mobile

**Workstream:** Approvals · **Owner:** Yoda · **State:** Build / extend

**Depends on:** A01, F01, U02

**Input needed:** Decision kinds/permissions, actor identity, current evidence/revision/expiry, reachable phone route and notification message IDs.

**Implementation:** Persist one authoritative decision plus outbox intents. Compare-and-set pending revision; use one operation ID for any resulting action. Broadcast desktop state; mark all mobile copies resolved and remove controls using durable delivery receipts. Retry UI delivery independently of the decision.

**Acceptance:** Simultaneous allow/deny, duplicate taps, wrong actor, expiry, changed evidence, restart and cleanup failure cannot execute twice. Actual Windows and phone views settle to the same record; stale buttons return the existing result.

**Recovery:** A failed card edit cannot undo a saved decision. Retry supported cleanup and show delivery issues; OS banners may remain but never grant stale authority. Offline-host replies wait or use an explicitly verified relay.

**Source owners:** `server/remote-decisions.ts`, `server/channels/telegram.ts`, `server/channels/discord.ts`, `server/channels/slack.ts`, `server/index.ts`, `src/lib/notify-desktop.ts`, `server/desk-store.ts`

### 05 · Prove and hand over

#### Q01 · Run the joined workflow and failure checks

**Workstream:** Release · **Owner:** Yoda · **State:** Verification still required

**Depends on:** S02, P03, B03, A02, C01, F04, P00, U01, U02, M03, A03, U03

**Input needed:** Integrated implementation, synthetic fixtures and authorised acceptance examples.

**Implementation:** Exercise the full bank/bill/setup paths and failure matrix. bind results to the exact working tree, fixtures and build. Prove recurring acquisition, daily inbox organisation and simultaneous desktop/mobile approval settlement, including the exact source checks recorded in the routines plan. Exercise every login/MFA human-handover case in U03, including privacy and uncertain-resume recovery.

**Acceptance:** Relevant tests/typecheck/build pass, and failure output is preserved. No feature is called ready solely from a screenshot or fixture result.

**Recovery:** Cover crash, cancellation, duplicate upload/approval, stale source, revoked consent, disk failure, corrupted persistence and unknown external result.

**Source owners:** `server/routines-recovery.test.ts`, `scripts/qa-first-install.mjs`, `scripts/qa-connected-apps.mjs`, `package.json`

**Latest evidence:** 2026-09-11: 181 focused tests, all five PM API suites and 50 browser checks passed. Fixed Stop classification, stale approval conflicts, a test-server restart timer and batched connected-app test fixture. See AUSTIN-REHEARSAL-2026-09-11.md. This is partial foundation proof, not completed bank/MFA/Windows acceptance.

#### Q02 · Verify the final Windows 11 release and operating recovery

**Workstream:** Release · **Owner:** Yoda · **State:** Verification still required

**Depends on:** Q01, W05, W07

**Input needed:** Signed supported package, matching Windows 11 test environment, operating-hours and backup plan.

**Implementation:** Rebuild the completed Phase 1 changes through the same exact-source Windows workflow. Verify the final installer on the customer architecture, repeat affected browser/native, approvals, Stop/takeover, restart/update and restore checks, and retain the exact artifact receipt. Verify a real sign-in/MFA pause, host handover and checkpoint continuation on the named app, plus the selected actual phone.

**Acceptance:** Installed-version receipt and repeatable clean-machine/recovery evidence. Source or browser success does not substitute for this.

**Recovery:** Wrong permissions, missing engine, expired account or offline state leaves work recoverable with one documented next action.

**Source owners:** `.github/workflows/package-win.yml`, `electron-builder.yml`, `electron/main.mjs`, `electron/cua.mjs`, `electron/updater.mjs`, `server/hermes-lifecycle.ts`

#### Q03 · Rehearse Austin’s working day and measure it

**Workstream:** Release · **Owner:** Kevin + Yoda; Danny reviews · **State:** Verification still required

**Depends on:** Q02

**Input needed:** Comparable real batches/bill cases, agreed sample size and success thresholds.

**Implementation:** Record active time, review, rework, false alerts, missed cases, waiting, runtime/cost and correct outcome before/after. Include failures and ongoing upkeep; no double counting.

**Acceptance:** Kevin completes routine and exception paths with acceptable correctness and review burden; Danny accepts the evidence and remaining limitations.

**Recovery:** Missed criteria keep the pilot in review. Record the defect/workaround and rerun affected samples; do not invent a saving percentage.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

#### Q04 · Complete handover, support and billing acceptance

**Workstream:** Commercial · **Owner:** Yoda + Danny + Kevin · **State:** Verification still required

**Depends on:** Q03

**Input needed:** Accepted results, named support/escalation owner and final written commercial scope.

**Implementation:** Deliver two training sessions, quick guide, source/phone recovery, backup/restore and incident runbooks. Agree change requests, support hours, billing start, waiver, export and cancellation/retention procedure.

**Acceptance:** Dated handover acceptance records installed version, accounts, scope, run cadence, known limits and owners. Subscription starts at accepted go-live only.

**Recovery:** If handover is incomplete, record obligations and remedy under agreed terms. Founder absence and urgent incidents have a named fallback.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`, `docs/REALBUD-GPT6-PRO-AUDIT-BRIEF-2026-09-10.md`

### 06 · Optional CRM

#### R01 · Scope the Twenty workspace and CRM offer

**Workstream:** CRM · **Owner:** Yoda + Danny + sales operator · **State:** Decision / input needed

**Depends on:** Q04

**Input needed:** Users/roles, sample workbook, required entities, hosting owner, edition and migration volume.

**Implementation:** Agree CRM acceptance, licence/vendor costs, migration cleanup, hosting/backup/support and separate price. Verify selected Twenty schema/API/version.

**Acceptance:** Signed scope/ownership/mapping and cost model before promising seamless CRM delivery; no assumed REI finance write authority.

**Recovery:** Unsupported edition/schema or incomplete data is a scoped decision with an estimate, not hidden setup work.

**Source owners:** `docs/REALBUD-HERMES-HARNESS-2026-09-10.md`

#### R02 · Build native CRM views and governed sync

**Workstream:** CRM · **Owner:** Yoda · **State:** Build / extend

**Depends on:** R01, F03

**Input needed:** Verified Twenty workspace, least-privilege API binding and mapped record identities.

**Implementation:** Register native record views and shared UI/Bud action handlers. Add bounded sync, cursors, conflict checks, deletion handling and operation reconciliation. Webhooks require agreed reachable ingress.

**Acceptance:** Wrong workspace/role, stale edits, duplicate/reordered events and uncertain writes cannot corrupt records. Disable/remove CRM leaves PM operational and Twenty data retained.

**Recovery:** Reconnect/reinstall resumes from retained state; do not resurrect deleted records or claim an upstream idempotency guarantee without proof.

**Source owners:** `server/connected-apps-broker.ts`, `server/connected-app-operations.ts`, `src/components/desk/`, `docs/REALBUD-HERMES-HARNESS-2026-09-10.md`

#### R03 · Migrate and accept the CRM with staff

**Workstream:** CRM · **Owner:** Yoda + Austin sales team · **State:** Verification still required

**Depends on:** R02

**Input needed:** Approved import, duplicate decisions, record counts and a staff training sample.

**Implementation:** Rehearse migration/rollback, verify counts and relationships, then test buyer/listing/follow-up work with actual roles. Keep outreach review and sending authority explicit.

**Acceptance:** Data totals/relationships and staff usability accepted; cost/support scope confirmed. Measure combined Bud + CRM work without double counting.

**Recovery:** Partial imports and conflicting edits are reconciled before retry; retain original workbook and reviewed mapping.

**Source owners:** `docs/REALBUD-HERMES-HARNESS-2026-09-10.md`

### 07 · Repeat for agencies

#### N01 · Prove the same release serves agency two

**Workstream:** Platform · **Owner:** Yoda · **State:** Verification still required

**Depends on:** Q04, F03, F04

**Input needed:** A separate synthetic agency and chosen deployment boundary.

**Implementation:** Configure the same artifacts with separate identity, credentials, mappings, data and module selections. Exercise update, restore and usage allocation independently.

**Acceptance:** No code fork, cross-agency record/credential access or invoice leakage; one agency’s module disable does not disrupt the other.

**Recovery:** A failed update or exhausted budget remains isolated. Shared hosting is withheld until tenant-aware authoritative controls pass.

**Source owners:** `server/config.ts`, `server/contracts.ts`, `server/connected-apps-broker.ts`, `docs/REALBUD-HERMES-HARNESS-2026-09-10.md`

#### N02 · Review enterprise operating requirements at the right scale

**Workstream:** Commercial · **Owner:** Yoda + relevant specialist · **State:** Decision / input needed

**Depends on:** N01

**Input needed:** Actual customer procurement needs, support load, volumes and deployment requirements.

**Implementation:** Revisit privacy/vendor terms, data retention, access reviews, incident ownership, recovery objectives and founder continuity. Cost hosted operations, additional roles and required enterprise controls.

**Acceptance:** Each necessary control has an owner, cadence, evidence and funded scope; defer unsupported certification, SSO or infrastructure promises.

**Recovery:** Vendor/contract changes trigger a scoped review; do not infer legal compliance from package metadata.

**Source owners:** `docs/REALBUD-GPT6-PRO-AUDIT-BRIEF-2026-09-10.md`

### Outside the initial offer

#### X01 · Arrears notices and sent-evidence filing

**Workstream:** Notices · **Owner:** Yoda + relevant Austin operator · **State:** Deferred · not included

**Depends on:** No earlier task

**Input needed:** REI notice examples, retrieval problem and authorised evidence storage.

**Implementation:** Scope evidence preparation/filing and staff review. REI already generates notices; legal judgment and sending remain with staff. Interview pointer: C1 06:07–07:01; C2 03:45–05:57

**Acceptance:** A reviewed notice can be traced to its original evidence without duplicate sending or inferred delivery.

**Recovery:** Remain outside current handover scope until selected, estimated and accepted. No automatic activation.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

#### X02 · Airbnb payout allocation

**Workstream:** Airbnb · **Owner:** Yoda + relevant Austin operator · **State:** Deferred · not included

**Depends on:** No earlier task

**Input needed:** Payout/booking exports, split rules, fees and destination checks.

**Implementation:** Validate allocation rules and an import/review route before including this in the offer. Interview pointer: C1 13:15–14:14

**Acceptance:** Same payout reconciles across bookings, fees and destination totals; uncertainty is held.

**Recovery:** Remain outside current handover scope until selected, estimated and accepted. No automatic activation.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

#### X03 · Maintenance and trade handoffs

**Workstream:** Maintenance · **Owner:** Yoda + relevant Austin operator · **State:** Deferred · not included

**Depends on:** No earlier task

**Input needed:** A PM walkthrough of ordinary, emergency, owner-approval and completion cases.

**Implementation:** Observe the real handoff and authority limits before designing automation or quoting it. Interview pointer: C1 10:55–12:51; high-level account only

**Acceptance:** PM confirms dispatch, emergency escalation, spend authority and close-out evidence; no unsupported savings estimate.

**Recovery:** Remain outside current handover scope until selected, estimated and accepted. No automatic activation.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

#### X04 · Outgoing inbox follow-up and mailbox changes

**Workstream:** Gmail · **Owner:** Yoda + relevant Austin operator · **State:** Deferred · not included

**Depends on:** No earlier task

**Input needed:** Selected mailbox-write/outreach scope, owner, recipients and reviewed action authority.

**Implementation:** Daily read-only inbox review and internal task organisation are included through M03. Sending replies, mailbox label changes, archive/delete and wider outreach remain separately scoped.

**Acceptance:** Read access and internal task organisation never silently authorise mailbox changes or outgoing messages.

**Recovery:** Remain outside current handover scope until selected, estimated and accepted. No automatic activation.

**Source owners:** `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`

## Acceptance gates

### G0 · Scope and feasibility agreed

Scope, representative samples, account/deployment ownership and commercial assumptions accepted. Any missing product work is named before taking payment.

Tasks: D01, D02, D03, D04, W01

### GW · One Windows workflow demonstrated

Exact-source installer, matching Windows 11 architecture, named native app plus website, correct result, approvals, Stop/takeover and failure recovery. ARM VM evidence does not replace x64 acceptance.

Tasks: W01, W02, W03, W04, W07, W05, W06

### G1 · Foundation preserves the office

Explicit agency/engine binding; preserved settings; module isolation; restored backup; resumable setup and least-privilege connection proof. Retain Hermes + Cua; additional Codex engine deferred.

Tasks: F01, F02, F03, F04, S01, S02

### G2 · Joined Phase 1 works

Verified REI outcome, reliable bill evidence, actual phone route and budget/recovery proof, using the joined product. Recurring downloads, approved routine activation, daily inbox task deduplication and cross-device single-decision recovery are demonstrated. Login/MFA handover, correct-account verification, stopped/stale continuation and restart recovery are demonstrated.

Tasks: P03, B03, A02, C01, Q01, P00, U01, U02, M03, A03, U03

### G3 · Austin accepts handover

Installed Windows 11 checks, comparable measurements, two trainings, support/restore guide and dated acceptance with known limits.

Tasks: Q02, Q03, Q04

### G4 · CRM is accepted separately

Agreed edition/workspace/migration/price, native governed actions and staff-accepted data/sync/recovery.

Tasks: R01, R02, R03

### G5 · Repeat without a code fork

Second-agency configuration and isolation demonstrated; operating obligations are owned and affordable.

Tasks: N01, N02

## Evidence boundary

Recorded prior checks: harness 153 passed / 9 files; workflow 44 passed, 1 failed / 4 files. These were not rerun by the documentation build. Existing tests do not prove proposed lifecycle behavior or Austin acceptance. Workflow diagrams are proposals grounded in draft interview evidence. Current source should be rechecked when implementation begins.
