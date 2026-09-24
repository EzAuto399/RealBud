# Welcome backup recovery — 24 September 2026

This checkpoint does not establish a newly packaged canonical application, OS Keychain/DPAPI custody, Apple notarization, installed Windows acceptance, physical two-device operation, or customer acceptance. The sealed Mac candidate and the newer canonical cancellation fix have distinct evidence.

## What changed

A fresh workspace can open **Restore a private backup** directly from either welcome step without saving a profile or changing the sample book. The private-backup destination survives reload; key recovery retains its own destination. Duplicate welcome actions are held while a save is pending. The seven-file entry fix was adopted from candidate `4c0c203fd5e951c4cd03422b97511546db8d345d` only after every canonical preimage matched, and every resulting file matched the candidate exactly.

Independent review found a missing exit: entering restore persisted the recovery stage, but cancelling selection or removing a temporary upload could not reopen welcome. **Back to welcome** now rechecks saved setup, backup status and all bounded progress pages; active, staged, interrupted or uncertain work holds the action. It writes only the onboarding preference with the current scope/revision and requires exact authoritative readback before reloading. Cancelled/expired history and completed export files are preserved. It does not delete backup artifacts or reset completed onboarding.

The optional onboarding lookup cannot disable backup recovery itself: malformed or unavailable setup hides the return action while valid backup status and saved progress still load. Client preflight does not lock another window; existing server restore and book-write controls remain authoritative and unchanged.

## Verified source and local behavior

| Layer | Result | Evidence |
| --- | --- | --- |
| Canonical tests | 1,048 passed / 0 failed / 0 skipped across 110 files; all renderer tests plus server onboarding | `outputs/welcome-restore-adoption-2026-09-24/final-tests.json` |
| Canonical types | Full `pnpm typecheck` passed | `outputs/welcome-restore-adoption-2026-09-24/typecheck-final.log` |
| Actual source renderer/service | Nine checks passed, zero page errors, 390×844 and 1440×1050 flows | `outputs/welcome-restore-adoption-2026-09-24/source-ui-2/receipt.json` |
| Integration identity | Twelve source/QA hashes, stable UI inputs, unchanged Git index, unrelated dirty tracked files preserved; all 16 local listener ports closed | `outputs/welcome-restore-adoption-2026-09-24/receipt.json` |

The browser run uses Vite, the real local Node service and disposable fictional data. It exercises no-file entry/reload/return, malformed-upload refusal and explicit temporary-copy removal/return, normal welcome completion, changed-port restarts, restored-contact preservation, sample exploration and protected-book recovery. It does not seed target onboarding completion through an API. External network is denied by the run's sandbox. Root inspected the 390px return control and desktop cancellation context.

The first source-rendered attempt stopped before the new flow because the older QA harness used macOS's symlinked `/tmp` spelling. A direct coordinator reproduction failed for that spelling and succeeded for its resolved path. The harness now resolves the temporary root; product storage checks were not weakened. The failed receipt and diagnosis remain under `source-ui-1/` and `source-ui-1-diagnosis.json`.

## Earlier sealed package evidence

Candidate `4c0c203f` has a signed, unnotarized Mac package. Its original restore-entry flow passed 12 actual packaged-app groups, six fresh-book/key checkpoints, incorrect-passphrase refusal, temporary-copy cancellation, native restart and restored-record preservation. Root verified the supplied receipt hash, executable, ASAR, bootstrap and UI-index hashes and inspected its 390px/desktop welcome screenshots. Its custody test uses an in-memory AES fixture: this is not an OS Keychain test.

The same packaged executable also passed 14 two-service groups, 94 HTTP checks and five service generations, with cleanup. That run uses Electron-as-Node and two isolated profiles on one machine; it is not two physical devices or an installed GUI lifecycle test. Retained provenance: `outputs/welcome-restore-adoption-2026-09-24/candidate-proof-review.json`.

The newer **Back to welcome** follow-up is not included in that sealed package. Candidate-compatible handoff is `outputs/welcome-restore-adoption-2026-09-24/welcome-cancel-followup.patch`, SHA-256 `762a53753e5a626dd0f474ea11de142fa572bbfbc34983041f51b9077cd89a68`; its five source/test/QA files pass `git apply --check` against the isolated candidate. Exact file hashes are in `followup-patch-manifest.json`. Canonical changes remain uncommitted; no package was replaced or published.

## Later package attempt: storage gate

The platform task adopted the five-file follow-up into isolated candidate `b8aa9f2fee9dcc634e8ff8f9153103701aa4e1ca`. Root read and hashed its package and backup receipts: compilation exited successfully, the code signature passed, and 69 native deployment targets were checked. **Full package acceptance is false.** Backup export reached sealing, refused with HTTP 507, and produced no download; the browser test then timed out waiting for that download. The native welcome cancellation follow-up has not run because it requires a successful full-package receipt.

Root independently recomputed the current production reservation from the catalog/coordinator formulas: 7,579,784,672 bytes for capture and rollback, 1 GiB for the archive, 16 KiB of markers and 128 MiB margin require **8,787,760,608 bytes (8.18424 GiB)** available at archive admission. The platform task observed 7.40667 GiB free; root's later observation was lower. Plan for at least **12 GiB free** for the backup QA and eventual kit output, allowing for fluctuation; this is a working estimate, not a changed product limit. Root evidence: `outputs/welcome-restore-adoption-2026-09-24/storage-verification.json`.

Failure receipts and existing sealed artifacts remain intact. The failed package receipt retains `cleanupConfirmed: false`; the platform task separately reports its owned process stopped and backup listener closed, while retaining the outer fixture for diagnosis. No backup retry, storage-policy relaxation, deletion, VM installation or Windows image download was performed. The VM storage choice is still unanswered and requires substantially more capacity than this package test.

A read-only size inventory is saved in `outputs/welcome-restore-adoption-2026-09-24/STORAGE-OPTIONS.md` and `storage-options.json`. The measured npm/pip caches total 1.54 GiB, insufficient to reach the 12 GiB sequence target from the observed 7.19 GiB free. Larger measured directories hold retained package/test evidence; directory sizes do not guarantee recoverable bytes on APFS. No cleanup was performed or authorized.

## Next acceptance step

The user has now connected external storage. The [external test lab checkpoint](EXTERNAL-TEST-LAB-2026-09-24.md) records successful qualification of the same signed `b8aa9f2f` package: 4 service, 9 backup and 7 boundary checks, followed by 8 native cancellation/normal-setup groups and 14 native restore groups, with cleanup. Root verified the receipts, artifact hashes, process/scratch cleanup and key screenshots; the earlier storage observations remain historical failure evidence. The private kit is now verified: `outputs/welcome-restore-adoption-2026-09-24/external-kit-verification.json` binds the sealed archive, exact inventory, manifest and Mac source; the retained platform receipt separately verifies decompressed file hashes. `/Volumes/RealBud-TestLab/receipts/realbud-test-media.json` verifies the transfer ISO and its contained installer. Artifact verification does not establish guest installation or customer delivery. Windows guest installation is next. OS Keychain/DPAPI custody, notarization, physical office and customer workflow acceptance remain open.

The existing native harness proves custody only with an AES `safeStorage` fixture. Future real macOS Keychain acceptance requires a separately authorized disposable macOS account or VM, real unmodified `safeStorage`, normal security prompts and a full app/service restart check; changing `HOME` or the data directory alone is not Keychain isolation. No account creation or Keychain access has been performed for this follow-up.
