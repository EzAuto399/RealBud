# Windows memory journal integration — 22 September 2026

Later continuation: [interrupted recovery and profile provisioning](HERMES-MEMORY-RECOVERY-PROFILE-2026-09-22.md) implements staff closure for valid payload-free prepared journals and closes profile-IO gaps. Existing records with missing evidence directories remain held. It includes a fresh Mac package; this document preserves the earlier journal checkpoint. Native Windows acceptance is still outstanding.


Status: the owned Windows storage candidate is connected to the actual memory review and proposal journals through an internal request-bound IO path. **Public Windows memory review/proposal admission remains disabled.** Local fault tests pass; this Mac has not executed the Win32 backend. No fresh application package, installation, deployment, customer access or upstream Hermes change occurred.

This follows the [storage foundation](HERMES-WINDOWS-MEMORY-STORAGE-2026-09-22.md). The latest verified unsigned Mac application remains the earlier [typed-proposal package](HERMES-TYPED-MEMORY-PROPOSALS-2026-09-22.md). Source and built server resources in this wave are newer than that application.

## Behavior and recovery

The helper binds IO to the captured profile for one request and resets it after success or failure. Neither request JSON nor environment variables can select a storage implementation or bypass the public Windows hold. The owned dispatcher uses the unmodified admitted Hermes parser and dry-run semantics; Windows candidate writes bypass the upstream in-place persistence fallback.

Native private directories and empty lock files are created without modifying existing permissions or contents. Locks use the exact native filenames and an exclusive byte-zero lock intended to cooperate with Hermes's CRT locking. Acquisition is bounded, release is checked, and ordinary file/directory handles continue to deny delete sharing. A caller's review refusal is preserved when unlock and cleanup succeed; uncertain release/cleanup remains a fixed failure. Missing ancestors, denied access and sharing failures never mean an empty store. Only a verified missing leaf can mean absence.

`hermes-memory-windows-journal.py` publishes whole files from deterministic private stages under the review lock, plus the target memory lock for memory changes. It checks exact prior and staged bytes, bounds directory inventory, preserves partial or conflicting stages, and never falls back to truncating an existing file. Signed review receipts keep their existing format and govern before/after reconciliation. A matching completed memory write is flushed and reconciled without applying the operation again.

Proposal publication uses a signed prepared journal, exclusive private stage creation, no-clobber handle move, then a signed published journal. Prepared recovery follows this table; existing POSIX hardlink recovery remains unchanged:

| Observed names | Windows candidate action |
| --- | --- |
| Stage only, exact digest | Recheck readiness, move without clobbering, then record publication |
| Pending only, exact digest | Reconcile the saved publication intent |
| Both names | Hold as a conflict, even if bytes match |
| Neither name | Require recovery; do not reconstruct a missing candidate |
| Prior human approval/rejection | Preserve the decision and proposal identity; never recreate pending work |

Cleanup claims the exact pending file into the private review area, checks its digest, requests handle-bound deletion and separately confirms namespace absence. A retained delete-sharing reader cannot be reported as terminal cleanup. Changed claims and replacement pending files remain preserved. Review intent and final-decision receipts deliberately precede cleanup so an interrupted cleanup can be retried without repeating a memory change.

Windows file writes use checked flushes and write-through around handle rename. The directory checkpoint verifies pinned ancestry; it is **not** POSIX directory `fsync` and does not establish hardware power-loss durability. Whole-file replacement relies on private ancestry and cooperative locking, not an atomic destination comparison against arbitrary same-user writers.

## Verification layers

Evidence is under `outputs/hermes-memory-windows-journal-2026-09-22/`.

- **71 portable primitive/protocol checks** pass: 19 ctypes ABI/error/enumeration checks, 19 policy checks and 33 protocol/public-hold checks. These use fictional bindings. The lock-wrapper fix has separate caller-error and failed-release regression cases.
- **18 facade checks** pass: 14 use dictionary storage and four combine the real facade and protocol with fictional native handles. They cover lock scope, whole-file publication, interrupted stage/rename recovery, unchanged retries, capacity, conflicting bytes and pending deletion. They do not execute the native backend.
- **25 actual-helper integration checks** pass against the admitted unmodified Hermes runtime on macOS, through an explicit POSIX-backed fake Windows IO facade. Actual child exits cover 11 interruption points. Exact approve/reject replay, mismatches, collisions, pending deletion, profile binding and untrusted-field/platform gates are checked. Tripwires forbid native memory writes and fallback POSIX mutation/enumeration in the selected path. This suite replaces the IO facade and does not prove native Windows locking or concurrency.
- **10 focused proposal transition checks** and **15 existing POSIX subprocess recovery checks** pass separately. These overlap with the integration behavior and are not summed as unique coverage.
- **39 macOS native/HTTP regressions** pass: 36 actual Hermes review/proposal cases plus three actual HTTP journeys with a fictional ACP peer. **156 host/packaging tests** also pass. No full-suite rerun or live model/customer acceptance is implied.
- The final server build passes. Source, built copies and the generated manifest match for **all five helpers**. Two built-resource probes verify exact sibling resolution and refusal of a missing sibling despite an already loaded module. CI YAML parses and includes the portable facade suite.
- The Windows acceptance script now prepares **15 native cases**, adding pinned directory inventory, independent CRT-process lock contention and nonempty-lock refusal. It still refuses this Mac before importing a nonexistent selected module, with exit 2 and zero native checks. No Windows CI or installer job was triggered.

The final source fingerprints and receipts are collected in `verification.json`. Successful local checks do not remove the platform gate.

## Grok development reviews

The owner's preference remains Grok CLI `grok-4.7 --reasoning-effort xhigh`, whose availability and earlier completed actual `grok-4.7-build` call were verified in the foundation wave. This wave requested four separate small reviews: native locking/absence (4,404 bytes), proposal transitions (9,862 bytes), integration harness (7,005 bytes), and journal facade (6,473 bytes). Each was limited to one turn, no requested tools/web/subagents and a 600-second deadline.

All four reached their deadlines without structured findings. Processes were terminated, terminal receipts were retained, and none was restarted. Their actual returned-model metadata is unavailable; they are **incomplete reviews, with no approval inferred**. Local code inspection and tests are the evidence reported above. CLI diagnostics also showed unrelated configured-MCP initialization warnings; that does not establish why model output failed to arrive. No global CLI configuration was changed. Diagnose the bounded execution path before repeating reviews; retain the 4.7/xhigh preference and keep review status separate from implementation progress.

## Remaining work

1. Verify private Windows profile/config provisioning and the complete candidate path with the exact admitted Hermes runtime on actual Windows. Existing profile ACL compatibility must be proved without quietly repairing broad or ambiguous permissions.
2. Execute native NTFS/ACL/identity/enumeration/CRT lock checks and full helper process termination at journal, publication, memory replacement and cleanup boundaries. Include sharing denial, disk-full and retained deletion, then prove exact retry and conflict behavior. The current integration suite supplies fake IO.
3. Exercise the exact installed Windows resources, managed Python and full proposal/review/recovery GUI before deciding whether to remove the memory hold. The later continuation implements explicit staff closure for a prepared proposal whose stage and pending file are both absent; its Windows acceptance remains required.
4. Keep signing/distribution, real OS credential custody, two-computer office operation, deployed subscription/connector lifecycle and live Austin bank/Gmail/REI acceptance as separate release gates.
