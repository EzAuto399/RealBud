# Austin — consolidated delivery and operating plan

> Commercial update, 11 September 2026: see [the current commercial and workflow brief](AUSTIN-COMMERCIAL-AND-WORKFLOW-BRIEF-2026-09-11.md) for the Phase 2 quote, included extras and hardware allowances. The implementation report supersedes historical build-readiness observations below.

Revision 6 human handover: [sign in, verify and continue](AUSTIN-HUMAN-HANDOFF-2026-09-10.md) defines durable login/MFA waits, privacy, correct-account checks, shared notifications and safe checkpoint recovery. Deliver configured, tested workflow packs; Kevin consents and accepts them rather than engineering routines. No Hermes fork is planned.

Revision 5 workflow extension: [guided routines, daily bank/inbox work and shared approvals](AUSTIN-ROUTINES-AND-APPROVALS-2026-09-10.md). Daily inbox organisation is now Phase 1; mailbox changes and sending remain separately scoped. This controls conflicting earlier scope statements.

10 September 2026 · Revision 6 · Internal · Proposed commercial terms, no Windows readiness claim

## The current decision

Deliver RealBud for **Windows 11**, using **Hermes + Cua**, starting with one demonstrable customer workflow across a website and a named native Windows application. Keep engine replacement possible, but defer an additional Codex engine until measured reliability, total task cost or customer need justifies it. Hardware remains optional. Then complete recurring bank acquisition, daily inbox organisation, prepared workflow packs, verified sign-in handover, shared approvals and the scoped bank/bill workflows, obtain Austin's acceptance and separately scope Twenty CRM.

This is the controlling Austin delivery/commercial summary. The [engagement JSON](AUSTIN-ENGAGEMENT-2026-09-10.json) owns the price and decision data; the [task register](AUSTIN-DELIVERY-PLAN-2026-09-10.json) owns work, dependencies and acceptance evidence. The [rollout design](AUSTIN-ROLLOUT-DESIGN-2026-09-10.md) and [Hermes harness plan](REALBUD-HERMES-HARNESS-2026-09-10.md) retain the detailed contracts. Prior Mac-only scope and A$1,250/A$199 figures are superseded for this offer.

## What we verified in this pass

| Layer | Evidence | Meaning |
|---|---|---|
| Private build repository | `gh repo view` reports `EzAuto399/RealBud` private, default branch `main`. | Source distribution and customer update access must be designed separately. |
| Windows CI | GitHub API reports `Package Windows` active; `.github/workflows/package-win.yml` accepts a ref, checks it out on `windows-latest`, runs a frozen-lockfile install and `pnpm package:win`, and uploads installer/update artifacts. | A build route exists. This pass did not dispatch it or produce an installer. |
| Current Windows target | `electron-builder.yml` declares x64 NSIS/zip targets. | Target selection is source configuration, not Windows 11 x64 behavior proof. |
| Cua startup | `electron/main.mjs` starts Cua only on `darwin`; other platforms return `unsupported-platform`. | Windows computer control needs actual wiring. |
| Cua staging | `scripts/prepare-cua.mjs` rejects non-macOS hosts; resource rules are under `mac.extraResources`; `package:win` omits `build:cua`. | Adding a Windows installer alone does not bundle a functioning driver/SDK. |
| Hermes bootstrap | `server/worker-bootstrap.ts` includes a native PowerShell plan and durable setup handling. | Reuse it, but prove it from the installed Windows application and the admitted Hermes version. |
| Windows signing/update | Windows config has no signing configuration. The updater's declared GitHub repository is the private source repository, despite a comment describing a public feed. | Resolve signing, artifact access and update delivery; do not place a private repository token on customer PCs or call updates verified. |

Dated hashes and GitHub status are preserved in `proposal-v3/windows-source-evidence.json`. The working tree contains substantial local work. A HEAD SHA alone does not capture it. No product runtime code, live account, customer records or hardware was changed by this planning pass.

Current upstream documentation describes native Windows support in [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native/) and [Cua Driver](https://cua.ai/docs/reference/cua-driver/platform-support). This supports retaining the stack; it does not certify RealBud's admitted versions, packaging, permissions or Austin's applications. Cua's [interface contracts](https://cua.ai/docs/reference/cua-driver/contracts) distinguish runtime ownership and transport choices. Recheck those contracts against the exact pinned Windows assets before implementation.

## Stage 0 — one Windows workflow before expansion

Kevin supplies the application names/versions, actual sequence of actions, website, sample data and expected result. Danny confirms the permitted action/reviewer. Record Windows edition/build, CPU architecture, browser, installed app architecture, privilege level, screen scaling, display setup and remote-session constraints.

Use a representative bank-reference preparation workflow if the app walkthrough supports it: open an authorised sample from the website, inspect/prepare the reviewed file in the agreed Windows application and return a verified output for staff's REI handoff. The native application is **to confirm**; do not silently substitute Excel, Notepad or a browser page as customer acceptance. Generic test apps are useful engineering fixtures only.

Complete one ordinary case plus an ambiguous/held case. Show source evidence, request consequential approval, execute only the current approved action, verify application-owned output, then demonstrate Stop, human takeover and a failure/retry path. Rehearse with synthetic data first; only use authorised customer samples at acceptance. Save the exact versions, run receipt, observed result and remaining limitation.

Do not wait for a general marketplace, arbitrary plugin UI, a hosted CRM or another engine to prove this slice. Reuse the existing harness, broker and bounded-control patterns. The fuller module lifecycle remains in the platform backlog and must pass before claiming independently removable modules.

## Windows implementation ownership

- **Packaging:** add explicit Windows driver/SDK asset selection and integrity checks to the existing preparation path, stage native resources outside ASAR, verify architecture and licensing/redistribution, and fail a build if required control assets are absent. Do not reuse macOS dylibs, bundle paths or TCC permission logic on Windows.
- **Startup and transport:** resolve the packaged Windows executable and supported SDK/runtime transport, expose truthful health, handle spaces/Unicode in paths and run as the intended user. Bind agency, task, app/window and generation at the authoritative boundary. App titles alone are not sufficient identity.
- **Permissions and control:** keep browser-origin and native-app authorization explicit. Verify supported Windows integrity/session behavior. UAC/secure desktop, lock screen, disconnected sessions and elevation are human/unsupported boundaries unless a supported, tested route is deliberately introduced. Never bypass OS security or expand to unrestricted control as a fallback.
- **Stop and takeover:** Stop blocks new actions, revokes task authority and terminates/settles relevant work; stale queued actions cannot resume after takeover. Verify Windows child-process cleanup. Reconcile unknown external results before retrying; cancellation is not proof an action never happened.
- **Persistence and lifecycle:** install/login/restart/update/repair must preserve agency records, configuration and intended enabled state. Keep engine/module code removal separate from data erasure. Verify credentials/key recovery and unsupported-version behavior.
- **Release delivery:** agree signing and SmartScreen handling, customer-accessible artifacts and update metadata/feed. Private source-repository access must not become a customer credential. Keep any unsigned internal test explicitly labelled; it is not the customer-ready release gate.

## GitHub Actions build procedure — execute after Windows work is ready

1. Review the intended source set, including necessary current modified/untracked files and their dependencies. Preserve unrelated work and exclude secrets, recordings, local state and generated output. Prepare an isolated `codex/` release branch/worktree containing the required changes; do not blindly stage the entire dirty directory.
2. Run the relevant source checks and confirm the lockfile matches package changes. Record the reviewed file manifest, package/runtime/driver versions and full commit SHA. Push that exact revision to the private repository.
3. Dispatch the existing `Package Windows` workflow with its `ref` input set to the full reviewed SHA. Ensure the workflow definition used for dispatch also matches the intended changes. Do not rely on a moving branch name or an old run.
4. Inspect the completed run's actual checkout SHA, build output and artifact list. Record run ID/URL, artifact ID, target architecture, version and SHA-256 digest of the downloaded installer. The current artifact retention is 14 days; preserve accepted candidates and their proof before expiry.
5. Download and execute that exact installer in the matching Windows 11 environment. Attach the resulting acceptance evidence to the same build receipt. A green hosted runner or package smoke test does not close the desktop gate.
6. Only after acceptance publish/distribute the agreed customer release and verify its update route. Changing code or rebuilding invalidates the old artifact digest; rerun affected proof for the new artifact.

These are planned execution steps. No Windows workflow was dispatched in this proposal update because the identified Windows packaging/startup work is still open; building it unchanged would not demonstrate the requested behavior.

## Windows 11 acceptance matrix

| Check | Required result | Evidence to retain |
|---|---|---|
| Clean installation | Installs on a clean standard-user environment with the documented prerequisite/signing behavior; no developer checkout dependency | Windows build/architecture, installer digest, installation log |
| Hermes setup and login | Installs/adopts only the owned supported runtime; selects the correct provider/account; interrupted login recovers | Versions, binding, sanitized status and permission receipt |
| Persistence | Records, setup progress and valid account bindings survive close/reopen and OS restart | Before/after sample IDs and restart result |
| Browser control | Operates the agreed site and verifies the result within the approved origin/task scope | Action/approval receipt and application result |
| Native control | Operates the named customer app and verifies its actual saved/visible state | App/version/architecture, run receipt and result |
| Approval boundaries | Denied, stale, changed-scope and wrong-app actions do not execute | Negative-case receipts; original state remains intact |
| Stop and human takeover | No new or queued action proceeds after revocation; the human can recover/resume deliberately | Timed stop/takeover observation and process/task state |
| Failure recovery | App crash, network loss, missing assets, expired login, locked/disconnected session and uncertain result remain visible and recoverable | Failure classification, bounded retry/reconciliation outcome |
| Restart/update/repair | Exact replacement package and owned runtime repair preserve records/settings; update feed is reachable without a source token | Old/new package digests, migration/update/restore receipt |
| Customer-architecture proof | Windows 11 x64 evidence if Austin uses x64; ARM/emulated runs labelled separately | OS/CPU/app architecture and environment inventory |

An ARM VM on our Apple-silicon Mac can help development. It does not replace x64 Windows testing when the customer's computers are x64. A matching dedicated Windows test PC or suitable interactive x64 Windows 11 environment is the acceptance path. Do not assume a headless CI runner exercises the user's interactive desktop.

## Hardware and hosting decision

Use a suitable existing Windows machine for the first demonstration. Determine whether an attended shared workstation is practical or whether foreground input contention and operating hours justify a dedicated Windows device. Record sleep, lock, login and session requirements; do not promise unattended work merely because a machine is powered on.

A Mac mini is an optional Phase 2 CRM hosting choice only. It cannot run Austin's native Windows applications as a substitute. A Twenty hosting decision must account for uptime, backups, remote access, patching, restore and recurring support; compare managed hosting and existing infrastructure before buying anything. No hardware, VM/cloud hosting, Windows/app licence or Twenty subscription is included automatically in the Phase 1 fee.

## Commercial recommendation and cost ownership

Recommend **A$1,750 onboarding + A$299/month + actual attributable provider usage at cost**. Use A$75 as the initial proposed usage budget, then calibrate it from the demonstrated workload. All prices are AUD, GST additional where applicable. CRM and hardware/hosting remain separate. This is a proposed price, not an accepted commitment or a vendor market benchmark.

Onboarding is A$875 after scope and technical feasibility agreement and A$875 after accepted handover. It covers the agreed workstation/connections, mappings and bill register, sample verification, two one-hour training sessions and guide. Reusable Windows/product engineering is our investment, not an unlimited bespoke build hidden inside onboarding. Confirm named apps and scope before treating the quote as firm.

The A$299 base covers the agreed office workflow, standard product updates, workflow upkeep and one hour of product help each month. Product defects remain our responsibility. Extra training, additional formats/apps or custom work require a separate agreed scope. Use month-to-month billing; propose holding this rate for the first 12 months with any later change discussed in advance. Subscription starts only at accepted go-live. Do not promise unfunded 24/7 support.

### Provider usage and the first month

- **Managed billing (recommended initial route):** we pay approved provider costs and pass the actual attributable usage through once, itemised separately from the A$299 fee. No usage markup is assumed.
- **Customer-paid provider route:** Austin pays its provider directly; we charge the RealBud fee and only other separately agreed costs. Do not invoice the same model/tool usage again.
- API usage can avoid a separate AI subscription on the chosen route; it is not free and does not select or require another execution engine. Existing subscription/OAuth provider access is a separate choice, subject to provider terms.
- Record account, task, provider, model, period, currency conversion basis, applicable tax and attribution. Shared connector fixed fees require an agreed allocation. Correct duplicates/late invoices and show unknown cost instead of pretending zero. [Composio pricing](https://composio.dev/pricing) includes plan/usage and add-on considerations; do not reduce all costs to model tokens or assume today's free allowance covers the office.
- In the first billing month, absorb **all attributable Phase 1 usage above the agreed budget**, with no later recovery. For customer-direct billing, apply the equivalent credit or reimbursement against verified eligible charges. This benefit applies once to the original billing period, not again after reconnect/reinstall.
- Example: A$120 eligible usage against a A$75 budget means Austin's managed monthly bill is A$299 + A$75 = **A$374**, and we absorb **A$45**. With all onboarding invoiced that month, combined cost is **A$2,124**. At A$30 usage, the monthly total is A$329; unused budget is not charged.
- From month two, extra chargeable work pauses at the agreed app budget unless Austin approves more; show the coverage impact. Direct-provider costs outside RealBud are outside our control. Apply bounded task/retry/volume controls and a provider cap where available; do not advertise a guaranteed provider-account-wide spending cap we cannot enforce.

### Sensitivity — assumptions, not measured margins

Use A$80/hour loaded labour and A$45/month allocated operations as planning inputs. Usage at cost adds no contribution. Shared engineering, acquisition, tax treatment and wider overhead remain outside these examples.

| Monthly workload | Labour | Operations | Contribution from A$299 |
|---|---:|---:|---:|
| Lean: 0.5h help + 0.5h upkeep | A$80 | A$45 | A$174 / 58.2% |
| Base: 1h help + 0.5h upkeep | A$120 | A$45 | A$134 / 44.8% |
| Heavy: 3h help + 1h upkeep | A$320 | A$45 | −A$66 / −22.1% |

At 12 onboarding hours × A$80 × 1.2 contingency, cost is A$1,152 and contribution A$598 / 34.2%. At 16 hours on the same basis, cost is A$1,536 and contribution A$214 / 12.2%. Product engineering is additional investment. The example A$45 first-month waiver reduces that month's contribution. Referrals are upside; none are budgeted as guaranteed revenue.

This improves the cushion over the previous A$199 offer without disguising usage as profit. If measured recurring support or maintenance is persistently higher, fix the product/process or rescope the service before selling the same promise to more offices.

## Decision and operating log

| Decision | Owner | Status / next proof |
|---|---|---|
| Windows required; Hermes + Cua first | Yoda | Accepted direction; Windows RealBud wiring and acceptance open |
| Exact Windows apps and CPU architecture | Kevin / Danny | To confirm before fixing the workflow and test environment |
| First cross-website/native workflow | Kevin + Yoda | Select from real work, record inputs/expected output/approval boundary |
| Exact-source installer build | Yoda | Existing active CI verified; prepare reviewed local changes and Windows fixes first |
| Signing and update distribution | Yoda | Resolve private-feed access and Windows signing before customer release |
| A$1,750 / A$299 / actual usage | Yoda proposes; Danny accepts | Revised draft; scope and customer acceptance pending |
| Provider billing, budget and waiver | Yoda + Danny | Choose owner, attribution and settlement before go-live |
| Hardware | Danny + Yoda | Optional; decide only after demonstrated workflow and operating-hours evidence |
| Twenty CRM | Yoda + Danny / sales operator | Phase 2, separately scoped after Phase 1 acceptance |
| Additional Codex engine | Yoda | Deferred; revisit with measured successful-task reliability/cost or concrete customer need |

For each later execution entry record date, owner, task IDs, exact source/build/artifact, environment, attempted action, result, evidence, unresolved issue and next action. Keep current status separate from this append-only history. Never record keys, bank rows or mailbox bodies in operational logs.

## Delivery order and stopping conditions

Confirm apps/architecture and one workflow → implement Windows Cua staging/startup/authority → build the reviewed source through GitHub Actions → test the actual Windows 11 installer → demonstrate one browser/native workflow with Stop/takeover/recovery → finish the scoped bank/bill/calendar/usage paths → rehearse with Kevin → obtain handover acceptance → separately add CRM and repeat for agency two.

Do not expand the engine list or buy hardware to compensate for an unproven task path. A failed Windows gate stays open with a concrete remedy. Preserve the customer's records and original samples; staff financial decisions and verified REI outcomes remain required throughout.
