# Broad local regression, 2026-09-23

- Runtime: Node 24.19.0 on macOS. Vitest uses the repository's serial-file configuration. PostgreSQL and native Hermes runtime opt-ins are absent/disabled.
- Every command has an isolated temporary HOME; tests use their own disposable fixtures. No user data, installed app, provider account, paid service or customer workflow is exercised.
- This is a **working-tree baseline**, not an immutable revision. The root agent is fixing `server/config.ts` and configuration-recovery tests while an independent agent changes onboarding. Changes may enter the test run midway. Post-freeze checks of those edits and their consumers are required separately.
- Toolchain exception: isolating HOME caused Corepack to bootstrap the pinned pnpm 10.33.0 archive from the npm registry before Vitest began. This external package-manager fetch is recorded in `vitest.log`; it is not a provider or customer call. Subsequent commands reuse that cached version.
- `scripts/qa-e2e.mjs` hardcodes five fixture ports (18880–18884), so setting an external `OMB_E2E_PORT` base would not affect it. The runner checks those ports before the battery; it does not stop an existing process.

Results are recorded incrementally in `run-summary.json`; full output is retained in each named `.log`. `vitest-report.json` is the original JSON reporter result, and `vitest-test-results.json` lists every reported test name, status and failure.
