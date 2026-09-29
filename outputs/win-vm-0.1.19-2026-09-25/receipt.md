# Windows 11 Arm VM run: RealBud 0.1.19 from main 5d162956 (25 September 2026)

Tier: installed device on the Windows 11 Arm VM `RealBud-Win11-Arm-QA`, running the x64 app under emulation. This is not customer acceptance. No hosted steps ran.
Guest driving: `VBoxManage controlvm keyboardputstring/keyboardputscancode` plus `screenshotpng` (shots/). The guest keyboard layout is UK. Guest Additions are absent. Host times are UTC. The guest clock reads about 10 h behind host UTC in log lines ("guest").

## Checks
1. Staging: pass. Host installer SHA-256 is 505d8adb…71e54 (161,239,357 bytes). The ISO `downloads/RealBud-5d162956-test-media.iso` was already attached. The guest `Get-FileHash D:` gives 505D8ADB…471E54 and 161,239,357 bytes (shots/07).
2. Upgrade install over the earlier build: pass. `Start-Process -Wait` returned exit 0 after 537 s. The installed exe timestamp changed from 2026-09-24T10:51:24 to 17:25:04 (shots/15).
3. Launch: partial.
   - Window shown about 3 min after launch.
   - The first detached service did not answer within 20 s. The window reached "The office service did not start" (shots/20).
   - A duplicate service start crashed with `listen EADDRINUSE` on 127.0.0.1:8799, logged as a crash event at guest 00:10:40.
   - The watchdog then recovered the window, but the renderer stuck on "Checking your saved setup…" for more than 8 min (shots/31).
   - Cause: `FirstRunGate` reads /api/onboarding with no timeout, so it shows no error or Try again. The service answered the same endpoint in 1 s (401 without a session).
   - Ctrl+R recovered the window to the saved Desk (shots/34).
4. Service healthy: pass. `/api/health` gives app=realbud, static=True, pid 4556. That pid stayed the same through every later step.
5. Welcome/Desk persists across upgrade and close/reopen: pass.
   - The saved Desk (Demo, 3 Needs you) came through the upgrade.
   - Alt+F4, then relaunch, reopened the saved Desk within about 35 s (shots/59). The service survived the close (same pid).
6. Fictional sample morning: partial.
   - Recheck gave "Missed — facts held. Managed service needs trusted company and host provisioning." (shots/41). `lastRunAt` is already set, so Recheck takes the live, entitlement-gated path.
   - Book → "Replay sample morning" worked: the banner read "Sample morning replayed" and the property facts showed "10d late · No rent yet" (shots/55-56).
   - The summary line still reads "Recheck missed". The 6/2/1 practice result was not re-observed.
7. Private backup export: fail. The UI showed "Copying took longer than the safe pause — try again with the computer idle." (shots/83). The service log line (safe diagnostic only):
   `Private backup failure {"kind":"export","phase":"capturing","status":409,"code":"workspace-busy","reason":"pause-timeout","locations":["workspace-activity.js:5","workspace-activity.js:90","private-backup-coordinator.js:360","private-backup-capture.js:71","private-backup-capture.js:83","private-backup-capture.js:318","private-backup-capture.js:428","private-backup-capture.js:443"]}`
   - The workspace is tiny: about 24 files in subfolders plus the top-level files.
   - A cold `powershell.exe -NoProfile -Command 1` took 19,788, 3,928 and 4,378 ms in the guest (shots/87).
   - Hypothesis, unconfirmed: the per-path `windowsFilePrivacy` spawns (two passes) exceed the 120 s pause on this VM.
8. Restore into a fresh fictional workspace: not run. No encrypted file exists.
9. Edge cases:
   - App restart while service keeps running: pass. Same pid 4556, and each launch "adopted the running office service on port 8799".
   - Second launch while first is running: partial. One window, 5 processes, same service pid. The focused window rendered blank beige for more than 2 min until Ctrl+R (shots/64-69).
   - Close during a backup: partial. The retry export started at 10:51:45 and the window closed at 10:52:08. The service stayed up (pid 4556, still healthy at about 10:56). The saved operation state was not observed: the guest reset first.
   - Watchdog under load: at guest 00:23, during Recheck, the watchdog declared the service ended and tried a restart. It got "no office service port is available", then "answering again".
10. VM incident, not caused by an agent command: VBox.log shows VD#0 writes active for 27 s and 39 s, then AHCI port 0 and HBA resets, cancelled requests, and at about 10:58:13Z the VM state RUNNING→RESETTING. At 11:00 it was sitting at firmware "Start boot option". No shutdown, snapshot or restore was issued. A Windows sign-in will be needed again.
