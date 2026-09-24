# Private backup v2: application integration

Updated 22 September 2026, Australia/Brisbane. This is current source, built web UI and a fresh unsigned local macOS arm64 package. The installed `/Applications/RealBud.app` has not changed. Windows, real OS key custody and customer acceptance remain separate gates.

## What now works

The existing sliced-transfer client is connected to the durable operation journal and the real HTTP host. Settings can create an encrypted v2 backup, request a native streamed download, upload in 1 MiB chunks, rediscover saved progress after reload, verify a selected file's accepted prefix, retry a failed preview, review complete contents, and stage a confirmed restore into an untouched workspace. The current supported archive ceiling is 1 GiB; it is not a measured end-to-end performance guarantee.

The HTTP host checks session, Host and Origin before routing. Binary reads are bounded to one chunk; JSON control bodies are bounded to 16 KiB. Errors contain fixed public messages. Native downloads receive a five-minute HttpOnly, SameSite=Strict cookie containing a proof signed with a separate random per-boot HMAC key. The proof and cookie Path bind the exact ticket URL. It is accepted only as a cookie on that GET, never as the general session token in a Bearer header, custom header or query. Expired, altered, alternate-ticket and duplicate credentials fail closed. Each unpredictable download ticket is also short-lived, single-use and bound to the completed operation/digest. The stream owns independent chunks and withholds the final chunk until the actual send-pass digest and file metadata are verified; a changed archive cannot complete its advertised Content-Length; no whole-archive browser Blob is needed.

Older v1 JSON requests remain compatible. Their restore adapter authenticates the legacy archive, imports it through the same destination-key catalogs, and binds staging to the operation journal. A later workspace-identity change is accepted only through the existing encrypted cold-completion proof. Old transfer history is not exposed to the restored workspace. The direct v1 export format retains its original limits; the settings UI now exports v2.

## Recovery and storage

- Every temporary store has a journal allocation and authenticated ownership marker before creation. Reopen authenticates that marker and its known files. Cancellation records intent, drains readers/writers and closes handles before removal. Failed closes retain the reservation until process exit.
- Failed preview scratch can be removed without losing the uploaded archive. Reversible prepared/build scratch can be discarded while the review remains valid. Published or uncertain restore data remains held. A coordinator-wide mutex admits one restore preparation at a time; state and digest are rechecked inside the admitted runtime.
- Stage publication can resume after a restart between recording the durable hold and publishing the compact descriptor. A failed retry records recovery-required while preserving the host barrier. Cold apply still uses exact before/intended hashes and the existing guarded replacement path.
- Decoding receives host-owned logical and physical limits. The restore transformation uses one shared visitor for exact size measurement and materialization. Component main-database and rollback-journal allowances, marker overhead, aggregate reservations, and free-space admission are charged before allocation.
- The provisional workflow database is built in bounded transactions with spilling disabled. The prepared store preserves its atomic whole-file transaction and allows spilling; it checks the live journal's page/sector header before substantial writes. Its admitted sector size is 512–4096 bytes and page size is 4096. Unsupported journal reads/filesystems are held. Native Windows behavior of this extra journal read is unverified.
- Older Desk atomic writes inherited the process umask. New writes and retained backups now request mode 0600. A narrow owned-file upgrade uses an opened, identity-checked regular-file handle to tighten permissions without rewriting ciphertext. Linked or foreign-owned files are not adopted. The actual running-app export found this mismatch; capture privacy checks were not relaxed.

SQLite's [rollback journal format](https://www.sqlite.org/fileformat.html#the_rollback_journal) and [pager implementation](https://github.com/sqlite/sqlite/blob/master/src/pager.c) informed the journal allowance. These estimates are admission budgets, not filesystem preallocation or a guarantee against another process consuming disk.

## Verification

Receipts are in `outputs/private-backup-v2-2026-09-21/`. Test sets overlap; do not sum them.

- Integrated component gate: 190 passed in 11 files, zero failed/skipped (`coordinator-integrated-tests.log`).
- HTTP/cold-publication/legacy adapter follow-up: eight passed (`coordinator-http-tests.log`).
- Host permission follow-up: 54 passed (`coordinator-host-followup-tests.log`).
- Download-cookie and HTTP boundary checks: 76 passed (`coordinator-download-session-tests.log`).
- Grok follow-up: 102 passed in five files, including retaining all streamed buffers through EOF, concurrent restore requests, and exactly one lease release (`coordinator-review-followup-tests.log`).
- Actual source bootstrap and built UI: nine checks passed at desktop and 390 px, including encrypted download, reload rediscovery, wrong-passphrase retry, fresh-workspace confirmation, actual service stop/start, exact bank CSV preservation under a different local key, and historical-receipt recovery warning (`coordinator-browser-final/receipt.json`). Screenshots were visually inspected; no page errors or horizontal overflow were observed. Native Electron restart IPC was not used in this rehearsal.
- Intermediate broad run: 4,115 passed, 143 environment-gated skips, zero failures across 332 files. Two coordinator files changed during that run for the later Grok fixes. The source drift is explicitly recorded; this is not the final frozen-source claim.
- Pre-boundary frozen-source gate: 4,118 passed, 143 environment-gated skips, zero failures; all 981 recorded inputs stayed unchanged through that suite and server build. The later Grok review produced six changed source/test files, preserved separately.
- Final boundary follow-up: 106 passed in five files, zero failures/skips. Real HTTP clients reject small and multi-chunk corruption before accepting the complete body; an authenticated ticket POST issues the separate cookie and that cookie cannot read another ticket or protected route. Typecheck and compiled server build passed. An initial TypeScript narrowing/type error is retained in `coordinator-followup-typecheck.log`, corrected in the final passing log.
- Final packaged-source suite: **4,123 passed, 143 environment-gated skips, zero failures**, across 332 files in 306.19 s (`coordinator-release-source.json`). All 1,054 selected source/test/build/pack inputs stayed unchanged through full-suite, packaging and application checks; the packaged file/symlink inventory also stayed unchanged. `coordinator-verification.json` records the source digest `41e8daab4cddbb2d63b9a2587712fe308547a5e056a237f4725f1d19571e7e7f` and artifact digest `111362aef8409ad586b6896f1063364d55b7f09bc5062cc85e90adecbdf9edab`, separately from earlier snapshots.
- Package preparation (UI/server/updater/browser), Electron syntax and local unsigned macOS packaging passed. `package/mac-arm64/RealBud.app` contains 2,408 files and 14 symlinks; the artifact manifest binds their bytes/targets.
- Packaged Electron 43.4.0 / Node 24.18.1 with its own compiled UI/server passed the same nine v2 browser checks (`coordinator-packaged-browser/receipt.json`).
- Actual packaged main, preload and restore-button IPC passed eight native checks (`coordinator-native-restore/receipt.json`), including native service stop/start, different-key restoration, retained bank bytes, bill corrections/patterns/aliases, normalized mail/history, draft recovery and stale-quarantine preservation. This native journey imports a legacy v1 archive through the v2 UI/coordinator; the separate packaged browser journey exercises v2 archive bytes. All four recorded fixture service PIDs were verified exited before scratch deletion.
- Mac renderer/capabilities/embedded service/shutdown smoke passed. Desktop and 390 px screenshots were inspected. The native custody seam is labelled in-memory AES `safeStorage`, not actual OS Keychain/DPAPI.

The first full-app export attempts failed on real Desk file permissions. After that fix, the first native browser download failed because anchors cannot attach the renderer session header. Both negative runs are preserved, along with the cookie fixes and successful application reruns. The first cookie used the broader session token; Grok identified replay scope, and the final implementation replaces it with a ticket-bound proof. Grok also identified that the client could accept the last streamed bytes before a terminal verification failure; the final implementation withholds those bytes and the regression asserts real HTTP rejection. The generated prepared-storage patch also had invalid hunk contexts, an incorrect PRAGMA assignment assumption, and an overly strict post-capacity test; Codex corrected these rather than presenting the raw proposal as tested code.

## Grok use

Authenticated `grok models` still lists 4.6 and 4.5, with no 4.7. This wave requested `grok-4.6` with `xhigh`; successful receipts record `grok-4.6-build`.

- `grok-prepared-storage.json` and `grok-v2-api.json`: bounded implementation proposals, integrated with root corrections in their disposition files.
- `grok-coordinator-integration-review.json`: incomplete review that returned only progress. It is not approval.
- `grok-coordinator-final-review.json`: completed changes-required review. The disposition records accepted fixes, narrower reproduced consequences, and findings already covered by actual host/journal contracts and tested legacy digest semantics.
- `grok-coordinator-fix-review.json`: changes-required follow-up. The disposition records the accepted terminal-chunk and master-token replay fixes, existing recovery behavior, and the deliberate rejection of ambiguous duplicate cookies.
- `grok-download-boundary-review.json`: final approval with no findings, limited to the two corrected streaming/cookie boundaries. Its `grok-4.6-build` session is `01a0c454-36dc-7052-9d73-c4933bf012d6`. Root separately verified real routing, boundary tests, source/packaged browser journeys and native restore. This is not an independent approval of the entire product.

## Remaining local and release gates

The integration is usable in the tested source application, but the product goal is not complete.

1. Reduce conservative export reservation for small workspaces; exercise larger real HTTP transfers, disk exhaustion and retained/unattributed historical-artifact inventory. Current cancellation preserves unknown files instead of guessing ownership. No 1 GiB throughput or low-disk SLA has been established.
2. Verify actual Keychain custody, native v2 file-dialog/download behavior and larger native transfers separately from the passed packaged browser flow and native legacy-import restart journey. The fresh unsigned package and native restart gate are complete at this checkpoint.
3. Run an authorized immutable native Windows build/installed-device gate. The prior Windows ACL failure remains unresolved; current source tests do not replace that proof. Check the prepared journal-read policy on Windows and supported filesystems.
4. Finish the separate Hermes before-state replacement/removal/batch approval and pending-memory inbox work. Grok remains development tooling, not a RealBud runtime agent.
5. Complete current signing/notarization/update/uninstall, multi-device office recovery and soak proof. Managed connector/billing commissioning and live Austin Gmail, paired bank CSV and supervised REI Cloud acceptance need their own authority and receipts.
