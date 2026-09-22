# Windows profile setup acceptance

The profile fixture follow-up on 22 September 2026 changes tests only. It keeps
the production ACL policy, existing-data admission rules, and Windows memory
hold intact.

`server/testing/private-profile-fixture.ts` prepares disposable fixtures with
protected Windows ACLs before writing their content. New directories are
protected before creating descendants; existing objects are never ACL-repaired.
The affected pack, model attachment, runtime update, gate, lifecycle and shared
fake-Hermes fixtures now satisfy the same admission contract as fresh profiles.
Windows setup tests have a bounded two-minute per-test allowance; the ordinary
cross-platform timeout remains unchanged.

`server/hermes-profile-windows.test.ts` is discovered by the existing Windows CI
job. Its six native cases cover fresh profile creation, fictional credential
attachment/replacement, startup in a new Node process, inherited home/config
refusal, an explicit Users-read grant, and hardlink/junction refusal. An
independent PowerShell witness records owner/protected/grant booleans and SDDL
hashes. It checks unchanged file bytes and parent/file descriptors across restart
and rejection, without recording paths, SIDs, descriptors or credential content.
The production privacy verifier is not the sole policy witness.

Local macOS checks passed 137 tests; all six native Windows cases were skipped.
The cold-process source-import/preservation check also passed on macOS. These
results do not demonstrate Windows ACL behavior, NTFS publication semantics,
Hermes runtime installation, provider access, packaged-device acceptance, or
power-loss recovery. The runtime-update fixtures use a fictional installer and
version probe. The native Windows CI run remains required.

The service smoke now also verifies a newly absent disposable Hermes home. It
copies the selected artifact's property pack, checks the authenticated profile
status, compares shipped safeguard and skill bytes, and independently checks
file types, ownership and privacy. Windows uses a read-only protected-DACL
witness; POSIX uses the owner and mode. An explicit installed resources path
cannot fall back to the checkout's pack. The profile stays unconfigured, without
provider credentials or a ready worker.

The actual compiled macOS service passed this proof with seven private files and
six directories: startup took 451 ms and inspection took 8 ms. The focused harness
also rejects healthy services with missing, unsafe or incorrectly copied profiles.
This does not demonstrate Windows setup or a running Hermes model.

One performance gate remains:

- Installed-profile startup calls eight or nine synchronous PowerShell privacy
  checks before service readiness, and a fresh install performs additional
  creation checks; native Windows latency is unmeasured. The smoke retains its
  25-second child watchdog and the installer's 45-second outer bound. The profile
  API request is bounded at 10 seconds and its separate Windows ACL witness at
  15 seconds. None of these limits has been justified by a native Windows timing
  result yet.

Evidence and final file hashes are in
`outputs/hermes-windows-acceptance-2026-09-22/profile-fixture-verification.json`.
The compiled smoke result and its narrower test receipt are
`outputs/hermes-windows-acceptance-2026-09-22/compiled-private-profile-smoke.json`
and `outputs/hermes-windows-acceptance-2026-09-22/service-profile-verification.json`.

## 22 September 2026 — desk key custody, inventory cross-check, CI trigger

`electron/desk-key-custody.mjs` previously admitted key files with POSIX mode
and uid rules only, which are skipped on win32, and never applied the ACL policy
`server/private-json.ts` applies through `windowsFilePrivacySync`. The wrapped
desk key therefore landed on Windows with whatever its parent directory
inherited. It now applies the same policy: restrict on a key directory this
start creates and on `desk.key.wrap` (and any preserved recovery copy) before
key material is written, verify on both existing key files before they are read.
A directory this policy did not create is deliberately left alone, matching the
mode-755 accommodation in `server/ask-attach.ts` and this module's own POSIX
rules, so an install predating the change can still open its key; the key files
carry protected descriptors that do not depend on the parent's. Path, kind and
action are passed as environment variables,
never interpolated into PowerShell. Electron main loads plain `.mjs` from the
ASAR and cannot import the compiled server module, so the ACL script is
duplicated; `electron/desk-key-custody.test.mjs` fails if the two copies drift
apart by a single byte.

The helper is injectable, so the call sites, paths and restrict/verify actions
are proven on every OS. A win32-only case uses `profileAclWitness` to observe
the native descriptor of the key directory and the wrapped key. The ACL suite's
own fixture root in `server/windows-file-privacy.test.ts` is now canonicalized
with `realpath`, matching `server/testing/private-profile-fixture.ts`, because
the ancestor walk and reparse-point rejection read the literal path.

`electron/package-files.test.mjs` now reads the installed-resource inventory out
of `scripts/smoke-windows-package.mjs` and checks it against the
`extraResources` rules in `electron-builder.yml`: every asserted resource is
staged by exactly one rule, and every entry that is not build output still has a
checked-in source, including `server/windows-file-privacy.ts` and
`server/hermes-profile-storage.ts`. A renamed server module now fails on macOS
CI instead of only in a manual Windows run. `.github/workflows/package-win.yml`
also builds on every push to `main`, with a concurrency group that cancels
superseded runs and keeps dispatched release builds in their own group.

What is proven: the selector logic, the injected-helper wiring, the script
parity guard and the inventory cross-check all pass on macOS. What is not:
nothing here observes a real Windows ACL. The native descriptor on the key
directory and the wrapped key, and the packaged inventory actually existing in
an installed app, still require the Windows CI runner or a physical device. An
independent design review of this custody policy, the checks it asked for and
the runtime behaviour only NTFS can show is summarized in
`outputs/windows-key-custody-2026-09-22/review-summary.md`.

## 22 September 2026 — two Windows setup-path corrections (source-level only)

Two Windows-only defects in the worker setup path were fixed at source. (1)
`bootstrapInvocation` in `server/worker-bootstrap.ts` spawned the verified
upstream `install.ps1` with `powershell.exe -NoProfile -NonInteractive -File`
and no execution-policy argument; a default Windows 11 client policy is
`Restricted`, which refuses any `.ps1` passed to `-File`, so setup would have
failed before its first stage. The invocation now passes `-ExecutionPolicy
Bypass` as well. Bypass is process-scoped and changes no machine or user
policy, and it cannot widen what runs, because `downloadBootstrap` rejects the
installer on a sha256 mismatch before any spawn happens — that ordering is
unchanged and is asserted by the existing download test. (2) `preflight()` in
`server/hermes-bridge.ts` probed `curl`/`git`/`python3` and so reported a
missing dependency on every Windows machine, which does not ship a `python3`
executable; it had no caller outside its own test and has been removed rather
than made platform-correct. Both changes are proven only by macOS source tests
(`server/worker-bootstrap.test.ts`, `server/hermes-bridge.test.ts`) and the
server typecheck. Neither has been observed on a Windows runner or device, so
the Windows setup path remains unaccepted.

## 22 September 2026 — making the fresh-profile smoke fixture explain itself on Windows

Package Windows run 35712320927 (windows-latest) failed the fixture case
`installed Windows service acceptance > checks explicit fresh-profile smoke
boundaries: complete`, and the `public profile` case reported "Compiled service
exited before readiness" instead of its privacy refusal. The receipt could not
say why: it carried no exit status, and its `diagnostic` was empty.

One reported hypothesis was checked and is wrong. The fixture does not need
`dist-server`: `electron/service-smoke.test.mjs` writes its own miniature
`server/`, `shared/`, `src/` and `pack/property` tree into a scratch directory
and passes it to `scripts/smoke-company-bundle.mjs` as an explicit source, so
running the fixture step before `pnpm package:win` is correct and the workflow
step order is unchanged.

Two real defects were found by reading the child's failure path.
(1) On Windows, `exit` can be emitted before the stderr pipe has been read, and
the smoke wrote its receipt as soon as it saw the child gone — so exactly the
runs that most needed a diagnostic produced an empty one. The smoke now waits
(bounded, 2 s) for `stderr` to close, and records `child.exitCode`,
`child.signal` and `child.killedByWatchdog` on every run, pass or fail. The
`diagnostic` is now the last 20 non-empty stderr lines with credential-shaped
values masked; the script runs from an installed package, where the compiled
server's `redactSecretsInText` is not importable, so it uses a conservative
prefix/Bearer/key-value matcher and no generic hex or base64 heuristic.
(2) The fixture's own ACL preparation shells out to `powershell.exe`, and the
first PowerShell of a CI job is cold. Its 15 s bound and the smoke's 25 s
readiness watchdog are plausible causes of a silent early exit. On win32 the
fixture's PowerShell bound is now 60 s and the smoke's readiness window is
120 s, passed as `REALBUD_SMOKE_READY_MS` and clamped to [5 s, 180 s] by the
script. The default stays 25 s, so the installed probe in
`scripts/test-windows-installer.ps1` keeps its existing 45 s budget.
`scripts/service-smoke-env.mjs` now also pins `PSModulePath` to
`%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules` (and forwards
`SystemDrive`), so the deliberately stripped child environment cannot lose
`Get-Acl`/`Set-Acl` and cannot borrow a developer's module path either.

No privacy assertion was weakened: the independent read-only ACL witness, the
`public profile` refusal and the POSIX owner/mode checks are unchanged. What is
proven: all 10 cases pass on macOS (`pnpm exec vitest run
electron/service-smoke.test.mjs`) and `pnpm check:electron` is clean. What is
not proven: nothing here has run on win32. If the cold-PowerShell theory is
wrong, the next Windows run is now able to say so, because the receipt carries
the child's exit status and its redacted stderr.

## 22 September 2026 — one PowerShell process for an ordered list of admissions

Follow-on to the cold-PowerShell finding above. The cost is per process, not per
path, and every admission was its own `powershell.exe`: provisioning one Hermes
profile runs well over a dozen. `server/windows-file-privacy.ts` now exports
`windowsFilePrivacyBatchSync(operations)`, which applies an ordered list in a
single process. Each operation still arrives by environment variable and is read
by name inside the script — `REALBUD_WINDOWS_FILE_PRIVACY_{PATH,KIND,ACTION}`
for the first, the same names suffixed `_1`, `_2`, … after it, with
`REALBUD_WINDOWS_FILE_PRIVACY_COUNT` giving the length. Nothing is interpolated.
The list stops at the first refusal, so nothing after a failure is applied, and
the failure keeps today's numeric exit code; the script echoes the integer index
it attempted (and nothing else) so the error can name the operation.
`windowsFilePrivacySync` is now a one-operation batch, and a one-operation batch
is the same invocation and the same environment as before — which is why
`electron/desk-key-custody.mjs` needed only the byte-identical script copy, not
a change to its call.

How far this actually goes. Batching is only safe where one admission does not
gate the next. In `server/hermes-profile-storage.ts` that is the pair at the top
of `writeProfileFile`: the destination directory and the file already published
there are both verify-only, so they now share one process — five admissions in
four launches when replacing a file. Two sequences were deliberately left alone.
`ensureProfileDirectory` still protects each newly created directory before
creating anything inside it, so its restricts cannot be collected. In
`writeProfileFile`, the stage's restrict must return before any byte is written
and the published verify can only run after the rename. A first publication
therefore still costs three launches, so this does **not** on its own bring a
cold first run inside the installed probe's 25 s or the installer smoke's 45 s.

The remaining lever is a profile-scoped batch across the call sites in
`server/hermes-pack.ts` — in particular `prepareProfile`'s three consecutive
`ensureProfileDirectory` calls and its five consecutive `readProfileFile` calls,
which are independent of each other and would collapse to two processes. That
file was out of scope here.

Proven: `pnpm exec vitest run server/windows-file-privacy.test.ts
server/windows-file-privacy-sync.test.ts
server/windows-file-privacy-diagnostics.test.ts
server/hermes-profile-storage.test.ts server/hermes-profile-windows.test.ts
electron/desk-key-custody.test.mjs` passes on macOS, `pnpm exec tsc -p
tsconfig.server.json` and `pnpm check:electron` are clean, and the parity test
still holds the two script copies byte-identical. Not proven: no PowerShell runs
on the macOS host, so the batch script has never been parsed or executed. The
loop, the `_i` lookup and the echoed index are unverified until a win32 run; the
native suites in `server/windows-file-privacy.test.ts` and
`server/hermes-profile-windows.test.ts` are the ones that will say so.

Follow-up, same day: run 35713565138 carried the fixes above and reduced the
failure to the single `complete` case (9/10 pass, 60.5 s), but vitest printed
only `expect(receipt.passed).toBe(true)` — the receipt was honest and the
assertion was not. Every assertion in that case now carries the receipt's
`failure`, `child`, `timings`, `powershell` and redacted `diagnostic` as its
message, and the receipt additionally records `timings.readinessMs` (wall time
from spawn to readiness, recorded even when readiness never arrives) and
`powershell` — the compiled service's own launch count and elapsed time,
reported on stderr after every launch including failed ones, alongside this
script's ACL witness count. The launch counts are reported, not asserted, so a
truncated stderr cannot invent a second failure. macOS: 10/10 pass.

## 22 September 2026 — the profile-scoped batch: 8 launches to 3 at startup

Takes the lever the section above left open. `server/hermes-profile-storage.ts`
adds two batch-capable entry points and `server/hermes-pack.ts` calls them.

`ensureProfileDirectories(paths)` admits every directory in the list that
already exists first, together, in one process — before anything is created
inside any of them, so a foreign or unprotected root still refuses with no
descendant on disk. Only the root of a chain whose parent this call has not
admitted keeps its own protect-before-create process. A directory created
inside a directory the same call has already admitted is private from birth:
on Windows it inherits the admitted root's protected DACL, on POSIX it is
created 0700. Those restricts therefore no longer gate each other and share one
process. This is the one place the per-level "protect before create" rule is
relaxed, and only underneath a root this call has just proven protected.
Inheritance is not protection — an inherited descriptor has
`AreAccessRulesProtected` false and our own verifier refuses it (exit 5) — so
every created directory is still restricted before the call returns.
`ensureProfileDirectory(path)` is unchanged: one path, one level at a time.

`readProfileFiles(paths)` admits the files in the list that exist in one
process, then opens and reads each one only after its own admission has
returned. A missing file is still a missing leaf under verified ancestry, never
an empty one. Both entry points split a list longer than the script's 64-
operation cap across processes rather than being refused.

`prepareProfile` now uses both (three `ensureProfileDirectory` calls and five
`readProfileFile` calls become two processes), `prepareSkillCopies` plans the
source tree first and then admits its destination directories and reads its
destination files in two processes, and `applyPropertyPack` takes `config.yaml`
from `prepareProfile` instead of admitting and reading it a second time.

Launch counts, measured with the injected runner in
`server/hermes-profile-storage.test.ts` (`launches` = cold `powershell.exe`
processes, `admissions` = admitted paths), at HEAD `d66c669c` and after:

| path | before | after |
| --- | --- | --- |
| fresh `applyPropertyPack` | 27 launches / 27 admissions | 25 / 27 |
| re-apply (Repair) | 30 / 34 | 21 / 33 |
| installed-profile startup (`ensurePropertyPack`) | 8 / 8 | 3 / 8 |

The startup path the installed probe's 25-second readiness budget actually
waits on drops from eight cold launches to three. A fresh install barely moves,
and this says so: 18 of its 25 launches are the six first publications in
`writeProfileFile`, where the stage's restrict must return before any byte is
written and the published verify can only run after the rename. No admitted
path, kind or action changed; the single admission that went away is the
duplicate `config.yaml` read. Startup admissions are eight here because the
fixture profile has no `.env`; with stored credentials it is the nine the
earlier section quoted.

Proven: `pnpm exec vitest run server/hermes-pack.test.ts
server/hermes-profile-storage.test.ts server/hermes-profile-windows.test.ts
server/windows-file-privacy.test.ts` passes on macOS (43 passed, 14 skipped),
all 22 `server/hermes-*.test.ts` suites pass (369 passed, 49 skipped), and
`pnpm exec tsc -p tsconfig.server.json` is clean. The before column was
measured by running the same counting test against a disposable worktree at
`d66c669c`. Not proven: no PowerShell ran on this macOS host. The inheritance
claim the directory batch rests on is asserted natively in
`server/hermes-profile-windows.test.ts` — a directory created under a protected
root is witnessed as owner-only and deny-free but unprotected, is refused by
the production verifier until it is restricted, and ends protected after
`ensureProfileDirectories` — and that case, like the existing inherited-home
refusal that now exercises the new existing-root admission, only runs on win32.
