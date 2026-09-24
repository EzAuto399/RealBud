# RealBud handoff — Windows QA candidate (24 September 2026)

**Status:** Windows x64 installed-desktop and pinned Bud setup checks pass in disposable CI. The separate Windows 11 ARM VM runs the x64 RealBud app under emulation and has passed welcome, desktop close/reopen persistence, and a fictional Desk check. The VM has **not** passed private backup export/restore or Bud installation. This is a QA candidate, not a release or customer acceptance.

## Product scope and proof boundary

RealBud is a standalone business work OS for a solo user and an office with department-scoped shared work. Hermes/Bud runs behind its governed interface. Customer workflow packs extend the core; Austin Realty is the first case. Its bank CSV/reference review currently ends in a reviewed CSV handoff; REI Cloud recognition/import/posting is not verified. The Gmail bill recurrence-to-calendar and daily ranked follow-up workflows have source and local foundations, but account-linked reconciliation and scheduled end-to-end acceptance remain open. Keep local tests, packaged/installed behavior, live integrations, and customer acceptance as separate claims.

The service-admin credential and managed provider/Composio keys are vendor-controlled; customer workspace settings and department tabs do not grant that authority. Do not put credentials, recovery keys, raw service logs, or customer records into Git or PR text.

## Branch and changes ready for review

- Clean branch: `origin/qa/windows-late-service-2026-09-24`, tested source SHA `884bacf0669495bc22636872dd28b2698625d97e` before this handoff commit. `origin/wave/2026-09-22` at `e82ea2f0` is an ancestor; the QA branch is 34 commits ahead. A direct comparison to `origin/main` spans 130 commits and 8,728 changed paths, so choose the intended integration base deliberately. No PR has been opened for this QA branch.
- `67d51881` recovers a waiting/error desktop window when the local service becomes healthy late and captures detached-service startup output for diagnosis.
- `b8c605a2` adds an installed Windows GUI acceptance check to the NSIS CI job; `cd4a1480` preserves a test-sensitive workflow step label.
- `884bacf0` bounds the full welcome finish path, including session setup, to 15 seconds and exposes a retryable error. Focused onboarding tests passed 14/14 in the clean branch and canonical tree; `tsc -b` and `git diff --check` passed in the clean branch.

The canonical `/Users/yoda/projects/RealBud` checkout is the dirty `wave/2026-09-22` tree with roughly 213 changed/untracked paths. Its Windows lab document and JSON receipt were updated locally, and its onboarding fix was applied, but this handoff deliberately commits only the isolated QA branch. Preserve unrelated edits; do not blanket-stage or overwrite that tree.

## Exact Windows evidence

- [Package Windows run 36002050162](https://github.com/EzAuto399/RealBud/actions/runs/36002050162) finished **success** on attempt 2 at `884bacf0`. The native Windows x64 NSIS job installed the app (exit 0), observed its desktop window and ready renderer, then uninstalled it (exit 0). All six linked installed receipts were hash-checked after download.
- The separate managed Windows runtime job first hit HTTP 429 downloading verified Bud setup. One failed-job retry returned HTTP 200 and passed the pinned setup plus **28/28** native Windows journal checks. Its runtime commit was `345cd2b057a452236de401d3534b8502a7465e8d`. This runner result does not mean Bud is installed in the VM.
- Verified installer: `/Volumes/RealBud-TestLab/candidates/windows-gui-ci-36002050162/installer/RealBud-0.1.19-setup.exe`, **161,207,435 bytes**, SHA-256 `5962d9f215facc3999d517519ed7611833f65f0e1fc088dcfe6686f837a9425b`. Downloaded receipts are beside it in `proof/` and `managed-proof-attempt2/`.
- The ARM VM `RealBud-Win11-Arm-QA` on `/Volumes/RealBud-TestLab` has the earlier verified `67d51881` installer, not the new `884bacf0` one. Its actual installed GUI completed fictional welcome, reached Ask/You, survived closing and reopening the app window into saved Desk, and ran a fictional sample morning: six addresses checked, two need human review, one needs a licensee, three items in Needs you. The detached service was not deliberately restarted. The guest display is 800×600 and clips the desktop's right edge; disk activity was 97–100% during difficult checks.
- In that VM, a private backup export reached a persisted `capturing` operation, then `failed` with the broad UI message “Finish the current work before continuing this backup operation.” The failed operation remained visible after GUI restart. No encrypted file was observed, so backup/restore is **failed/open**, not accepted. The visible message maps multiple asynchronous HTTP 409 causes; high disk activity does not identify which. The UI's Stop waiting control only ended renderer polling and did not cancel the saved server operation.

## Next bounded work for Claude

1. Review the 34-commit QA delta against the intended base and merge or cherry-pick only after checking the 183-path `wave..QA` diff. Preserve the canonical dirty tree. Keep PR title/body tied to actual installed Windows behavior and proof boundaries.
2. Diagnose the VM backup's exact 409 at the service log (`%APPDATA%\RealBud\logs\office-service\stdout-stderr.log`) or with the existing `REALBUD_TEST_LAB=1` code-location diagnostic in a disposable rerun. Extract only safe phase/status/source locations; do not publish raw logs. Retry the saved failed operation once only after the cause and guest resource state are known.
3. If testing Bud in the VM, provision/sign in with a separate service-admin credential and use **You → Service → Service administration → Install Bud**. The ordinary Bud card is read-only. The pinned Windows installer script is checked by SHA-256 before execution; then workroom/model connection and an actual model readiness request are separate gates. A Windows login password is not the service-admin credential.
4. Keep VM app/service restart, successful encrypted backup plus restore on a fresh fictional workspace, office joining, normal performance under settled guest I/O, live integrations, and customer acceptance open until separately observed.

Detailed local lab log: `/Users/yoda/projects/RealBud/docs/EXTERNAL-TEST-LAB-2026-09-24.md`. Structured local resume receipt: `/Users/yoda/projects/RealBud/outputs/external-test-lab-2026-09-24/windows-resume.json`. These are local working-tree evidence, not part of this QA commit.

## Follow-up 25 September 2026: backup export diagnosis (branch `claude/windows-backup-fixes`)

This is source and local-test evidence only. It does not show that a Windows VM export now succeeds.

- The failed task now always writes one `Private backup failure {…}` line to the service log. The line includes the operation kind, phase, status, public code, a fixed `reason`, and up to eight `<basename>:<line>` source locations. It matches `.ts` and compiled `.js` files, with `/` or `\` separators, under `server/` or `shared/`. Message lines are skipped, including multi-line messages. The line never includes message text, paths, user file names or secrets; the only file names are RealBud source basenames. A pause that ends is reported from the step that noticed it (capture or drain), not from the timer. The old regex only matched `server/*.ts`, so compiled Windows stacks produced no locations.
- These `workspace-busy` sources now carry fixed codes:
  - named busy work (`bud-replying`, `mail-collection`, `desk-check`, `website-request`, `department-work`, `job-running`, `batch-running`, `routine-running`, `bud-setup`, `workspace-change`)
  - restore or restart hold (`restore-or-restart`)
  - request-drain timeout (`requests-draining`). The drain deadline now starts before the pause and is checked first, so a drain that uses the whole budget is not reported as a slow copy.
  - pause end (`private_snapshot_interrupted`, detailed as `timeout`, `queue-full` or `stopped`)
  - changed during copy (`changed-during-copy`)
  - leftover SQLite sidecar (`database-journal`)
- The saved journal still stores only `error: {code}`. Earlier services parse exactly that key, so persisting a reason would make them hold every saved operation for recovery. The reason stays in the running service's memory. Settings shows it as one sentence until the service restarts; after a restart, the generic message returns.
- The export pause and request-drain budgets rose from 60 s to 120 s. That is the maximum `WorkspaceActivityGate.pause` accepts. The reason is that capture runs one PowerShell ACL check per source file and folder, and does it twice. No privacy check was removed, batched or skipped.
- After **Stop waiting on this screen**, the selected running backup offers **Cancel this backup**. It uses the existing server cancel. It first re-reads the operation, and does not remove a backup that finished in the meantime. If the server refuses, a restore or recovery hold is kept. If the reply is lost, the saved operation is read again before anything is reported.

Local tests ran on macOS arm64 with Node 24.19.0. `pnpm typecheck` passed. Every `server/private-backup*` suite, the workspace-activity suite, and the touched renderer suites gave **563 passed / 0 failed / 0 skipped** across 35 files. Logs: `outputs/windows-backup-fixes-2026-09-25/vitest.log` and `typecheck.log`. Windows-only ACL paths are not exercised on macOS.

Still open (these need a Windows VM run):
- Whether 120 s is enough on the ARM VM.
- Which reason the VM actually reports.

## Support: provisioning the service administrator on Windows

The RealBud service administrator password is **not** the Windows sign-in password. RealBud support creates it for each installation. Customer settings, company membership and the Windows account do not grant it.

1. The service reads `service-admin.json` from the RealBud data directory. `REALBUD_SERVICE_ADMIN_FILE` overrides that location. On Windows, the desktop's data directory is `%USERPROFILE%\.realbud` unless `REALBUD_DATA_DIR` is set.
2. Run `scripts/provision-service-admin.mjs` from a trusted source checkout at the installed revision, using Node 24 or later. The installed app does not ship this script. Run it as the same Windows user that runs RealBud, not as a different administrator account. In PowerShell:
   `node scripts\provision-service-admin.mjs --data-dir "$env:USERPROFILE\.realbud"`
   Enter and confirm the password at the hidden prompt. Alternatively, add `--generate-password-file <absolute path outside .realbud>`, move the generated password into the support password manager, and delete the file. To replace an existing credential, add `--rotate`.
3. The script applies and checks Windows ACLs through environment-passed PowerShell. New files are restricted to the current user and SYSTEM. It refuses a data directory or file whose owner or allow rules include anyone other than the current user, SYSTEM or the local Administrators group. It writes the verifier atomically. The script never prints a password or verifier, and never accepts one as an argument or environment variable.
4. No restart is needed. The service re-reads the policy on every administrator status check, and **You → Service → Administrator access** refreshes every 30 s. Sign in there, then use **Service administration**.

Never put the password in chat, tickets, PR text, screenshots or logs. This procedure has not yet been run on the ARM VM.
