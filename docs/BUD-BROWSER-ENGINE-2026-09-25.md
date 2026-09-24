# Bud browser engine candidate — 25 September 2026

**Decision:** Keep the pinned native `agent-browser` transport as dormant host-side source for Bud. RealBud owns the visible app and browser task flow. No Hermes window, Hermes.app, worker browser tool, or vendor-branded UI is introduced by this change. The existing browser broker remains the authority for task grants, account scope, approvals, and Stop.

The candidate lives in `server/hermes-browser-transport.ts`. It admits an exact staged binary by manifest and SHA-256, attaches only to a host-supplied local browser endpoint, uses an isolated private control directory, allows a small typed command set, and holds uncertain effects for recovery. `scripts/prepare-hermes-browser.mjs` describes a pinned build-time bundle; it is **not** called by the current package scripts. The fixture observation helper and native QA script are available for later integration checks. None of these files is imported by the current product runtime.

## Verification for this source addition

- `pnpm exec vitest run server/hermes-browser-transport.test.ts`: 27 passed.
- `node --test scripts/testing/hermes-browser-observation.test.mjs`: 4 passed.
- `pnpm exec tsc -p tsconfig.server.json`: passed.

These checks use disposable fixtures and a fake executor. The native QA script was not run: this change did not download or stage the binary, launch a browser, or change packaging. The checks establish the source contract, not a packaged app, installed device, signed-in session, broker connection, or customer workflow.

## Before runtime adoption

Keep all browser actions behind the existing broker and its selected-session, approval, Stop, and recovery controls. Admit the packaged executable with `admitHermesEngine` before constructing a transport; never resolve a binary from PATH or download one at runtime. Verify bundle licensing and package integration, the native fixture QA on each target platform, no extra browser or Hermes.app window, and Bud-only visible copy before switching any production route. A command already dispatched when Stop occurs may finish; the broker must surface that uncertainty and require review before another action.
