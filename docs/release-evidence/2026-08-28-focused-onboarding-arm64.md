# Focused onboarding macOS arm64 QA record

Recorded: 2026-08-28 19:09 AEST

## Candidate identity

- App version: `0.1.17`
- Git commit: `750f7ae`
- Working tree: dirty shared development tree; not an immutable candidate
- Host: macOS 26.3.1, arm64
- Tester: local Codex QA run

## Proof performed

1. Built the current directory app with Node 24 using `pnpm package:mac:dir`.
2. Passed `scripts/verify-mac-package.mjs`: one arm64 app bundle, required UI/server/property-pack/speech/CUA resources, CUA Driver 0.19.3, native architecture, strict code-signature verification and safe entitlements.
3. Passed `node scripts/smoke-linux-package.mjs` on macOS: two launches with isolated HOME, Electron user data and RealBud data; smoke-only mock Keychain; encrypted Desk/model persistence; manual-approval safety pack; packaged CUA resolution despite an ambient sentinel; personal-Hermes/CUA sentinels unchanged; embedded server and data lock stopped cleanly.
4. Launched the packaged renderer with an explicit isolated `--user-data-dir`, smoke-only mock Keychain and loopback DevTools endpoint. At 900 x 600 it completed profile save, the three permanent rules, focused setup, in-window reload resume, process-restart resume, compact You re-entry and Escape recovery. The document width stayed equal to the viewport and the reload produced no renderer warning, page error or visible alert.
5. Added a read-only 3.0 GB install-capacity gate at the API and installer mutation boundaries. Focused tests prove low and unverifiable capacity fail closed, and low capacity creates no staging slot. The full Node 24 verifier passed 136 files / 948 tests / 8 skipped plus every browser/CUA walkthrough in 39.4 seconds.
6. Rebuilt and re-signed the directory app after that change, verified the compiled capacity guard is bundled, and repeated the two-launch packaged smoke successfully. The renderer assets are byte-identical to the focused GUI artifact above (`app.asar` hash unchanged).

The focused guide remained presentation-only until its explicit action: no private worker executable was installed, no model key was attached, no OS permission was granted and no external account was contacted. The local property safety pack was present with manual approvals.

## Artifact identity

- App signature: Developer ID Application, team `4F4SMS88P8`
- Notarization: deliberately not performed
- Main executable SHA-256: `72893e79ebd7165bda8bc3a14749605866d5945958afed68423ceb1baf74566c`
- `app.asar` SHA-256: `8cdc3ecf2524211140ba537c2a3515977508024a6e2bb5462e110d3647f208fe`
- Bundled server install bridge SHA-256: `5e84aee2f5549e8f185db8330f11fc5fd1b374140828bbe92e9845f0583eb8b8`
- Bundled server entry SHA-256: `fb7913baf01166770398962d499b55c5472e880f9e429809d5f82c780d05c597`
- Bundled CUA executable SHA-256: `532c1ed920acf23c8c804553faeb6ffd65af84fd6490289e0954580668eb30dc`

## Limits and incident note

- The current private worker runtime is about 1.6 GB. Only about 1.6 GB was free after packaging. The compiled production probe returned `1.6 GB free; Bud needs 3.0 GB to prepare safely`, so the worker-install replay was held before staging.
- Real Keychain, real Accessibility/Screen Recording consent, funded-model conversation/image intake, named PMS/bank/vendor accounts, notarization, installation outside the repository, update delivery and publication were not tested.
- The first inspection launch supplied environment-only user-data isolation without the package-smoke gate. Production correctly ignored that ambient redirect, so Electron briefly used the existing RealBud Chromium profile and refreshed its RealBud-owned `cua-connection.json`. The process was stopped before UI interaction. RealBud property data still pointed to the isolated test directory; no personal Hermes profile or launcher was read or changed. The accepted run used Chromium's explicit isolated `--user-data-dir`, verified that every child process used it, and started no CUA process.

This record is package and installed-QA evidence only. It does not promote the dirty working tree to a release candidate.
