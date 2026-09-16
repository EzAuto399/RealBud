# RealBud and upstream Hermes — 12 September 2026

## Product decision

Hermes supplies the agent engine: model interaction, planning, native tools, memory, reusable skills, delegation and ACP sessions. RealBud supplies the office experience, job authority, source access, approvals, schedule, verified results and recovery. Keep Hermes unmodified. RealBud is an individual product with its own profile and work state.

The implementation extends RealBud's existing adapter and official installer integration. It does not edit the user's Hermes checkout, install Hermes Desktop, replace the personal `hermes` launcher, or create a second messaging gateway or scheduler.

## What changed

- A private runtime selector resolves one executable per running RealBud process. Existing independent CLI installations remain usable through the adapter. A previously owned executable takes precedence over an unrelated executable on PATH.
- New runtime installs use an immutable upstream release commit and SHA-256-checked official installer scripts. The installer runs its documented stage protocol. The global PATH/launcher stage is omitted. Every attempt receives a fresh directory; a failed attempt is never updated through upstream `main`.
- One durable installer lock covers attempts, with child-process records to prevent overlap after a crash. Setup has a 30-minute total bound and cancellation; owned POSIX children get a forced-stop fallback after graceful cancellation. Failed attempts and previous runtimes are retained.
- Source verification requires the exact release commit and no modified tracked source files. Contribution-email metadata is reported separately because fresh official installations here modify it. The candidate must report the expected product/calendar version and complete an ACP protocol-v1 handshake without provider credentials.
- The runtime selection changes atomically only after verification. Existing workers continue with their selected executable until the app restarts. A verified first installation can become available immediately; registry instances resolve it without requiring terminal setup.
- Existing profile updates do not reapply defaults. Explicit profile Repair replaces RealBud-owned policy blocks while preserving other upstream configuration, model/auth files, memory and existing skills. Unreadable or duplicate policy configuration fails without replacing the file.
- Normal app startup initializes a missing profile only. Existing or incomplete profiles are kept for explicit Repair; startup still establishes the private root-auth boundary after legacy migration.
- Repair no longer invokes a forced installer against a shared or unsupported Hermes CLI. The generic engine setup route directs Hermes users to in-app setup. The developer profile helper also uses the preserving repair path and refuses source pinning.
- Hermes status/setup/model/update routes require the RealBud session. User-supplied URLs, branches and tags cannot select installer code.
- You → Bud → Agent updates shows the recommended release, checks the latest upstream release, prepares a supported update, supports stopping setup, and selects the previous runtime for the next app launch. Network errors leave the current agent untouched.

## Release policy and current versions

The rollback baseline is upstream 0.20.3 / `v2026.8.16.2`, commit `7339f5f160db5c96657a3bab60151227cc61f66c`. The recommended candidate is 0.21.0 / `v2026.8.31`, commit `29112bef099274229cadff79cdff7bf7b99c4b77`.

Upstream's latest stable release returned by GitHub during this review is `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`. It is **not promoted by this pass**. The update UI distinguishes available upstream code from a release checked with RealBud.

The compatibility manifest ships with RealBud today. Adding a supported Hermes release therefore requires a RealBud compatibility update; the engine itself is installed separately. A separately signed remote compatibility feed is a future option, not an implemented claim. Never substitute an unsigned remotely supplied executable URL or automatically track `main`.

Upstream documents that ordinary [`hermes update`](https://hermes-agent.nousresearch.com/docs/getting-started/updating) follows `main`, updates dependencies/configuration and may restart other profiles/services or rebuild Hermes Desktop. That command is appropriate for an independently managed Hermes installation; it is not the in-app updater RealBud runs on a user's shared checkout.

## Native capabilities and the trust boundary

Live testing found that `HERMES_ACP_SKIP_CONFIGURED_MCP` and a CLI toolset selector alone do **not** prevent configured MCP discovery from restarting during session creation in the tested upstream builds. A synthetic configured server was contacted five times. Those failing logs are retained.

RealBud now uses upstream's `HERMES_SAFE_MODE=1` execution setting. This suppresses configured MCP, automatic plugin discovery, shell hooks and outbound webhooks. ACP's explicitly attached MCP servers still register. RealBud therefore controls which computer/connected-app tools are attached to a job without patching Hermes.

This is a deliberate extension boundary. It does not mean every upstream plugin is automatically available in RealBud. Provider/plugin combinations beyond the tested model still need validation. Future approved extensions should be attached through RealBud's existing authority mechanism or a separately reviewed native-extension flow.

Native learning remains functional. A real model in a disposable private profile:

1. Used the memory tool to save a fresh synthetic fact.
2. Recalled it in a fresh ACP process without replaying the previous transcript.
3. Used native skill management to create a reusable synthetic skill.
4. Loaded that skill in another fresh ACP process and recovered its exact marker.

Credentials for this test were used only in a private OS temporary folder and removed afterwards. No credentials were saved into this repository or its evidence folder. The user's own memory and skills were not used for the synthetic learning test.

## Verification and limits

Evidence folder: `outputs/realbud-hermes-upstream-2026-09-12/`.

- `trial-install*.log`, `trial-install.json`: real official upstream installation in an isolated folder, including the initial integrity/retry failures and successful fresh attempt.
- `live-021-contract-safe-mode.log`: real provider ping, plan drafting, rehearsal, exact approval, computed receipt, duplicate protection, file reading, quote arithmetic, complete saved output, warm follow-up and fresh-process transcript recovery.
- `live-021-isolation-safe-mode.log`: zero configured-server calls; explicit same-name MCP initialize/tools-list succeeded; no inference or tool execution in this isolated protocol test.
- `native-learning.json`: all four native memory/skill persistence checks passed.
- `update-ui.log`: 18 built-UI checks passed, including fresh onboarding, offline update check/retry, unsupported-release disclosure, setup cancellation/retry, restart notice, previous selection and narrow layouts. Installer responses were fixtures in this UI suite.
- `final-clean-tests.log`: all 190 test files passed, with 1,993 tests passed and eight skipped. The subsequent lock review moved selection into the installer transaction and put rollback under the same lock; `final-lock-tests.log` passed all 133 tests across six affected suites. `final-adapter-tests.log` passed 41 adapter tests after the final setup-message edit.
- `package-build-final.log`: application and server type checks, production UI/server builds and bundled app updater passed.
- `final-startup-tests.log`: 95 tests passed across five affected suites after removing the legacy automatic profile rewrite on app startup. Existing incomplete profiles remain held for Repair.
- `startup-config-review.json`: the first installed-app pass detected a configuration rewrite. Reconstructing the previous startup output matched the original hash and showed identical setting lines; the differences were comments/formatting. The original file was restored exactly before final activation.
- `installed-staged.json`, `installed-staged-integrity.json`: native in-app download completed using the official installer in about 129 seconds. Exact 0.21.0 release source and ACP verification passed. All 500 checked profile/work-state hashes matched the pre-update snapshot; the personal Hermes commit and launcher were unchanged. The running process remained on 0.20.3 while 0.21.0 was selected for restart.
- `final-all-tests.log`: the complete suite on the final source passed all 190 test files: **1,997 passed, eight skipped**.
- `package-sign-preserving.log`, `signature-verification-final.log`, `package-smoke-final.log`: final Developer ID build passed strict signature validation and the packaged renderer, capabilities, embedded server and shutdown smoke test. It is installed at `/Applications/RealBud.app`; public release notarization/upload was not performed.
- `installed-activated.json`, `installed-model-proof.json`: the installed app activated the private 0.21.0 runtime, retained the DeepSeek model connection, passed an explicit private readiness check and answered a fresh synthetic Ask request. The native typing helper omitted the multiplication character; Bud disclosed its interpretation of `27 19` and returned 513. This is connection/response proof, not a blind arithmetic benchmark.
- `native-bundled-skills-update.json`: Hermes refreshed its own bundled skills during activation. All 24 changed/relocated original skill files matched the old upstream source; every remaining changed file matched the new upstream source. Three files were relocated, and 26 paths were added, including native skill metadata. RealBud did not replace learned skills or apply pack defaults during this activation.
- `rollback-staged.json`, `rollback-active.json`, `installed-final.json`: the native previous-agent control kept 0.21.0 active until restart, activated 0.20.3 successfully, passed another explicit real-model readiness check, then restored the already-downloaded 0.21.0 without reinstalling. A final readiness check passed. The app is left on 0.21.0 with no restart pending.
- `final-integrity.json`: final model/config/auth/SOUL/memory hashes and office book, recipes, loops, run records and imported packs match the pre-update snapshot. The synthetic Ask turn added its normal conversation metadata. The separate Hermes commit and launcher remain unchanged, and all 180 installed server files match the final build.
- Automated test/build logs, focused before-images and final change manifest accompany this report. Tests cover invalid metadata/selection, exact version, failures, cancellation, duplicate setup, stale selection, custom CLI ownership, profile preservation and HTTP session enforcement.

Fresh installation was exercised on this development Mac with a private folder. That does not prove installation on a machine with no development tools. Windows commands and UI have automated coverage; clean Windows installation, signing, native computer control and customer acceptance remain unverified here.

Users still need an initial download/connection, their own model login and the OS permissions required by their chosen tasks. The previous selection restores an executable, not an old copy of office data: it must not overwrite newer jobs, credentials or profile records. Validate profile-format compatibility when promoting a release. Failed/old runtime directories remain available for diagnosis and consume disk space; automatic pruning is not implemented.

This work does not close the workflow accuracy, Bills-board application, Prepare cancellation or raw computer-broker gaps listed in `REALBUD-PACK-LIVE-QA-2026-09-12.md`.
