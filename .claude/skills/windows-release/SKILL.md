---
name: windows-release
description: Build, verify, and publish the Windows desktop build (NSIS installer + latest.yml) to EzAuto399/RealBud. Use when cutting a release, shipping a new version to Windows users, or when a Windows user reports they are stuck on an old version. Windows only — does not cover the macOS dmg/notarization flow (see docs/GRADUATE-RELEASE.md).
---

# Windows release

Ships `RealBud-<version>-setup.exe` and its update feed to
[EzAuto399/RealBud](https://github.com/EzAuto399/RealBud).

**Scope: Windows only.** The macOS build is a separate flow (dmg + notarytool +
staple via `pnpm package:mac:release`) that must run on a Mac. This skill never
touches mac artifacts — but see [Every release ships both](#every-release-ships-both)
before you finish.

Current Windows prerequisites, compilation, installer checks and feature holds
are maintained in [Windows build and test](../../../docs/WINDOWS-BUILD-AND-TEST.md).
That guide supersedes the older CSV-only and missing-Windows-speech assumptions.
Packaging, installed GUI acceptance and public release remain separate gates.

## Preconditions

- **Run on native Windows x64.** The package must stage Windows binaries; do
  not cross-compile through macOS, Wine or WSL.
- **Node 24 x64** and **pnpm 10.33.0**, matching the checked-in CI/toolchain.
- Windows PowerShell, `tar.exe`, and the .NET Framework C# compiler plus
  `System.Speech.dll`. Run the prerequisite checker below before compiling.
- The managed worker has a Windows setup path in `server/worker-bootstrap.ts`;
  a null legacy `hermesInstallCommand` is not evidence that Windows is CSV-only.
  Fresh-device worker/model setup, attended CUA and memory acceptance retain
  their separate gates in the build guide.

## 1. Version

Bump `version` in `package.json`. It must match the tag on the GitHub release you
upload to, and it becomes the version electron-updater compares against.

## 2. Build

```powershell
node scripts/check-windows-build.mjs
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd package:win
```

Run each command only after the previous one succeeds. `package:win` compiles
`RealBud Speech.exe` with `build:speech:win`; the Swift helper is macOS-only.
It also stages the reviewed browser helper, Windows CUA runtime/SDK and
PostgreSQL runtime. This inventory does not prove microphone quality, GUI
actions, worker/model access or office provisioning.

Output in `release/`:

| File | Purpose |
|---|---|
| `RealBud-<version>-setup.exe` | the installer |
| `latest.yml` | **the update feed** — see step 4 |
| `RealBud-<version>-setup.exe.blockmap` | differential updates |
| `RealBud-<version>-x64.zip` | portable, not used by the updater |

## 3. Verify before uploading

```powershell
Test-Path release\win-unpacked\resources\server\index.js
Test-Path release\win-unpacked\resources\ui\index.html
Get-Content release\win-unpacked\resources\app-update.yml
```

- Missing `server/index.js` → harness fails → "Couldn't start the desk service".
- Missing `ui/index.html` → black window.
- `app-update.yml` must point at `EzAuto399/RealBud` and, while the build is
  unsigned, **must not contain `publisherName`**.

Then smoke-test the installer: per-user install, Desk renders, logs under
`%APPDATA%\RealBud\logs\server.log`, no surprise update popup on first launch.
Use the build guide's disposable CI and Windows 11 checks, preserving the exact
installer digest, source candidate and receipts. Older hosted-runner success
does not cover subsequent working-tree changes or an installed upgrade.

## 4. Publish

Upload to the **same tag** as the macOS release for that version.

```powershell
Copy-Item release/RealBud-<version>-setup.exe release/RealBud-setup.exe
gh release upload v<version> --repo EzAuto399/RealBud `
  release/RealBud-<version>-setup.exe `
  release/RealBud-setup.exe `
  release/RealBud-<version>-setup.exe.blockmap `
  release/latest.yml
```

- **`RealBud-<version>-setup.exe`** is what `latest.yml` references.
- **`RealBud-setup.exe`** is a stable `/releases/latest/download/` URL.

**Never hand-edit `latest.yml`.** It pins the installer's sha512.

## Every release ships both

Whenever a new version goes out, Mac notarized artifacts and Windows artifacts
land on the same tag. If Windows can't ship, don't publish a mac-only tag as a
customer release — or say Windows is frozen in the release notes.

## Signing (T17 Win)

No certificate is configured today, so SmartScreen shows "unknown publisher".
Unsigned update metadata intentionally omits `publisherName`; a successful
installed upgrade is a separate acceptance check.

When signing is added: `win.signtoolOptions` or `win.azureSignOptions` in
`electron-builder.yml` (electron-builder 26 — no top-level `win.certificateFile`).
Only then set `publisherName`. Keep the certificate subject stable forever, or
list both old and new in `publisherName`.
