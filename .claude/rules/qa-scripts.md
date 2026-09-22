---
paths:
  - "scripts/**"
---

# scripts/ conventions

- `qa-e2e.mjs` is the CI/local HTTP battery: five `e2e-*.mjs` suites (desk, pm-day, pm-exceptions, portal-jobs, walkthrough) on distinct `OMB_E2E_PORT`s, run from source with no build, no worker and no network; `--quick` runs two.
- `qa-*.mjs` renderers require `PLAYWRIGHT_MODULE` (optionally `CHROME_EXECUTABLE`) and write `receipt.json` plus screenshots into a dated `outputs/<topic>-<date>/` directory. A receipt records its proof layer and an explicit `limits` list; without limits it is not a receipt. `REALBUD_QA_RESOURCES` and `REALBUD_QA_EXECUTABLE` must be supplied together to run against a packaged app instead of source.
- Real-PostgreSQL scripts (`qa-company-*`, `qa-business-desktop`, `qa-department-*`) start a disposable cluster with `initdb`/`pg_ctl`; the fixture rejects Windows. `smoke-*-package.mjs` need a built package and use `OMB_SMOKE_TEST=1`. Round-trip QA refuses an existing `--out` directory so earlier evidence is never overwritten.
- `check-two-device-acceptance.mjs` is a read-only receipt gate bound to `docs/acceptance/two-device-v1.json`; it operates no device. Every synthetic identity is labelled `fictional-*`; fixtures and fictional providers are never customer evidence, and a skipped suite is never counted as passed.
- Do not start package builds or Postgres-backed suites while another session is building in this checkout; check running processes and recent `outputs/` first.
