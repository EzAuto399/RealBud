# Windows candidate from main 5d162956 — 25 September 2026

- Source: `main` 5d162956e13158e7899d4bb344637102b0f799e2 (PRs #11 and #12 merged).
- Build: GitHub Actions "Package Windows" run 36033496520, conclusion success (NSIS installer; managed runtime and native memory journal held candidate).
- Installer: `RealBud-0.1.19-setup.exe`, 161,239,357 bytes,
  SHA-256 `505d8adb0a1fd029db7abc73f13f6610f21f395f0f0b95b60165ae1118471e54`.
  The SHA-512 in the run's `latest.yml` matches the downloaded file. The run's `installed-lifecycle.json` records the same SHA-256.
- Local copy (outside the repo): `~/RealBud-candidates/main-5d162956-win-ci-36033496520/`.
  The RealBud-TestLab volume was not mounted at 17:35 UTC, so nothing was staged there or in `vm/transfer/`.
- Signing: unsigned (no Authenticode certificate). Expect a SmartScreen prompt.

## What the run's installed proofs show (tier: packaged build installed on a disposable windows-latest x64 runner)

- installed-windows, installed-service, installed-lifecycle, installed-gui, installed-gui-observation: passed.
- installed-private-backup: passed; slowest call `POST /api/private-backup/restore` 40,640 ms.

## Not shown

- Anything on the Windows 11 Arm VM, a customer computer, or a live hosted service.
- Linking, Bud install, Modelvia, Gmail or bills. Those are steps 11–19 of `docs/NEXT-WINDOWS-RUN-2026-09-25.md`.
