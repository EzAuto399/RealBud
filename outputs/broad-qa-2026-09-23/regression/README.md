# Broad local regression — 23 September 2026

**After the targeted startup rerun: 5,536 passed, 0 failed, 252 skipped across 415 Vitest files.** This combines the initial working-tree run with replacement results for four files affected by a startup integration error. It is not a fresh full run of an immutable revision.

| Check | Result | Evidence |
| --- | --- | --- |
| Initial full `pnpm test` | 5,451 passed; 0 failed assertions; 337 skipped; 4 files / 5 hook suites failed at startup | `vitest.log`, `vitest-report.json` |
| Four affected files after startup fix | 121 passed; 0 failed; 0 skipped | `startup-rerun.log`, `startup-rerun-report.json` |
| Amended full selection | 5,536 passed; 0 failed; 252 skipped; 5,788 total | `amended-summary.json`, `amended-test-results.json` |
| Electron syntax | 23 modules passed; 0 failed | `electron-syntax.log` |
| Two-device receipt checker tests | 27 passed; 0 failed/skipped | `two-device-evidence.log` |
| macOS release guard tests | 6 passed; 0 failed/skipped | `release-guards.log` |
| Five fixture HTTP suites | 245 checks passed; 0 failed/skipped | `qa-e2e.log`, `qa-e2e-checks.json` |

The fixture HTTP battery passed Desk (26), PM day (34), PM exceptions (62), portal jobs (87), and walkthrough (36). The 245 check count excludes the battery runner's five duplicate suite-completion lines.

## Initial integration failure and targeted repair proof

`server/index.ts` constructed the onboarding handler before `workspaceIdentity` initialized. All five failed hooks reported `ReferenceError: Cannot access 'workspaceIdentity' before initialization`. This was a real startup integration error in code landing during the run, not a stale test expectation.

The root agent moved onboarding creation after workspace identity initialization. Only these four affected files were rerun:

1. `server/attended-run.test.ts` — 48 passed.
2. `server/index.test.ts` — 52 passed.
3. `server/hermes-memory-approval-http.test.ts` — 18 passed.
4. `server/branching.test.ts` — 3 passed.

The initial run already passed 36 pure attended-run cases; 85 cases were blocked by startup hooks. Amended counts replace all results from these four files, so they do not double count those 36 passes. The original failures are retained unchanged in the original log/report. `startup-rerun-metadata.json` records hashes of the entrypoint, configuration module and rerun test files at rerun start.

## Scope and limits

Node **24.19.0**, macOS, repository serial-file Vitest configuration. Every command used a temporary HOME and disposable test fixtures. No package was built, no installed desktop was operated, and no live customer/provider workflow was exercised. PostgreSQL and native Hermes opt-ins were disabled/absent. The 252 remaining skipped test names and their 30 containing files are listed in `skipped-tests.json` and `skipped-files.json`; skipped checks are not passes.

The root agent changed configuration recovery and another agent changed onboarding during this working-tree baseline. Their post-freeze checks remain separate evidence. The receipt checker tests prove checker behavior, not real two-device acceptance; release guard tests prove guard behavior, not signing/notarization or release success. Windows native execution, installed-device behavior and customer acceptance remain unverified by this packet.

An isolated HOME triggered one Corepack download of the pinned pnpm 10.33.0 archive from the npm registry before the initial run. This was an external toolchain fetch, not a customer/provider call. It remains recorded in `vitest.log`. The targeted rerun and saved runner now use the existing Corepack cache with networking disabled.

No product source was changed by this QA execution packet. No unresolved regression or proposed source fix remains from these checks. Next: read `amended-summary.json`, then combine it with the separate post-freeze configuration/onboarding checks.
