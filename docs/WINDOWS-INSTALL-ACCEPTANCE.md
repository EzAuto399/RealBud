# Windows 11 installed-app acceptance

This checklist records manual acceptance. Windows CI does not establish Windows 11 GUI, browser, upgrade or customer acceptance. Check the [current candidate](PLATFORM-CANDIDATE-2026-09-23.md) for existing evidence.

Use **Windows 11 x64**, a separate Windows test account with no existing RealBud data, and fictional files. Keep personal and customer accounts out. Setup needs internet access; installation needs no developer toolchain. Record Windows protection or organization-policy blocks without disabling protection.

Record **pass / fail / blocked / not run**, observations and exact errors for each step. Record installer filename, SHA256, full source revision from its build receipt, app/Windows versions and date. Screenshots must exclude credentials and customer content.

1. **Identify, install and reopen — allow 5 minutes.** Compare `Get-FileHash .\RealBud-*-setup.exe -Algorithm SHA256` with the supplied installer's receipt; stop if they differ or the receipt is missing. Install, record signature/SmartScreen messages, and open RealBud. Check navigation and readable layout. Create one fictional record, close/reopen, and confirm the same workspace and record return without a blank screen, crash or replacement profile.

2. **Check permissions and setup — allow 15 minutes.** Complete setup through the GUI and record its stages. For requested permissions, check denial produces an actionable state, then grant through normal controls and retry. Use fictional speech for microphone testing. Interrupt setup through its cancel/stop control and retry once. Download/setup success does not prove a worker turn. Account linking, model login and paid inference need separately authorized QA access; otherwise mark them blocked.

3. **Check tasks, browser control and human handoff — allow 20 minutes.** Review a fictional bank CSV, bill and priority message; compare amounts, dates and source references. Use a separate browser test profile and supplied fictional page or authorized QA site; otherwise mark browser actions blocked. Grant one scoped task, confirm the selected session, then press Stop and check automated input ends. Request human sign-in handoff: the app must report control released and remain inactive. Resume through its explicit return/check flow. Record lingering activity. Never give Bud credentials or approve real payments, signatures, sends or notices. MFA needs separate authorized QA acceptance.

4. **Check backup and recovery — allow 15 minutes.** Save fictional work, reopen, and compare record counts, values and workspace identity. Make an encrypted backup and restore into a fresh test workspace through the app. Reopen and compare records; confirm schedules remain disabled. Exercise available documented recovery controls and check for duplicate work. Record damaged-backup refusal without manually repairing or deleting saved data. Mark unavailable recovery cases not run.

5. **Check upgrade and device boundaries — allow 15 minutes.** Retain a verified fictional backup. If an identified earlier supported installer is supplied, upgrade it to the candidate and verify identity, saved work and reopening; otherwise mark upgrade not run. Uninstall this disposable installation, verify removal, then record remaining data and what reinstall restores. Installer exit alone does not prove retention. Check tray/quit/reopen for duplicate tasks or unexpected activity. Office joining needs two separate computers and its own acceptance record.

Windows memory review, proposal and decision remain held. Record the expected hold; do not bypass it. Native journal results do not remove it. These checks do not establish live integration or customer acceptance.

Build requirements and commands: [Windows build and test](WINDOWS-BUILD-AND-TEST.md).
