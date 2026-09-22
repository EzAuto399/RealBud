# Windows memory storage candidate — 22 September 2026

Later source checkpoint: [journal integration and recovery](HERMES-WINDOWS-MEMORY-JOURNAL-2026-09-22.md) connects these primitives to the owned review/proposal logic, adds native-compatible locking and bounded inventory, and records further local tests. The foundation receipt below is historical. Public Windows memory admission remains held.

Status: owned storage primitives and protocol implemented; production memory review/proposal on Windows remains disabled. This is a source and local test checkpoint, not Windows execution or a completed Windows memory feature. The previously verified unsigned Mac package predates this wave; the installed app is unchanged.

## Implementation

`server/helpers/hermes-memory-windows-native.py` owns typed Win32 bindings and file handles. It accepts local fixed NTFS volumes with persistent ACLs, verifies file identity and actual security descriptors, refuses reparse points and multiply linked files, and creates new private files with their security descriptor supplied before any contents. Existing files cannot be truncated or rewritten through its write method. Unknown native errors become fixed messages. An unsuccessful close never marks the handle released.

`server/helpers/hermes-memory-windows.py` pins every ancestor directory, confines operations to one protected profile, checks content digests, and requires a host-owned mutation lock. Publication is a no-clobber rename of the verified source handle into a verified destination directory handle. Replacement checks the old bytes under the cooperative native lock, closes that target reader, then replaces the whole file. It never copies through or falls back to an in-place write. Readback uses the retained source handle and checks its new name and identity. This is not a destination compare-and-swap against arbitrary same-user writers.

The root ACL must be protected. A native-created child may inherit access only beneath a currently verified private root, and every actual ACE must still satisfy the current-user/System/Administrators policy. The separate global `windows-file-privacy.ts` policy is unchanged. Impersonated execution and unsupported storage remain held.

Deletion binds disposition to the checked handle but returns **deletion-requested**, not a terminal cleanup receipt. A pre-existing reader with delete sharing may retain the file after our handle closes. Journal integration must reconcile namespace absence before terminal cleanup. Likewise, an interrupted or ambiguous rename requires signed before/after reconciliation rather than repeating a mutation on assumption.

The direct Python review dispatcher now enforces the Windows hold before native imports or profile access. The host and proposal integration already enforce their own hold. The new modules are not wired into approved live memory changes yet.

## Design evidence

Handle-relative replacement follows Microsoft's [FILE_RENAME_INFO contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info). Actual per-file security is read through [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo). Writable source handles use write-through and checked pre/post flushes according to [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew); these checks do not prove hardware power-loss durability. Full primary-source notes, admitted Hermes source hashes and dispositions are in `outputs/hermes-memory-windows-2026-09-22/`.

The unmodified admitted Hermes Windows fallback may perform an in-place overwrite after sharing failures. That persistence path must be bypassed for approved Windows memory changes; changing the upstream runtime is not the solution. Native memory semantics and interoperable target locks still need explicit integration with the owned journal and adapter.

## Grok development work

The authenticated CLI now lists **4.7** as available and default; new delegated work uses `grok-4.7 --reasoning-effort xhigh`. The project goal prompt retains that preference. Already running 4.6 calls were allowed to finish.

- The 4.6/xhigh native proposal completed as `grok-4.6-build`, session `01a0c4c2-bc8e-70e0-a3c0-57265c21304b`. Codex rejected unsafe draft reparse/path-binding/close behavior and adopted only two additional guards: empty new-file admission and actual numeric field bounds. This was an implementation proposal, not review approval.
- The 4.6/xhigh persistence review completed as `grok-4.6-build`, session `01a0c4c7-126f-7fd0-b27c-f1ef10c7818f`. Its handle replacement/recovery observations informed the design. Release/power-loss admission remained a separate decision.
- The 4.7/xhigh harness review completed as `grok-4.7-build`, session `01a0c4cd-9707-77f3-ac85-5add7c736758`, one turn, exit 0/end-turn. Its four findings were fixed: hard-link cleanup sharing, precise junction-refusal category, unrelated-root rejection, and primary-failure preservation during cleanup. Later deletion/flush/absence checks were locally reviewed and tested; they are not presented as part of the earlier frozen review.
- A separate requested 4.7/xhigh review of both storage modules reached its enforced 1,800-second deadline, exited -15 after SIGTERM and returned no structured output. It is **incomplete**, with no model findings or approval claimed. It was not restarted. Independent local inspection found and fixed the host-lock exception leak and clarified pending deletion semantics; four additional local lock-boundary probes passed. Future model reviews should use smaller focused packets rather than repeat this 46,350-byte request.

The call receipts, frozen input hashes, structured outputs and source dispositions are retained in the wave's output directory. An incomplete model call is not an approval, and no model review establishes native Windows behavior.

## Verification and delivery wiring

- **47 portable checks pass**: 12 raw ctypes layout/buffer/error contracts, 14 policy/combined-adapter checks, and 21 protocol/held-helper checks. They use fictional bindings and are not NTFS or operating-system proof.
- **39 native/HTTP regressions pass** against the admitted unmodified Hermes runtime on macOS (36 native review/proposal checks and three actual HTTP journeys with a fictional ACP peer). **108 focused host/packaging tests** pass separately. The first focused run skipped those three opt-in HTTP cases; the final native/HTTP run enabled and passed them. No full-suite rerun or live model/customer proof is implied.
- Frontend/server typechecking and the final server build pass. Source, built copies and the generated manifest agree for all four memory helpers. There is no fresh Mac application package for this wave and no Windows execution.
- Two built-helper resolution probes pass: the protocol imports its exact built sibling, and a missing sibling is refused even when another native module was previously loaded. There is no checkout fallback. These are built server resources, not an installed application result.
- The Windows-only acceptance script refuses a non-Windows process with a failing unsupported receipt before loading the selected module. It checks the exact supplied module without a source fallback and records its hash, interpreter, volume, test results and cleanup.
- The acceptance script has **12 mandatory native Windows cases**, including checked flushes around rename and deferred deletion. Seven portable harness control-flow checks pass; the final macOS unsupported check exits 2 with zero native checks. An inaccessible pathname cannot count as successful deletion, and cleanup failures cannot hide the primary failure.
- Source CI now runs the portable tests and the native candidate probe on its Windows job. The installer acceptance script probes the exact installed helper using the CI runner's Python, checks the receipt and file hash, and preserves the distinction from Hermes-managed Python/runtime acceptance. No remote job was triggered in this wave.
- Server packaging verifies and records the exact bytes of all four dynamically loaded memory helpers. Generated Python cache directories are excluded from input copying.
- Local results and final fingerprints are recorded in the wave's `verification.json`; review dispositions retain earlier frozen source hashes and subsequent fixes.

## Windows CI timeout fix — 22 September 2026

This note records a harness change only. No Windows acceptance has passed; the native candidate remains unproven on Windows and the production hold is unchanged.

Run 35709366311 (`windows-latest`, Windows Server 2025, Python 3.12.10) failed the third native case, "An inherited child requires its containing protected root; absent and unrelated roots are refused without repair", with `failure_type: TimeoutExpired`, `handles_drained: true` and `cleanup: true`. That case makes the run's first `powershell.exe` call (a `Get-Acl` descriptor read); the fixture helper allowed each disposable command only 20 seconds, which a cold Windows PowerShell start on a hosted runner can exceed. Cases 1 and 2 use no subprocess, which is why they passed. The receipt named the check but not the command, so the cause was not readable from the evidence.

Changed, without relaxing any refusal or assertion: each disposable fixture command (PowerShell ACL/junction preparation and the independent CRT lock probe) now gets 120 seconds instead of 20 and 10; a check may take 300 seconds and the whole run 480 seconds, after which acceptance fails with a fixed message rather than running unbounded; the CI step carries `timeout-minutes: 10`, nested inside the job's 15, so the script's own budgets expire first and still write a receipt. The helper already used `-NoProfile -NonInteractive`.

The receipt now carries `timeouts` (the configured fixture/check/run budgets), `check_seconds` (elapsed seconds per passed check, for spotting a near-miss before it times out) and, on failure, `active_step` plus `active_step_timeout_seconds` — a short fixed label such as "fixture: inherited child descriptor read", never command output and no path beyond the disposable root. Each check name is also printed to stderr as it starts, so an outer kill still names the running case in the CI log.

Verified on macOS only: `python3 -m py_compile` on the acceptance script, its non-Windows unsupported path (exit 2, zero native checks, new receipt fields present), a disposable control-flow check that the step label survives a propagating timeout and clears on success, and the four portable sibling suites (19 + 19 + 33 + 18 tests, all passing). The proof of the fix is the next `windows-latest` run; until it passes, checks 3 to 13 remain unrun on Windows.

## Remaining gates

1. Integrate the owned adapter with the existing signed review/proposal journal, native memory semantics and interoperable target locks. Include safe private directory/lock initialization, bounded inventory and confirmed cleanup/recovery. The foundation alone is insufficient to remove the hold.
2. Run actual Windows NTFS/ACL/sharing/identity checks, followed by process termination at every publication/journal/cleanup boundary. Verify blocked and changed destinations, denied access, pending deletion, disk exhaustion and restart reconciliation without duplicate effects.
3. Run the exact installed Windows helper and admitted Hermes Python/runtime together; then exercise Ask, native proposal, full human review, approval/rejection and recovery through the installed GUI. The prepared CI tests have not run here.
4. Preserve separate signing/distribution, real OS credential custody, two-computer office, provider/customer source and live Austin acceptance gates. No source, simulation or unsigned package receipt substitutes for these.

Any claim of power-loss durability also requires explicit device/storage evidence; process-crash tests alone are insufficient.
