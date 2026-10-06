# Windows QA runbook

**What this does not establish:** any result. It is the procedure. A run's evidence is its JSON receipt plus screenshots, at the installed-device tier. An emulated Windows VM is never customer acceptance, and its timings are pessimistic.

Use it before every customer install. Log anything that goes wrong in [Windows test issues](WINDOWS-TEST-ISSUES-2026-10-06.md).

## The harness

`scripts/windows-qa.ps1` checks the computer, installs (install mode only), and then reads RealBud's state. It writes a JSON receipt to the Desktop and prints PASS / WARN / FAIL for each step. It works on Windows PowerShell 5.1, needs no modules and runs as the normal user.

It only reads. It never presses setup, approve, link or any other button, and it sends GET requests only. The one exception is `-Mode install`, which stops RealBud, installs it silently and starts it again. It never prints or saves the session token, and it masks your profile path as `%USERPROFILE%`.

| Mode | Steps |
|---|---|
| `fresh-check` | environment, fresh-profile (no data folder, app, process, PATH entries or logs) |
| `install` | environment, download (+ sha256 and Mark-of-the-Web), install (`/S`, timed), launch (seconds to first window and first health), then everything in `status` |
| `status` (default) | environment, service (health version vs installed version), bud (ready yes/no and why, setup job, office link), latency (20 health samples 1 s apart), logs, runtimes |

Parameters: `-InstallerUrl` (a URL or a local file, default `http://192.168.64.1:8765/RealBud-0.1.34-setup.exe`), `-ExpectedSha256` (a prefix is enough), `-Mode`, `-Out`.

**One line, pasted into PowerShell in the VM** (no file to save, and execution policy does not apply):

```powershell
& ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('http://192.168.64.1:8765/windows-qa.ps1'))) -Mode install -ExpectedSha256 4b5c9c0b
```

**Or from a saved copy:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-qa.ps1 -Mode status
```

To test a browser download (and so Mark-of-the-Web), download in Edge first, then pass the file: `-InstallerUrl "$env:USERPROFILE\Downloads\RealBud-0.1.34-setup.exe"`.

## Rig setup (Mac + UTM VM)

1. Keep at least 30 GB free on the Mac while the VM runs. A full disk corrupted the VM once (R9).
2. Put the installer and `scripts/windows-qa.ps1` in one folder. Serve it to the VM only: `python3 -m http.server 8765 --bind 192.168.64.1 --directory <folder>`.
3. Record the installer's hash on the Mac with `shasum -a 256 RealBud-*-setup.exe`. Pass its first 8 characters as `-ExpectedSha256`.
4. Don't type into the VM. Copy on the Mac, then press Ctrl+V in the VM. Typing garbles text, and the VM keyboard is UK (R1, R4).
5. Use full-screen control and the display's own keys. Background clicks don't reach the VM (R2).
6. The VM screen only redraws when the mouse moves. Move it before every screenshot.
7. The notification centre overlay blocks clicks. Close it with Escape, or use keys and app tools instead of clicking through it.
8. The mouse wheel doesn't scroll in the VM. Use PageDown and PageUp. Click a taskbar icon once only, because a second click minimises the app (R8).

## Checklist (in order)

1. **Fresh profile.** Use a new Windows user, or a VM snapshot with RealBud never installed. Run `-Mode fresh-check`. Every step should PASS. Save the receipt.
2. **Install.** Run `-Mode install -ExpectedSha256 <prefix>`. Budgets: first window within 2 min, first health within 2 min. Save the receipt.
3. **Link code.** Get one from the billing owner (realbud.app → Computers → Pair a new computer). Paste it under "Use a link code instead". The green button should switch to "Connect with this code". Linking should take under 1 min.
4. **Get started card, steps 1–5.** Walk each step. Screenshot each step and note its time.
5. **Bud setup.** It starts by itself after linking. Allow 10–25 min on the emulated VM. Run `-Mode status` every 5 min. "bud" turns PASS when Bud is ready. A FAIL names the failed stage.
6. **Packs.** Import the role packs from "Packs from your office". Check the loops arrive switched off.
7. **Gmail.** The person signs in on their own screen. Bud never sees the password.
8. **Workflows.** Review each workflow, then switch it on. Screenshot each one.
9. **Upgrade over the existing install.** Run `-Mode install` with the next installer. Bud must stay ready: "bud" PASS, with no new runtime folder in "runtimes".
10. **Browser download.** Download the installer in Edge. Expect "isn't commonly downloaded". Open Downloads (⋯), then **Keep**, **Show more**, **Keep anyway**. Run it. If "Windows protected your PC" appears, choose **More info**, then **Run anyway**. Smart App Control must be off: the environment step warns when it is on.

## Performance budgets

| Measure | Budget | Harness step |
|---|---|---|
| First window after launch | under 2 min | launch |
| First health answer after launch | under 2 min (about 30 s on x64) | launch |
| Each health answer once running | under 5 s; WARN above 1 s | latency |
| Longest stall | none over 5 s (issues #4, #43) | latency, logs ("could not answer") |
| Link code | under 1 min | manual, step 3 |
| Bud setup (emulated VM) | 10–25 min | manual, step 5 |

## Evidence to save

1. Every receipt (`realbud-qa-*.json`). Copy them to the Mac under `outputs/windows-qa-<date>/`.
2. Screenshots of each Get started step, the Bud status card, and any error, with the clock visible.
3. The installer's sha256 and where it came from (PR, commit, CI run).
4. The note of who ran it, on what machine (VM or real PC), and which build.

The receipt already holds the log lines that match `stage failed`, `could not answer`, `runtime check` or `ERROR`. Don't paste raw logs anywhere public: they are masked, but not reviewed.

## Logging an issue

1. Open [Windows test issues](WINDOWS-TEST-ISSUES-2026-10-06.md). Add a row with the next number under "Product issues", or "R" + the next number for rig problems.
2. Write the issue in one sentence, its cause if known, and "Open".
3. Cite the receipt file and step name, for example "receipt 20261007-1015, latency: max 14 200 ms".
4. Close an item only with evidence: the receipt or screenshot that shows it fixed.

## Notes

- `GET /api/hermes` is the same read the app makes. On a linked office whose saved readiness is stale, the service may re-run its own check (at most once a minute). The harness never starts setup.
- If the session file doesn't match the running service, the harness skips the "bud" step's reads and says so.
