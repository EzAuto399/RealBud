# Packaged Mac smoke — 22 September 2026

Layer: unsigned macOS arm64 package built from current source (`pnpm package:mac`, `release/RealBud-0.1.19.dmg`, 12:38 first build, 12:46 rebuild). Not signed, not notarized, not an installed-device or customer test.

## Runs

| Run | Bundle | Result |
| --- | --- | --- |
| `node scripts/smoke-mac-package.mjs` (12:40) | 12:38 build | renderer-ready with a healthy embedded service, then `Electron did not exit after its window closed` (`smoke-mac-package.mjs:164`) |
| `node scripts/smoke-mac-package.mjs` (13:00) | 12:46 rebuild | `OK: renderer, capabilities, embedded harness, and shutdown`, exit 0 |

## Cause and fix

Today's main-process work added the sign-in service host (`--service` mode with a `second-instance` handover) and the bounded recovery wait. With another RealBud instance already running on this Mac, the smoke process took part in that single-instance handling and stayed alive after its window closed. Fix in `electron/main.mjs`: smoke mode (`OMB_SMOKE_TEST=1`) no longer requests the single-instance lock or registers the `second-instance` handler; it owns its own disposable data directory and stops its own service before quitting, so the lock is irrelevant to it. The customer path is unchanged.

The fixing agent was interrupted by an API rate limit before writing this receipt; the rebuild it started (12:46) contains the fix, and the rerun above was made against that bundle.

## Also verified after the fix

`pnpm check:electron`: 21 modules ok. `pnpm exec vitest run electron/`: green (see the session's final counts in `docs/ONBOARDING-AND-SERVICE-RECOVERY-2026-09-22.md`).

## Limits

Sign-in start, keep-awake, the recovery wait page and the abandon path were not driven by this smoke; it proves startup, the preload bridge, the embedded service and clean shutdown only.
