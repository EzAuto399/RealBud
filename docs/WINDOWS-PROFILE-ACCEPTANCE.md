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

## 22 September 2026 — the batched publication: a fresh apply from 25 launches to 7

Takes the last lever the section above named: the six first publications that
were eighteen of a fresh apply's twenty-five launches, three each.

`writeProfileFiles(entries)` in `server/hermes-profile-storage.ts` publishes a
whole set of files in three PowerShell processes instead of three per file, by
running each step of `writeProfileFile` across the whole list before the next
step starts:

1. every destination directory, and every file already published in one of
   them, is admitted in **one** process — none gates another, all gate what
   follows — and each is settled against its own before/after stat bracket;
2. every stage is created empty (0-byte, `O_EXCL`) in its admitted directory,
   and all of them are restricted in **one** process;
3. only then is any byte written, each into its own already-restricted stage
   and fsynced;
4. every destination is re-read once more for drift, then each temp is
   published — `linkSync`+`unlinkSync` for a first publication, `renameSync`
   for a replacement, exactly as before;
5. every published path is verified in **one** process, and only then is
   anything reported published.

A list longer than the script's 64-operation cap splits into chunks within its
phase, so the phase ordering holds at any length. `writeProfileFile` is now a
one-entry call of this and is byte-for-byte the same sequence of admissions,
in the same processes, as it was before — which is why the existing per-write
cases did not change.

Per-file honesty. The call returns a `ProfileWriteOutcome` per entry, and a
thrown error carries the same list as `profileWriteOutcomes`, so a refusal is
never read as "nothing happened". The states are `published` (renamed **and**
verified), `renamed-unverified`, `staged` and `absent`. `renamed-unverified` is
the one new state and it is deliberate: because step 5 is a single batch,
a refusal there leaves the whole set at its destinations with none of them
verified, and the call reports exactly that rather than claiming any of them.
`writeProfileFile` has always had this window for its single file; batching
widens it to the set. The drift re-check in step 4 is likewise now taken for
the whole set before the first rename, so the window between one entry's drift
read and its own rename includes the earlier entries' renames. A competing
*first* creation is still refused by `linkSync`, and every publication is still
followed by `same(created, published)` and a size check.

`server/hermes-pack.ts` uses it for the pack's file set: `applyPropertyPack`
collects `auth.json` (from `pendingRootAuth`, which replaces the write inside
`ensurePrivateRootAuth`), the four profile files and every skill copy into one
`writeProfileFiles` call. Their directories are already admitted by
`prepareProfile`/`prepareSkillCopies` and their existing bytes already read, so
the ordering holds. Single writes — `applyManagedModelProfile`,
`removeManagedEnvKey`, the bridge's attach — keep `writeProfileFile`.

Launch counts, measured with the same injected runner in
`server/hermes-profile-storage.test.ts`, at HEAD `a77cb4a1` and after:

| path | before | after |
| --- | --- | --- |
| fresh `applyPropertyPack` | 25 launches / 27 admissions | 7 / 24 |
| re-apply (Repair) | 21 / 33 | 9 / 30 |
| installed-profile startup (`ensurePropertyPack`) | 3 / 8 | 3 / 8 |

A fresh apply's seven launches are: two for the profile directory chain, two
for the skills chain, then the three this change is about — one admitting the
four distinct destination directories, one restricting all seven stages, one
verifying all seven published files. The three admissions that went away are
duplicate destination-directory verifies: the same directory was verified once
per file and is now verified once per set. No other path, kind or action
changed, and startup — the path the installed probe's 25-second readiness
budget waits on — is untouched at three.

Proven: `pnpm exec vitest run server/hermes-pack.test.ts
server/hermes-profile-storage.test.ts server/hermes-profile-windows.test.ts
server/windows-file-privacy.test.ts` passes on macOS (47 passed, 14 skipped),
all 22 `server/hermes-*.test.ts` suites pass (373 passed, 50 skipped), and
`pnpm exec tsc -p tsconfig.server.json` is clean. Four new cases cover the
three-process shape with a "no destination exists while any stage is empty"
witness on every restrict, a verification batch that refuses (both files at
their destinations, neither reported published), a stage restrict that refuses
(no destination and no stage left behind, every entry `absent`), and a
no-clobber entry that refuses before any stage in the set is created.

Not proven: no PowerShell ran on this macOS host, so the seven-operation
restrict and verify batches have never been parsed or executed. The win32-only
case added to `server/hermes-profile-windows.test.ts` — three files published
by one `writeProfileFiles` call, each witnessed protected, owner-only and
deny-free, then the same set refused on one users-readable destination with no
stage left behind and the other two files and their descriptors unchanged — is
the one that will say so, alongside the existing fresh-install case that now
drives a seven-operation batch natively.

## 22 September 2026 — the ACL witness names the rule it refused on

The Package Windows run for `661534f5` reached readiness in 35.5 s with one
service PowerShell launch, then spent 22.7 s in the smoke's own ACL witness and
reported `Fresh profile Windows privacy verification failed` with nothing else.
Two defects, both in `scripts/smoke-company-bundle.mjs`: the witness used a
single `exit 1` for every rule, and the `catch` around `execute(...)` discarded
the child's outcome entirely. A run could not say whether a profile was
actually public or the runner's `D:\a\...` layout had tripped a rule that is
not about the profile at all.

The witness now exits with a code per rule, mirroring
`server/windows-file-privacy.ts` where the rule is the same — 2 owner, 3 ACE
principal, 4 no usable grant, 5 not protected, 6 reparse point, 7 kind
mismatch, 9 bad input, 10 deny — and adds 8 missing, 11 reparse point in an
ancestor above the disposable root, 12 unprotected ancestor above it. (8 is the
one deliberate divergence: the verifier spends 8 on `ancestor-reparse-point`,
which the witness reports as 6 inside the bound and 11 above it.) 20-26 remain
the verifier's inspection stages. On a refusal the witness writes one compact
JSON line — `{ code, rule, index, depth }`, integers and a fixed rule name, no
path, SID or descriptor, and never the native exception text — and on success
still writes exactly `private`.

The ancestor walk is now bounded to the disposable root that contains the
profile tree, inclusive; it no longer climbs to `D:\` or `C:\Users`. The
product verifier has its own ancestor policy and refuses junctions on its own
paths, so the witness checking the host's layout proved nothing and could only
produce false refusals. `REALBUD_SMOKE_WITNESS_FULL_ANCESTRY=1` keeps the
stricter walk available; above the disposable root it applies rules 11 and 12,
and on a hosted runner it is expected to refuse, which is why it is off by
default.

Every run's receipt now carries `witness: { exitCode, signal, code, rule,
index, depth, stderrTail }` — `stderrTail` redacted through the existing
secret masking and bounded to 10 lines — or `witness: null` when no witness ran
(not win32, or the probe failed earlier). The thrown message carries the code
and rule, and a non-`private` stdout still fails the scenario as before.

Proven: `pnpm exec vitest run electron/service-smoke.test.mjs` passes on macOS
(10 passed), `node --check scripts/smoke-company-bundle.mjs` is clean. The test
now asserts `witness` is present on every receipt and `null` off win32, and its
`why` message carries `witness`, so a Windows failure explains itself without a
debugger. Two win32-only assertions are added and have not run: the `complete`
scenario must report `exitCode 0, code null`, and `public profile` — whose
fixture adds a Users (`S-1-5-32-545`) read ACE — must report code 3
`grant-not-allowed` at depth 0.

Not proven: no PowerShell exists on this macOS host, so the rewritten witness
script has never been parsed or executed. Its refusal codes, the JSON line, the
bounded walk and the `REALBUD_SMOKE_WITNESS_FULL_ANCESTRY` path are all
source-level only until a win32 Package run exercises them. A green macOS suite
is not Windows privacy evidence.

## 22 September 2026 — the witness's "missing" is now separable from unreadable

Package Windows run 35718088869 (`6ca6bf22`) reached readiness in 51 s with one
service PowerShell launch, then the ACL witness refused
`{ code: 8, rule: "missing", index: 0, depth: 0 }` in both scenarios that reach
it and assert on it — `complete` and `public profile`. Index 0 is the private
Hermes home itself (`REALBUD_HERMES_HOME`, i.e. `<data>\hermes`).

That refusal cannot be taken at face value, and the source says why. These two
scenarios are `electron/service-smoke.test.mjs` fixtures: the fake server
creates the very objects the smoke then lists (`home`, `profiles`,
`profiles\property`, the two skills directories, `auth.json` and the five
profile files), and `inspectProfile` **already `lstat`s every one of them
successfully** before the win32 branch runs. No product code is involved, so
the win32 layout is not in question here: `hermesHome` prefers
`REALBUD_HERMES_HOME` on every platform, `hermesProfileFor` returns the plain
base profile with no member key, and `applyPropertyPack` publishes the same set
on win32 as on POSIX. The mismatch is inside the witness, not in the profile.

The witness's own `[IO.Directory]::Exists($path) -or [IO.File]::Exists($path)`
pre-check was the defect: both answer `false` for *every* failure — a genuine
absence, a path past `MAX_PATH`, a denied attribute query, an argument the
legacy .NET Framework normalizer rejects — so one code, 8, covered all of them
and a path this host had just stat'd was reported as absent. It now reads
`[IO.File]::GetAttributes($path)` (which the next line needed anyway), unwraps
the thrown exception and gives the reason its own code: 8 `missing` for
directory/file-not-found only, 13 `path-too-long`, 14
`attributes-access-denied`, 15 `target-attributes-unreadable`. The refusal line
gains `chars`, the length of the path under inspection — an integer, never the
path — so a truncated or mangled `REALBUD_SMOKE_PRIVATE_PATHS` delivery is
separable from a path PowerShell received intact but could not read.

Every receipt now also carries, from this host and before any witness runs,
`objects: [{ name, kind, exists, chars }]` for the whole list and `layout:
{ home, profile }` — relative names inside the private home only, never an
absolute path, since an absolute path carries the runner's account and
workspace. An object this host cannot stat fails the scenario immediately,
naming the relative object and the layout actually found, instead of failing
later inside PowerShell. The thrown Windows message now names the refused
object relatively and prints both character counts.

Proven on macOS: `pnpm exec vitest run electron/service-smoke.test.mjs` passes
(10 passed) and `node --check scripts/smoke-company-bundle.mjs` is clean. The
new diagnostic is genuinely exercised here, not just compiled: `health without
profile` now fails with `Fresh profile is missing directory "." (11 of 11
objects absent)` and a layout of `«unreadable: ENOENT»`, and the four scenarios
that do reach inspection assert the exact eleven relative names, kinds and
`exists: true`.

Not proven: no PowerShell exists on this host, so codes 13, 14 and 15, the
`chars` field and the `GetAttributes` unwrap have never been parsed or
executed. The next Package Windows run settles which of the remaining
hypotheses holds — `exists: true` here with code 8 there would mean PowerShell
received a different string (compare `chars`), 13/14/15 would name the real
inspection failure, and `exists: false` here with the printed layout would mean
the fixture never created the object at all.

## 22 September 2026 — the witness gets its paths one variable per field

The Package Windows run answered the previous entry's question, and none of the
three hypotheses was right. Every object was `exists: true` on the runner, the
first one 89 characters — yet the witness refused item 0 with code 15,
`target-attributes-unreadable`, and `chars: 11`. Eleven is the number of
objects, not the length of any path.

That identifies the fault exactly. Windows PowerShell 5.1 unwraps the array
`ConvertFrom-Json` returns when it is piped through `@()`, so `$items[0]` was
the whole eleven-object collection rather than the first object. `.path` on a
collection is member enumeration, so `$path` became an array of eleven strings:
`$path.Length` reported the array's length (11, the `chars` seen), and
`[IO.File]::GetAttributes($path)` could not cast an array to a string and threw
an exception the `switch` did not name — code 15. The profile was private the
whole time; the delivery was the defect, as the new `chars` field was added to
detect.

The JSON delivery is gone. The witness now reads `REALBUD_SMOKE_PRIVATE_COUNT`
and, per object `i`, `REALBUD_SMOKE_PRIVATE_PATH_<i>` and
`REALBUD_SMOKE_PRIVATE_KIND_<i>`, by name through
`[System.Environment]::GetEnvironmentVariable` — the same one-variable-per-
field-per-operation pattern `server/windows-file-privacy.ts` has already proven
on this host, and which has no collection for PowerShell to reshape. The count
is validated against `^([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-6])$`
(1–256, the smoke's existing inventory bound), the kind must be exactly
`directory` or `file`, and an empty path still refuses 9 `invalid-invocation`.
Nothing is interpolated into the script. The disposable root stays in
`REALBUD_SMOKE_PRIVATE_ROOT`.

`$size` is now unambiguously a string length, so the receipt's comparison means
what it says: `profileObjects[i].chars` is what this host sent for object `i`
and the refusal line's `chars` is what PowerShell read. The Node side also
asserts the count is within 1–256 and each path is a non-empty NUL-free string
before launching, so a malformed inventory fails here with a relative name
rather than as an opaque PowerShell refusal. All rule codes, the refusal JSON
line and every receipt field are unchanged.

Proven on macOS: `pnpm exec vitest run electron/service-smoke.test.mjs` passes
(10 passed), `node --check scripts/smoke-company-bundle.mjs` is clean, and
`pnpm check:electron` reports 21 of 21 modules ok. The rendered witness source
was extracted from the template literal and confirmed to contain no
`ConvertFrom-Json` and no `REALBUD_SMOKE_PRIVATE_PATHS` outside a comment.

Not proven: there is still no PowerShell on this macOS host, so the new
`GetEnvironmentVariable` reads, the count regex and codes 13, 14 and 15 remain
unexecuted. Only a Package Windows run settles whether the witness now reaches
the ACL checks. The same `@(... | ConvertFrom-Json)` shape survives in
`PRIVATE_FIXTURE_SCRIPT` in `electron/service-smoke.test.mjs`; it was not
touched here because no run has shown it failing, but it carries the same
PowerShell 5.1 hazard and should be converted before it is trusted.
