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

## Preconditions

- **Run on Windows.** NSIS packaging from macOS needs Wine; don't.
- **Node 24+** (`package.json` `engines`).
- **pnpm** via `corepack pnpm`.
- Graduate path: `docs/GRADUATE-RELEASE.md`. Until Hermes is bundled, Windows
  stays CSV-only for worker attach (`hermesInstallCommand` is null on win32).

## 1. Version

Bump `version` in `package.json`. It must match the tag on the GitHub release you
upload to, and it becomes the version electron-updater compares against.

## 2. Build

```powershell
pnpm install
pnpm typecheck
pnpm package:win
```

`package:win` deliberately omits `build:speech` — the dictation helper is a signed
macOS Swift binary and has no Windows counterpart.

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
Auto-update still works while unsigned (no `publisherName`).

When signing is added: `win.signtoolOptions` or `win.azureSignOptions` in
`electron-builder.yml` (electron-builder 26 — no top-level `win.certificateFile`).
Only then set `publisherName`. Keep the certificate subject stable forever, or
list both old and new in `publisherName`.
