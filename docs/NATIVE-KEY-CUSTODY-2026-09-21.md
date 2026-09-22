# Native restart and workspace key custody

The September 21 rehearsal found a reproducible key-selection defect in the prior local Mac package: when a valid current desk used the wrapped key but an old quarantine used a different raw recovery key, restarting preferred the quarantine key, replaced the current wrapped key and removed the raw file. The source fix makes the current readable book authoritative and retains alternative recovery material.

## Implementation

`electron/desk-key-custody.mjs` is the shared selector used by both packaged service startup paths in `electron/main.mjs`.

- A key that opens the current desk wins. Quarantine files cannot silently select an older book.
- A differing raw key remains in place for explicit recovery. If replacing a differing or unreadable wrapped key, its exact bytes are first retained in `desk.key.wrap.recovery-<uuid>`.
- Missing keys beneath workflow state, private mail state, staged restoration or desk recovery files hold startup. An unreadable wrapped key only permits raw-key recovery when that raw key opens the current desk.
- A new protected key is created only for a new workspace. If protected storage is unavailable, a valid existing raw key remains usable in non-production mode. A new development key remains the server's fresh-workspace fallback.
- Wrapping must encrypt and decrypt successfully before atomic replacement. Recovery-file creation is directory-fsynced before replacing the active wrap on POSIX. The replacement is fsynced before removing a matching raw file, and a raw file changed by a concurrent recovery write is retained. Distinct recovery keys are not removed.
- New directories use mode `0700`; new wrapped and recovery files use `0600`. POSIX key reads reject links, multiple hard links, a different owner and group/world permissions. Existing parent-directory permissions are not silently changed. Windows skips POSIX ownership/mode checks: this module does not prove Windows ACL inheritance or DPAPI operation. Those require the installed Windows gate.

Startup failures retain the workspace and show the native service error screen. They no longer leave an unhandled startup rejection without a window.

An optional absolute `REALBUD_LOG_DIR` selects the native log directory before the startup writer captures it. Without that setting Electron's normal log location is unchanged. The native rehearsal supplies a disposable location: macOS Electron does not derive its normal app-log location from the fixture's `HOME` setting. Relative and empty overrides are rejected.

## Evidence and limits

`electron/desk-key-custody.test.mjs`, `electron/service-lifecycle.test.mjs` and `electron/server-supervisor.test.mjs`: **56 passing tests**. The key tests use an explicit AES safeStorage fixture, never the user's OS keychain.

`electron/log-directory.test.mjs` adds **5 passing checks** for the unchanged default, rejected invalid overrides and applying the absolute override before capturing the writer path.

`scripts/qa-native-private-restore.mjs` launches the actual packaged app, preload, detached service and compiled bootstrap. It first starts a fictional service so the app adopts it without touching safeStorage, then substitutes only the OS encryption boundary through the native main-process inspector. The app's service selection, key selection, wrapping-file logic, preload IPC and restore UI are unchanged. The source backup and target have distinct keys. CUA is paused, the process environment excludes provider credentials and all data lives in a disposable home. Renderer routes and Electron network requests are guarded after debugger attachment; child Node networking and pre-attachment startup are not globally fenced. This is not process-wide network isolation.

The previous package passed native adoption, native stop/start and clicking **Restart service to finish restore**, including exact bank-source bytes and a durable restore receipt. Its subsequent stale-quarantine restart failed the protected-key identity assertion as expected. The dated negative receipt is `outputs/native-private-restore-before-fix-2026-09-21/receipt.json`.

The corrected unsigned Mac package passed all **4 native checks** on September 21 at 05:24 UTC, repeated at 05:29 UTC to improve screenshot framing, using Electron 43.4.0 / Node 24.18.1. The app adopted the isolated service; real preload stop/start migrated the existing key to the protected-storage fixture; the native restore button cold-loaded the backup with the same target key, exact original bank bytes and a durable completion receipt; another native restart ignored a stale quarantine when selecting the current key and retained the alternative raw key and quarantine bytes. The source backup used a different key. The initial and runtime log paths matched the explicit disposable directory, which contained the first service-adoption log line. Cleanup removed the temporary directory and left no process carrying its path.

The final receipt and visually inspected staged/completed screenshots are under `outputs/core-lifecycle-2026-09-21/native-private-restore/`. The receipt binds the tested app archive (`fb1a5e2ae7bc8f929a2bada3e5ad5ff41da6cbd5bbca7964567752d8fbe56eb0`), compiled bootstrap and UI hashes. The earlier negative package result remains a regression reproduction, not positive evidence.

The rehearsal does not prove real macOS Keychain prompts or custody, Windows DPAPI/ACL behavior, physical Windows installation, signing/notarization, reboot survival or customer-office operation.

## Normalized bill retention package follow-up

`outputs/source-bill-retention-2026-09-21/native-private-restore/receipt.json` records **5/5 native checks**, zero renderer errors, with ASAR `fa6579cbfd68b1836cb037da509970140c43dd6f8ca7e7e3f76530677c388a13`. Added checks seed fictional bills through the selected package's compiled domain, then verify corrected history, a paused pattern and its old source alias through actual HTTP after different-key restoration. This is not Gmail acquisition proof. The durable completion UI was visually inspected.

Independent harness review tightened cleanup: authenticated service shutdown is followed by existence checks for every captured service PID. A missing health response alone does not establish process exit, and recorded PIDs never receive termination signals. Uncertain cleanup fails the run and retains its fixture directory. The final run captured four service PIDs, verified they exited and removed its scratch directory. The network-boundary wording above corrects the older receipt's broader statement; no additional network-isolation claim is made.

Run against an explicit compiled package:

```sh
REALBUD_QA_RESOURCES='/path/to/RealBud.app/Contents/Resources' \
REALBUD_QA_EXECUTABLE='/path/to/RealBud.app/Contents/MacOS/RealBud' \
PLAYWRIGHT_MODULE='/path/to/playwright/index.mjs' \
QA_OUTPUT='/path/to/dated-native-restart-proof' \
node scripts/qa-native-private-restore.mjs
```

The controller needs Node 24. Every service is run by the selected app's own Electron/Node executable. The script never replaces an installed app or stops another workspace's service.
