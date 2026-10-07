# Runtime upgrades, 8 Oct (Packet U)

Branch `claude/runtime-upgrades`, base `0bcf9164`, macOS 27 arm64, Node 24.21.0, pnpm 10.33.0.
Evidence tier: source + local tests + packaged build (unsigned, ad-hoc sealed) on this Mac. No Windows run.

## Baseline (lockfile as committed)
- `pnpm install --frozen-lockfile`; `pnpm typecheck` pass; `pnpm exec tsc -p tsconfig.server.json` pass; `pnpm check:electron` 33/33 ok.
- pnpm 10 did not run Electron's postinstall in this worktree, so `node node_modules/electron/install.js` was run by hand after each Electron install.

## 1. pg 8.23.0 -> 8.23.1 (kept)
- `pnpm install`: pg 8.23.1, pg-connection-string 2.14.1, pg-protocol 1.16.1, pg-cloudflare 1.4.1.
- typecheck pass; server tsc pass; check:electron 33/33.
- `pnpm exec vitest run server/company-host.test.ts server/company-installation.test.ts server/company/member-credentials.test.ts server/company/host-runtime.test.ts server/company/postgres-runtime.test.ts`: 4 files passed, 1 skipped (postgres-runtime is gated on REALBUD_TEST_POSTGRES; skipped is not a pass); 44 passed, 8 skipped.
- Postgres integration suites not run (packet: no Postgres-backed suites).

## 2. react / react-dom 19.2.8 -> 19.3.0 (kept)
- package.json ranges `^19.1.0` -> `^19.3.0`. @types/react and @types/react-dom are caret ranges, not pins, so left as locked (19.2.18 / 19.2.4).
- typecheck pass; server tsc pass; check:electron 33/33.
- `pnpm exec vitest run src`: 176 files, 1700 tests passed.

## 3. electron 43.7.5 -> 44.6.0 (kept, one-line fix)
- Electron 44 embeds Node 24.21.0 (same major the QA scripts assert), Chrome 152; Electron Framework minos 13.0 = our `minimumSystemVersion`.
- 44.0 breaking changes checked against source: `clipboard` methods now return promises -> `electron/main.mjs` engine:open-terminal now awaits `clipboard.writeText`. `openAsHidden` login-item attribute removed: we still pass it; it was a pre-macOS-13 no-op and our minimum is 13.0. Renderer clipboard, subframe workers, ia32, macOS 12, select-client-certificate, net.request frames: not used.
- Sync `safeStorage.encryptString/decryptString/isEncryptionAvailable` (used by `electron/desk-key-custody.mjs`) are still present in 44.6.0; deprecated in 45 and removed in 46.
- typecheck pass; server tsc pass; check:electron 33/33; `pnpm exec vitest run electron`: 27 files passed, 1 skipped (Windows-only launcher tests); 387 passed, 16 skipped.

## 4. @trycua/cua-driver 0.19.3 -> 0.34.0 (not applied)
- Full release notes 0.20.0 to 0.34.0: `cua-driver-0.20.0-0.34.0-release-notes.md`.
- SDK JS surface is additive (no removed exports; `CuaDriver.connect`, `callTool`, `EmbeddedCuaDriverHost`, electron helpers unchanged; same @ubjs 0.31.0-3).
- The pinned daemon binary changes click and AX targeting: macOS click delivery (0.25.0 #2907), element tokens resolved against a snapshot store invalidated on read (0.31.0 #3873), budgeted get_window_state walks (0.28.3 #3882), sheet elements resolved to the parent window and constrained element_token schemas (0.33.0 #4507, #4318), AX-less helper windows dropped from list_windows (0.33.1 #4534), focus verification before input and browser approval tokens removed (0.20.0 #3068, #3185). Packet rule: behaviour change in click or AX targeting means revert.
- Also not mechanical: new checksums in `scripts/prepare-cua.mjs` (mac + Windows), new PyPI wheel URLs and hashes in `server/container-computer.ts`, `CUA_PIN` in `server/cua-bounded.ts`, and `electron/cua-login-check.mjs` relies on 0.19.3's observed semantic_v2 shape for the account-binding check.

## 5. Packaged check (pg + react + electron 44)
- `pgrep -fl "[v]itest.mjs run|[e]lectron-builder"`: nothing running at build time.
- `REALBUD_POSTGRES_CACHE_DIR=<main checkout>/.postgres-cache pnpm package:prepare && pnpm build:speech && pnpm build:cua && pnpm build:postgres && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --arm64 --publish never` -> `release/mac-arm64/RealBud.app` (electron=44.6.0). Browser and CUA 0.19.3 caches copied into the worktree; nothing written to the shared checkout.
- Same ad-hoc seal as `package:mac:qa`: `codesign --force --deep --sign -`, `node scripts/seal-mac-browser.mjs`, `codesign --verify --deep --strict` OK. No Developer ID signing, no notarization, no dmg/zip, no publish.
- Isolated launch (mkdtemp scratch HOME, HERMES_HOME, REALBUD_DATA_DIR, REALBUD_LOG_DIR, OMB_USER_DATA, `--user-data-dir=<scratch>`, `--use-mock-keychain`, API-key env stripped): `packaged-health.json`. Our service (instanceId matches the scratch data dir) answered on 8799 with `version: "0.1.36"` = package.json. App quit by SIGTERM; service stopped through the authenticated stop route.
- Same isolation with the app's own `OMB_SMOKE_TEST=1` hook: `packaged-smoke.json`. Renderer title RealBud, preload bridge, local session, company status, health version 0.1.36; the embedded Cua host started and shut down; app exited 0 on its own; service stopped.
- Console also printed one Chromium `sandbox_extension_issue_file failed ... RealBud Helper.app/Contents/Resources` line; not compared against a 43.7.5 build.
