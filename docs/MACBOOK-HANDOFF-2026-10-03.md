# MacBook handoff — 3 October 2026

Start here when continuing RealBud on the MacBook. This checkpoint integrates the current shared desktop checkout and its related website mailbox changes. It is a development checkpoint, not a customer release.

## Resume on the MacBook

1. In the existing RealBud checkout, inspect `git status --short`, then use `git pull --ff-only` on `main` when local work permits. Do not reset or overwrite local changes.
2. Use Node 24 and `pnpm install --frozen-lockfile`. Run `pnpm typecheck` before continuing.
3. If working on the website, update its separate `EzAuto399/RealBud-website` checkout too. Its source imports the desktop repository’s shared contracts; keep both checkouts current.
4. Read this checkpoint, then [current direction](GOAL-PROMPT.md) and [department configuration](DEPARTMENT-CONFIGURATION-2026-10-03.md).
5. Use the MacBook’s own approved office link. Git does not carry the Mac mini’s credentials, Keychain, browser cookies, enrolled review workspace, customer data or installed worker.

## Integrated product work

- **Office setup:** approved organization linking provisions model access and the managed app connection service automatically. In-memory connector configuration refreshes immediately. Personal source accounts still require their own OAuth consent; organization linking does not silently grant mailbox access.
- **Recovery and speed:** failed revocation remains durable before either relink flow; old installation grants cannot authorize a new link. Private config, vault, profile and binding problems fail before requesting replacement credentials. A fully downloaded, privately owned, catalog-matching worker candidate can be verified again without repeating its installer. Full integrity, sandbox and protocol verification still run before promotion.
- **Work and Schedule:** clearer typography and layout, grouped next actions, result-first review, persistent drafts, keyboard/focus behavior, mobile layouts, reminders, work/app context, saved views and bank/bill review. Setup shows the actual safe phase and a single Keep preparing action while drafting remains available.
- **Departments and workflows:** reusable Accounts/general-admin and Property Management/maintenance/inspection configuration, reviewed plan defaults/history, tenant and department boundaries, current workflow packs and W1–W3 simulations. Guided live rollout and agency-specific source bindings remain acceptance work.
- **Runtime and integrations:** sandbox cleanup corrections, worker 0.21.5 integration, browser readiness and QA fixture repairs, native helper/package checks, managed mailbox scope, Hermios/connector work and retained evidence/recovery tests.

## Current setup evidence

The packaged review app reached **Bud ready**, with all four setup checks and a real managed-model readiness call passing. Bud then completed a fictional Accounts/admin and Property Management simulation, separating missing evidence and human decisions. The response used the real managed model, not a mocked answer. No live mail, payment, dispatch or portal action occurred.

The managed app connection service was configured; Gmail reported `NOT_CONNECTED`. Account consent is still required. The existing office link was preserved. The reviewed app uses an isolated enrolled review workspace; `/Applications/RealBud.app` and the default private workspace were not replaced.

Onboarding CUA checks cover real source components with fictional server status: actual download/reverification labels, unchanged draft after Keep preparing, 390px width without horizontal overflow, truthful recovery guidance, four ready checks, and no automatic send when setup completes. Earlier double-click retry, focus, relink and recovery checks are retained separately.

Observed previous download/component stages took approximately 102–200 seconds; a complete candidate’s full verification took 4.4 seconds. The optimization is supported by regression tests proving installer invocation is skipped on an eligible retry. These observations are not a promised first-install time or a measured end-to-end speedup of the new retry path.

Opus 5.5 completed the department, Schedule and provisioning source reviews with xhigh requested. Review findings were addressed, including interrupted provisioning, withdrawal races, stale installation authority and local recovery handling. The UI Designer and UX Researcher skills informed the interaction changes; this was a heuristic/agent walkthrough, not user research with staff.

## Verification at this checkpoint

Final integrated test and package results are recorded below before push. Earlier runtime evidence is linked in the portable evidence index. Passing layers do not substitute for each other.

| Gate | Result |
| --- | --- |
| Complete desktop Vitest suite | 8,360 passed, 0 failed, 327 skipped; 547 passing / 31 skipped files; 550.24 seconds |
| Managed gateway | 368 passed; typecheck passed after correcting a test-only empty-array narrowing assertion |
| Related website | 359 passed, 2 skipped; TypeScript and targeted lint passed; pushed `4d0ab11` to `EzAuto399/RealBud-website/main` |
| Additional contracts | 55 passed / 4 Windows skips; release guards 6 passed; two-device evidence checker 27 passed (not actual two-device proof); 31 Electron modules checked |
| Build and package | Renderer/server typecheck and builds passed; macOS arm64 ad-hoc signature passed deep/strict verification; smoke passed renderer, service, shutdown and 69 bundled binary compatibility checks |

The final fresh enrolled launch is waiting for macOS Keychain access. A process sample confirms the main thread is waiting in `Security/SecItemCopyMatching`; computer control cannot operate SecurityAgent. The user must handle that OS prompt. No keychain reset, key export or protection bypass was attempted. The earlier package’s live ready/model simulation remains valid for that earlier build, not a claim of a completed final enrolled launch.

The [portable evidence index](evidence/2026-10-03-checkpoints.json) retains exact dated counts and hashes; [its README](evidence/README.md) explains local-only raw evidence. Source whitespace validation excludes the intentionally byte-preserved fictional ANZ CSV fixture’s trailing blank record.

## Release and pilot boundaries

A separately detached worker descendant can survive process-group Stop on macOS. The newer setup-removal path refuses when complete cleanup cannot be established, but that does not prove all descendants stopped. **Keep this a review build until native Stop is proven.** No reboot/supervisor workaround has been silently accepted.

The four originally interrupted scripts passed: desk-continuity, telegram-ask-ux, workspace-unification and austin-workflow. Austin used an actual disposable native work browser; no pretend-ready production switch was added. The previous broad runtime checkpoint recorded 8,191 passes and 315 skips, 273 workflow checks, plus packaged backup/restore/memory checks. Those are dated results on earlier source, not the final result for this handoff.

Live customer workflows, account OAuth, sends/payments/REI changes, physical two-device use, Windows acceptance, long-running unattended behavior and staff usability remain separately gated. No customer schedules were enabled. Ad-hoc local signatures are not notarized distribution approval.

Continue first with the native Stop release hold, then an attended Accounts-to-PM pilot using selected evidence and explicitly permitted accounts. Measure task completion, missing-evidence handling, approval accuracy and recovery before calling an agency ready to onboard.

## Evidence and local-only material

Reviewed, secret-free reports and receipts are deliberately committed. Generated `outputs/`, browser automation captures and machine-specific launch entries are ignored by default because they can contain credentials or private profiles. Historical reports may reference bulky local-only evidence; the portable evidence index identifies retained checkpoint material. Never force-add a whole output directory.

The Mac mini’s current review app and enrolled workspace remain local. Build a fresh MacBook review package with the repository’s documented package workflow; do not transfer enrollment files or reset the MacBook Keychain to make Chrome prompts disappear.
