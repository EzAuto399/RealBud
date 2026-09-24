# Two-device evidence gate wiring — 2026-09-22

Owned changes: `package.json`, `.github/workflows/ci.yml`, and this report. Both source files were already modified before this task; unrelated changes were preserved.

- Added `pnpm qa:two-device-evidence` → `node scripts/check-two-device-acceptance.mjs`.
- Added `pnpm test:two-device-evidence` → `node --test scripts/check-two-device-acceptance.test.mjs`.
- Added the Node contract tests to the normal `pnpm qa` chain after the existing Vitest command and before application e2e.
- Added one unconditional Node contract-test step to the existing macOS, Ubuntu and Windows CI matrix.
- Kept `pnpm test` as `vitest run`; neither QA nor the new CI step repeats Vitest.

## Verification

Node 24.19.0 parsed the package JSON and workflow YAML (`yaml` dependency). Exact assertions verified both alias targets, the unchanged `test` command, the normal QA chain, all three matrix OS values, and exactly one unconditional Node test step. Result: passed.

Actual alias execution passed on Node 24.19.0:

- `pnpm --silent qa:two-device-evidence --template macos-rehearsal` returned exit 0 and parseable JSON with one pairing.
- `pnpm --silent qa:two-device-evidence --template full-platform` returned exit 0 and parseable JSON with four pairings.
- Checking each generated, unrun receipt against its target returned exit 1 and `evidenceComplete: false` (302 and 1,212 missing-evidence issues respectively). The templates cannot pass as observations.
- Omitting the target when checking the macOS-only template retained the `full-platform` default and rejected the mismatch.
- From an unrelated disposable temporary directory, `node /Users/yoda/projects/RealBud/scripts/check-two-device-acceptance.mjs` generated identical JSON for both template targets and rejected both unrun receipts with identical JSON results. Contract loading does not depend on repository cwd.

Evidence: `alias-verification.json`, `unrun-*-alias.json` and `unrun-*-rejection.json` in this directory. The temporary working directory was removed. Root owns the single `pnpm test:two-device-evidence` run; it was not duplicated here.

No remote CI, application build, deployment or customer/device acceptance was performed. Wiring and CLI behavior do not prove Windows execution or physical two-device acceptance.
