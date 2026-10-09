# Release 0.1.47, 9 October 2026

**This release does not establish:** a customer PC on 0.1.47, a Mac release, or a VM upgrade run. The proof is source, local tests and CI Windows packaging. The Auston Realty PC is the acceptance check.

## Why
On the Auston Realty office PC (Windows 11, 0.1.46), Connect this computer to your office refused a valid link code with "saved settings or private service storage need recovery", and nothing was logged. A read-only `Get-Acl` on the PC showed:

- `%USERPROFILE%\.realbud` was unprotected. Every grant (the account, SYSTEM, Administrators) was inherited.
- Every folder and file inside it was protected.

Electron accepts that root on purpose, because older installs made it that way. The service preflight's private write verified the root and refused it, and office-link hid the cause.

## What changed
- **Repair rule.** On Windows, an existing RealBud private folder or file is protected in place when its only fault is unprotected inheritance and its owner and every grant are already private (the account, SYSTEM or Administrators; no deny rule). This happens in `server/windows-file-privacy.ts` (`repair`) and `server/windows-private-admission.ts`.
  - Any other refusal (an extra grant, a deny rule, a shortcut, a helper failure) is returned before anything is written.
  - A file the operator chose, such as the entitlement bundle, is only checked, never repaired.
  - Launch still starts no ACL process for folders that already exist.
- **Office setup names the real cause.** When it is refused, the message names the store and the Windows reason, and `realbud.log` records the step and the `windows-acl` category, with no path.
- **Sync ACL worker fix.** The synchronous ACL host worker no longer inherits `-e`/`--input-type`. Under `node --input-type=module -e` it had failed to start, and its caller waited out the 120 s timeout. This was the long-standing `hermes-profile-windows` fresh-process timeout on `windows-latest`.
- **Every Windows build checks this.** `package-win.yml` now runs the Windows private-storage tests, including one that reproduces the Auston root, before it packages.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Real-Windows private storage (package-win run 37906869728, branch) | 5 files, 43 passed; both jobs green | CI Windows |
| Same step on unmodified main (run 37906012091) | fresh-process test timed out at about 62 s; the fix above resolves it | CI Windows |
| macOS full suite (HEAD 8fa0d92b) | 646 files, 10,507 passed, 0 failed, 327 skipped (environment-gated, not passes) | local tests |
| Independent review | ship-with-fixes; both medium findings fixed (bundle check-only; data-folder paths) | source |

## Customer steps
1. Install 0.1.47 on the Auston PC (auto-update, or realbud.app/download).
2. Open RealBud, then paste the link code and choose **Connect with this code**.
3. If it is still refused, the message now names the store and reason; send that text.

Same-day workaround, already offered: `icacls "$env:USERPROFILE\.realbud" /inheritance:d`. It is reversible with `/inheritance:e`.

## Also on 9 October
realbud.app website `0bc8d31` (PR EzAuto399/RealBud-website#40): an invited owner is signed into their account as soon as the office is set up, with no "isn't set up yet" dead end.
