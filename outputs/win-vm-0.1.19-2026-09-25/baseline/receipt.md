# Baseline on installed 0.1.19 (main 5d162956), Windows 11 Arm VM, 25 Sep 2026, about 18:49–19:21 UTC

Tier: installed device on the Windows 11 Arm VM `RealBud-Win11-Arm-QA` (x64 app under emulation). Not customer acceptance. No hosted steps, no reset, snapshot or delete.

1. Disk health after the reset
   - VBox.log since the 10:58Z reset: 6 VM-disk read stalls (25, 38, 57, 37, 108 and 37 s) with AHCI port resets, about 11:38–12:52Z. None in the roughly 6 h after that.
   - Guest System log (last 30 h):
     - Unexpected restarts: 2x Kernel-Power 41 and 2x EventLog 6008.
     - Guest crash: WER 1001 "rebooted from a bugcheck 0x000000ef" (CRITICAL_PROCESS_DIED); volmgr 162 "Dump file generation succeeded".
     - Disk I/O: 6x storahci 129 (device reset) and 2x disk 153 (I/O retried), both warnings.
     - NTFS 98 "Volume C: is healthy. No action is needed." after the restart.
   - `Get-Volume C:` gives Healthy / OK, 92 GB free.
   - `chkdsk C: /scan` not run: "Access Denied … invoke this utility running in elevated mode" (exit 3). The UAC elevation prompt was not answered.
2. `powershell.exe -NoProfile -Command exit` launch times
   - After 60 s idle: 870, 698, 1,632 ms.
   - Back-to-back: 1,903, 1,122, 2,261 ms.
   - The day before, under guest load: 19,788, 3,928, 4,378 ms.
   - A true cold-cache run needs admin rights, so these are best-effort.
3. Export retry (one attempt, machine idle, continues interrupted op e6bb1cdf)
   - Started 19:15:56Z. The service log was last written 19:18:32Z, so it failed within about 156 s.
   - UI: "This backup operation was interrupted. Check its saved progress before continuing."
   - Safe log lines in this service session (two; which one is the retry cannot be told from timestamps):
     `Private backup failure {"kind":"export","phase":"capturing","status":409,"code":"workspace-busy","reason":"pause-timeout","locations":["workspace-activity.js:5","workspace-activity.js:90","private-backup-coordinator.js:360","private-backup-capture.js:71","private-backup-capture.js:83","private-backup-capture.js:318","private-backup-capture.js:428","private-backup-capture.js:443"]}`
     `Private backup failure {"kind":"export","phase":"capturing","status":409,"code":"workspace-busy","reason":"pause-timeout","locations":["workspace-activity.js:5","workspace-activity.js:90","private-backup-coordinator.js:360","private-backup-capture.js:71","private-backup-capture.js:83","private-backup-capture.js:157","private-backup-capture.js:415","private-backup-capture.js:464"]}`
4. Operation interrupted by the reset (e6bb1cdf, 25/09 10:40:55)
   - Before the retry: "Backup · Ready to continue", detail "This backup operation was interrupted…", with "Remove temporary copy" offered.
   - Recoverable, not stuck. After the retry it is still "Ready to continue".
   - The older e664780b is still "Needs attention".
5. Other observations
   - After the reboot, the app reached the saved Desk about 2.5 min after launch.
   - A blank beige renderer appeared twice more and needed Ctrl+R (shots 14–17).
