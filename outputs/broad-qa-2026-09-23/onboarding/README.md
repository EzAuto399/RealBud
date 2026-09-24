# Onboarding restart regression — 2026-09-23

Result: source implementation and focused local checks pass. A rebuilt packaged
QA app still needs the same restart acceptance check; no package was built by
this packet, and no real accounts, worker, provider or paid services were used.

The former completion and resume flags were browser-origin localStorage values.
Changing the loopback service port therefore reopened welcome despite the saved
profile. The renderer now reads an explicit versioned setup stage from the local
service. The private receipt is bound to workspace identity and member key and
uses expected scope/revision, serialized writes and idempotent same-stage retry.
Completing rules is separate from entering recovery. Names and legacy unscoped
browser flags are not completion proof.

Owned files: `src/App.tsx`, `src/components/Onboarding.tsx`,
`src/lib/first-run.ts`, `src/lib/first-run.test.ts`, `shared/onboarding.ts`,
`server/onboarding.ts`, `server/onboarding.test.ts`,
`scripts/qa-onboarding-restart.mjs`. Root integrated the endpoint into
`server/index.ts` and its session requirement into `server/session-auth.ts`.

- `unit-tests.json`: 28 passed, 0 failed under Node v24.19.0; persistence,
  interrupted setup, revision conflicts, lost response, member/workspace
  isolation, async member change, malformed response and preserved corruption.
- `renderer-typecheck.log` and `server-typecheck.log`: both commands exit 0.
- `receipt.json`: final real Vite renderer + Node service run passes six
  scenarios across eight changed service/renderer origins; zero page errors.
  Includes fresh rules, interrupted restart, completed restart, restored
  contact, resumed sample exploration and protected-book recovery.
- `completed-390.png`: visually inspected completed sample Desk, 390×844;
  no horizontal overflow. Fictional sample data only.

Earlier unsuccessful harness receipts are retained: the first assumed a corrupt
book stayed at `desk.json`, but existing recovery correctly quarantines it; the
final assertion verifies the exact quarantined bytes. A later transient helper
syntax failed Node strip-only startup and was replaced with erasable fields.
Neither issue is present in the final passing receipt.

Re-run with Node 24:
`PLAYWRIGHT_MODULE=<installed-playwright/index.mjs> CHROME_EXECUTABLE=<Chrome>
node scripts/qa-onboarding-restart.mjs`.

Legacy QA runners that only seed `realbud.first-run-done` must explicitly
complete `/api/onboarding` in their disposable workspace or exercise welcome.
No automatic migration trusts that unscoped browser flag across members.
