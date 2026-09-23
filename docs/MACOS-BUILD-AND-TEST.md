# macOS build and test

The package targets **macOS 13 or later on Apple Silicon**. Build on an Apple
Silicon Mac with an arm64 Node process. Intel Macs and
Node running through Rosetta are not supported package targets. See the
[current candidate evidence](PLATFORM-CANDIDATE-2026-09-23.md) and the separate
[Windows build guide](WINDOWS-BUILD-AND-TEST.md).

## 1. Prepare the build computer

| Requirement | Purpose |
| --- | --- |
| Node.js 24 arm64 and pnpm 10.33.0 | Matches the supported toolchain and `packageManager` pin. |
| Git | Source checkout and revision recording. |
| Selected Xcode Command Line Tools, macOS SDK and Swift compiler | Builds speech support and supplies `lipo`, `otool` and signing tools. |
| RealBud Developer ID Application identity for team `4F4SMS88P8` in the local Keychain | Produces the signed distribution package; notarization verifies this exact team. |
| Valid Apple notarization credentials with access to that team | Needed for the notarized distribution step, after packaging. |

Use a writable native checkout and build/cache directory. Preparation downloads
the pinned Electron, BrowserSkill, CUA and PostgreSQL artifacts or uses their
verified caches. Confirm `node -p "process.arch"` reports `arm64`,
`node --version` reports version 24, and `pnpm --version` reports 10.33.0.
Check `xcode-select -p` and `xcrun --find swiftc`, then install dependencies:

```bash
pnpm install --frozen-lockfile
```

## 2. Build the reviewed source

```bash
pnpm package:mac
```

This builds the renderer, compiled server and updater, stages native runtimes,
builds speech support, and produces the signed app, DMG and ZIP under `release/`
with publishing disabled. Record `git rev-parse HEAD` and `git status --short`;
record any source changes rather than attributing a dirty build only to HEAD.
Artifact names use the version in `package.json`.

Speech compilation explicitly targets macOS 13 arm64, matching the bundled
CUA runtime's minimum. The app and speech bundle advertise the same minimum;
the Mac smoke checks native deployment targets against it. A build on a newer
Mac must not silently make its helper require that newer operating system.

## 3. Check the packaged app

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/RealBud.app
pnpm smoke:mac
```

Run each command only after the previous one succeeds. The smoke uses an
isolated profile and checks packaged startup, renderer wiring and shutdown.
Keep the unpacked app until testing finishes. `package:mac:release` includes
cleanup and removes that app, so it is not the build command for this sequence.

## 4. Notarize for distribution

If the `realbud-notary` profile is missing or Apple rejects its credentials,
run `pnpm notary:store` in your own Terminal. Enter the app-specific password
only in that local prompt. After packaging and successful credential validation:

```bash
pnpm package:mac:notarize
pnpm smoke:mac
```

Record the exact final DMG/ZIP hashes with `shasum -a 256 release/*.dmg
release/*.zip` after notarization. Preserve their receipts and required test
artifacts before optional `pnpm clean:release` cleanup. Do not run cleanup during
another packaging or test process. These commands do not publish an updater or
GitHub release. The saved credentials returned HTTP 401 during the current
candidate work; signing alone does not establish notarization.

## 5. Test a normal installation

Use the [macOS installed-app checklist](MACOS-INSTALL-ACCEPTANCE.md) with the
identified notarized artifact and fictional data. Another Mac's Gatekeeper,
permissions, microphone, browser handoff, upgrade and saved-work acceptance
remain separate from the build and isolated packaged smoke. Customers do not
need Node, pnpm or Xcode to launch the packaged app; first worker setup downloads
its reviewed runtime and dependencies.
