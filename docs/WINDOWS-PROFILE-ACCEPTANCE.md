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
