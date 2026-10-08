# RealBud admin workflow — end-to-end review

**Verdict: the proposed admin workflow is not production-ready end to end.** This review verifies source behavior, isolated local tests and a fictional interactive prototype. It does not establish a deployed operator console, live support authority, customer installation, real source access or customer acceptance.

**Later role refinement:** [FDE console and customer workspace](decisions/2026-10-08-fde-console-and-customer-workspace.md) records the owner's explicit FDE/client split and its newer local checks. The browser counts below refer to this earlier end-to-end review snapshot; the newer role-specific evidence is kept separately.

The original 18 browser checks established a useful first interaction path. They did not prove that the new interface was connected to the website, company host, desktop worker or scheduler. This pass checks those boundaries separately and tests recovery as well as the successful path.

## What connects today

| Journey segment | Actual implementation | Remaining boundary |
| --- | --- | --- |
| Operator → organization account | Existing `/admin` operator gate, invites, provisioning and billing-office directory | The proposed organization workspace and operational status projection are not implemented |
| Website → pack distribution | A customer billing owner can upload signed pack bytes for their own office; linked computers can request them | No operator-scoped publication/tuning route for the proposed admin UI; upload is not installation |
| Desktop → reviewed pack installation | Signature admission, previews, local import, version/history/recovery and schedule-off defaults exist | Installation result is local; the portal receives no pack receipt through current installation reporting |
| Installed work → preparation and schedule | Local plans, approvals, source checks and recurring loops exist | A pack-level accepted trial result is not supplied by the production readiness adapter; first-day “Try” is not a successful-run receipt |
| Desktop outcome → operator confirmation | Current installation reporting includes versions, worker readiness and model-key/provisioning status | It does not report the proposed received/installed/trial-verified/activated lifecycle |

**A computer being online, a pack being uploaded, or a schedule switch being enabled is insufficient evidence that the full workflow works.** Each stage needs its own authoritative result tied to the organization, target and configuration revision.

## Three connections required before release

1. **Organization and support authority.** Add the server-gated organization workspace and a support grant bound to the operator, organization, target, permitted operations and expiry. Validate revocation and expiry at execution. Keep customer identity and local service-administrator authority separate. The current remote command protocol admits only `morning-review` and `prepare-recipe`; it is not a remote settings protocol.
2. **Reviewed configuration and publication.** Add a dedicated operator path that prepares an exact organization-specific change, validates its expected revision and publishes it idempotently. Reuse desktop signature and local review. Website pack upload currently uses a non-atomic read/check/write; concurrent uploads must not silently replace the reviewed revision. Do not use a customer cookie or a browser-supplied company ID as operator authority.
3. **Computer receipts and observed results.** Add an authorized report for package receipt, local acceptance/rejection, installation, trial outcome, activation and the first scheduled outcome. Tie every result to an immutable revision and target. Persist delivery/retry state and reconcile lost responses. Until these reports exist, the portal must say “Awaiting confirmation,” not “Working.”

These are backend integration requirements. A redesigned sidebar or a successful prototype click cannot supply them.

## A real readiness defect found during review

The role-pack setup path checked only a workflow's `enabled` switch. A workflow could therefore finish setup while `available` was false or `nextRunAt` was null. The generic setup path already required all three facts.

The correction applies the same recurring-schedule condition to the role-pack frontend and server checklist: enabled, available, and a recorded next run. It changes the readiness display; it does not enable, disable or execute a workflow. A scheduled next run still does not prove a successful trial or a completed scheduled run.

Regression tests first reproduced the defect in both layers. The corrected state also gives a useful recovery action: an enabled workflow that is unavailable or has no next run shows **Review schedule**, rather than asking the user to switch it on again. All 60 focused tests and both desktop typechecks pass.

The website had a related status overclaim: its invite pipeline and accepted-invite page described the whole office as ready once account and AI provisioning succeeded. Those views now say **Account ready** and explicitly direct the owner to computer connection and workflow setup. This changes the copy, not provisioning, permissions or setup completion. The five existing operator-desk tests and website typecheck pass.

## Required interaction invariants

| Invariant | Passing behavior |
| --- | --- |
| Scope is stable | A draft, assistant proposal, receipt and pending action always belong to their original organization and computer; switching cannot carry them into another organization |
| Progress is durable | Navigating, closing a dialog or reloading preserves a saved draft and confirmed lifecycle results; restored browser state does not restore privileged authority |
| Review stays current | Editing a tested proposal invalidates that test; changed revisions require a fresh comparison; installation keeps the previous applied version until the new change is accepted |
| Outcomes are honest | Offline, failed, rejected, uncertain and unverified are separate states with an owner and a next action; a retry does not fabricate success or duplicate an external effect |
| Activation is controlled | Publication, installation, trial acceptance, recurring activation and the first scheduled result are distinct; pausing and resuming have explicit effects and receipts |

Production should revalidate an existing support grant on reload and resume it when the server confirms it is still valid. It should request customer approval only when the permitted scope, policy or expiry requires it. The offline prototype requires a new simulated approval after reload because it has no authoritative server. That limitation is not a recommendation to interrupt the real operator on every page refresh.

### Complete primary journey

1. Select the organization; confirm the owner, computer and current support scope. Complete missing setup prerequisites before publication.
2. Prepare a pack or a new revision. Inspect the reviewer, source scope, rules, proposed schedule and exact before/after changes. Test the proposed configuration at the appropriate evidence level.
3. Publish the reviewed revision. Track delivery separately from customer acceptance and installation. Surface rejection or incompatibility without replacing the working version.
4. Run a bounded trial on the target computer. Inspect its actual result and source coverage. A failed or interrupted trial stays incomplete and offers a specific recovery step.
5. Obtain separate activation authority, confirm the computer's schedule receipt, and observe the first scheduled result. Keep pause, activity and subsequent revision changes accessible.

### Recovery cases that must be accepted

| Case | Required result |
| --- | --- |
| Reload or leave mid-draft | The original draft and organization remain recoverable; no live action is implied |
| Grant revoked or expired | Further privileged changes stop; the draft survives; the already-confirmed state remains visible |
| Computer offline after publication | Publication remains recorded; delivery/installation stays pending; another organization's connectivity cannot change this evidence |
| Trial rejected, failed or incomplete | The exact reason is visible; retry/revision preserves prior evidence and cannot activate recurring work |
| Save/publish reply lost | The original operation is reconciled before retry; no second command is created merely because the UI timed out |

## Prototype corrections

The revised fictional interaction model now retains organization-specific drafts and confirmed rollout state across navigation and reload. Editing invalidates the example test; invalid names, times and empty rules stay incomplete. Customer preview cannot change support scope. Expired or restored support access blocks new operator changes until approval is validated.

Draft, published and applied revisions are separate. A rejected replacement leaves the applied version intact. Installing a replacement pauses recurring work and requires a new trial. Earlier trial and scheduled-result evidence cannot complete the new revision. Failed trials have repair/retry paths; activation can be declined or withdrawn; pause remains pending until a computer acknowledgment; a missed scheduled result stays unconfirmed until a new result arrives.

These controls simulate the missing backend decisions and reports. They do not execute the entered exception rule, run AI or access customer sources. The preview retains a bounded recent event history, not a production audit archive. If its storage is unavailable or exceeds the host limit, it keeps the current draft in the tab and displays a persistent unsaved warning instead of claiming that reload is safe.

## Verification evidence

All evidence is under `outputs/portal-e2e-review-2026-10-08/`. Synthetic data and simulated receipts are labelled; they are not customer evidence.

| Check | Result and scope | Evidence |
| --- | --- | --- |
| Two-office actual HTTP round trip | **44 passed / 0 failed / 0 skipped.** Real source servers, isolated office storage, import/export, authorization, conflict, bank review/export and restart checks. Zero model runs; no mailbox, bank login or live external action; no schedule activation | `http-roundtrip/qa-report.json` |
| Website contracts | **43 passed / 0 failed / 0 skipped.** Bounded website tests for invites, packs, installation, company identity and commands. Mocked storage/session/gateway or pure contracts; not a hosted database E2E test | `website-contract-tests.log` |
| Existing desktop foundation | **172 passed / 0 failed / 0 skipped** before the new regression fix. Eight focused test files cover signing, role packs, pack installation/upgrades, office linking and setup. These are not UI or installed-customer acceptance | `desktop-foundation-review.json` |
| Readiness regression | Before correction: **41 passed / 4 failed / 0 skipped**, with four intended failures demonstrating false completion. After correction: **60 passed / 0 failed / 0 skipped** across four files. UI and server typechecks both exit 0 | `schedule-readiness-before.log`, `schedule-readiness-after.log`, `schedule-readiness-typecheck-{ui,server}.log` |
| Website account-readiness copy | **5 passed / 0 failed / 0 skipped** for existing operator-desk behavior; website TypeScript check exits 0. User-visible copy now distinguishes account provisioning from office operation | `account-readiness-copy.log`, `website-typecheck.log` |
| Prototype adverse journeys | **18 passed / 0 failed / 0 skipped.** Actual sandboxed browser preview: drafts/reload, invalid input, expiry, read-only mode, failure/retry, revision isolation, rejection, activation withdrawal, pause, narrow layout and truthful storage failure. Zero runtime errors | `interaction-regression-results.json`, `interaction-regression.mjs` |
| Original prototype journey, adapted | **18 passed / 0 failed / 0 skipped.** Original assertions retained with updated draft label, settled scrolling and a 1080 × 1400 desktop viewport. Includes directory search, assistant proposal, conflict/retest, offline behavior, role boundaries, keyboard dialog dismissal and dark appearance; mobile remains 390 × 1100 | `interaction-legacy-results.json`, `interaction-legacy-regression.mjs` |

The prototype expiry test advances `Date.now` inside the sandboxed frame and lets its real timer and authorization check run; it is a bounded simulated-time test, not a 31-minute live session. The oversized-storage case injects fictional multibyte records and checks that unsaved state is reported. Screenshots `interaction-revision-two.png`, `interaction-failed-trial.png` and `interaction-mobile.png` were visually inspected. A separate read-only source review found no introduced defect in the six implementation/test/copy files; schedule mutation is confined to isolated test fixtures.

**Remaining preview verification limit:** the copied legacy sequence did not pass at its original 1080 × 1050 outer viewport: the automated Apply to draft click did not reach the handler. The same native interaction passed in the adverse suite at 1080 × 1080, and the complete legacy sequence passed at 1080 × 1400. The shorter-window sandbox click behavior remains unverified; the passing counts must not be represented as universal pointer/layout acceptance. Exact harness details are in `outputs/portal-e2e-review-2026-10-08/interaction-review-notes.md`.

The source/API checks do not close the three missing production connections above. A complete release acceptance run must use the actual new website routes and customer desktop against an isolated organization, exercise the entire receipt chain, and then be repeated with explicitly authorized customer sources and the supported installed platform.

## Source map

| Source | Why it matters |
| --- | --- |
| `website/lib/portal-auth.ts:79`; `website/app/admin/offices/directory.ts:4` | Existing operator gate and limited billing-backed directory |
| `website/app/api/account/packs/route.ts:15`; `:48`; `server/office-link.ts:264` | Customer-owner publication scope, non-atomic write and desktop download boundary |
| `shared/website-commands.ts:3`; `shared/service-admin.ts:1` | Preparation-only remote operations and separate local administrator authority |
| `website/app/api/installations/report/route.ts:21`; `server/index.ts:6089` | Current report fields and missing pack trial-acceptance observer |
| `src/lib/setup-sequence.ts`; `server/austin-pack.ts` | Corrected role-pack recurring-schedule readiness |

The [design proposal](PORTAL-UX-REVIEW-2026-10-08.md) remains the UI direction. The source readiness defect and early account-completion wording are corrected locally, and the fictional interaction flow now includes recovery. The complete operator-to-computer product remains unverified until its missing connections are built and exercised. No packaging, deployment or live customer activation was performed.
