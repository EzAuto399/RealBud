# Windows 11 test steps

**Kit status:** the included installer is the existing Windows-tested `0.1.19` build from source `fb6cebed63aaed9d81f9112005ac938644d2fa86`. It does not contain today's newer working-tree changes. Use it for a baseline installation check; use a newly built, identified candidate for acceptance of the fixes.

Installer: [RealBud-0.1.19-setup.exe](installer-fb6cebed/RealBud-0.1.19-setup.exe) (160,730,532 bytes).

SHA256: `0ba39f09bb5a0caf935a8acf92081c7ceee57f89d998baf127c4e83b307f8f63`.

Use a Windows 11 x64 PC, internet access and a separate Windows test account with no existing RealBud data. No developer toolchain is required simply to install this package. It is unsigned; record any Windows or organization-policy block rather than disabling protection. Keep real bank, email and customer accounts out of this fictional rehearsal.

1. **Install and open — allow 5 minutes.** Verify the hash using `Get-FileHash .\RealBud-0.1.19-setup.exe -Algorithm SHA256`, run the installer and open RealBud. Record Windows version, app version and any warning. Confirm the first window and navigation render without a blank screen or crash.
2. **Set up Bud — allow 15 minutes.** Follow the app's setup flow and record each completed stage. Test interruption and retry. Real account linking/model inference needs an authorized QA account and remains a separate live test. A visible setup screen or downloaded runtime is not a successful worker turn.
3. **Rehearse the three workflows — allow 20 minutes.** Use fictional bank CSVs, fictional bill text and fictional morning-priority messages. Confirm CSV bytes/amounts survive review and export, bill dates remain reviewable, and priorities retain source references. REI upload is deferred. Confirm Stop stops the task; record remaining processes after a timeout. Windows child-process timeout cleanup is still an unresolved gate.
4. **Restart and restore — allow 15 minutes.** Save fictional work, close/reopen the app and verify the records. Test an encrypted backup in a fresh test workspace, restart again, and check records, key continuity and schedules remaining disabled after restore. Record any damaged-data refusal without deleting or repairing the files manually.
5. **Exercise office and native boundaries — allow 15 minutes on one PC.** Check a second isolated workspace cannot read the first. Verify Windows tray/sign-in behavior and service crash recovery without duplicate jobs. A real office join requires a second computer. Record attended desktop control and memory review as held until their platform gates are completed. Do upgrade/uninstall preservation testing only on the disposable account after retaining a verified backup.

For each step record **pass / fail / blocked / not run**, the candidate hash, and the exact error. Do not include credentials or customer content in screenshots or reports. A clean installation does not prove account linking, a real model turn, signed-in browser control, office joining or customer acceptance.

Build prerequisites and commands: [Windows build guide](../../docs/WINDOWS-BUILD-AND-TEST.md).
