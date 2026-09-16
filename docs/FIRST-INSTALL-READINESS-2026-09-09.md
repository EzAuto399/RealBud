# First installation: implementation and release checks

## Changed in this pass

First run now opens Bud setup over Ask. Closing it returns to the request being prepared. The existing sample-desk alternative remains available.

The install and repair endpoints use a verified, commit-pinned upstream bootstrap with selected runtime stages. They no longer refuse first installation because Python or Git is missing. The upstream bootstrap provisions supported prerequisites. Windows has a native PowerShell path; its availability no longer depends on a Unix shell command. This is implemented capability, not a claim of native Windows installation proof.

Setup has named progress, stop, explicit retry, automatic recovery of failed progress reads, and a 30-minute overall deadline. Downloading has a 60-second deadline, a 1 MB cap, no redirects and a checked SHA-256. The independent desktop app, gateway and interactive model wizard are excluded. PowerShell execution policy is respected.

The installation lock uses Node's built-in SQLite transaction so the OS releases it after a crash. A separate durable record tracks the installer process; retries hold while its process or POSIX process group remains alive. A corrupt record or an interruption in the tiny spawn-recording window requires support rather than guessing that nothing is running. Cancelling terminates the owned process tree. Normal server shutdown waits for cancellation. Removing the private setup is refused while installation is active.

An existing unowned runtime directory is preserved. Existing compatible installations keep their runtime and only receive the property profile. A partially installed RealBud-owned runtime must complete installation and version verification before its pending flag clears. Model connection and a successful private readiness check remain separate requirements. Pending installations cannot pass readiness or fetch property facts.

Installer output is drained without retaining raw paths, credentials or provider text. Product errors use bounded setup wording. Download integrity covers the installer scripts; this is not a hermetic audit of every dependency downloaded upstream.

## Evidence

- Production build passed, with the existing code-splitting/chunk-size warnings.
- Focused tests passed across download integrity, malformed downloads, cancellation, process termination, locking through verification, duplicate requests, retries, unknown installation preservation, pending readiness, API request guards, setup removal guards and environment paths. Windows-specific environment-path cases are skipped on macOS.
- The current Electron runtime successfully loaded SQLite and acquired a transaction lock. This proves that dependency is available in this runtime, not that the app has been packaged or installed again.
- `scripts/qa-first-install.mjs` passed against the production UI and an isolated local server: fresh onboarding → Ask setup → progress → failed progress read/recovery → stop → close/reopen → retry → model connection. The request survived. 320px and 390px layouts and touch targets passed without browser errors.
- Browser installation responses were fixtures. No real worker installation, provider login, mailbox call or outbound action was performed.
- Browser evidence: `outputs/first-install-2026-09-09/browser/result.json`, `setup-320.png`, `setup-390.png`. Typecheck and final targeted-test logs are in the same parent directory.
- Diff whitespace check passed for touched files. The repository-wide check also reported an existing trailing blank line in `src/lib/telegram-channel.test.ts`; that unrelated file was preserved.

## Required before a broad installation claim

| Gate | Pass condition | Current evidence |
| --- | --- | --- |
| Fresh Apple Silicon Mac | Download the actual signed/notarized DMG, launch from Applications without Git/Python prepared, complete any Apple system dialog, restart and retain setup | Not run in this pass |
| Fresh Windows PC | Signed installer, standard user, native setup, paths with spaces/non-ASCII names, restart and correct model connection | Native adapter implemented; installed proof and signing remain open |
| Linux / Intel Mac | Publish only supported architectures with their own clean-machine installation proof | No new proof in this pass |
| Interrupted setup | Quit, forced termination, sleep, network loss and low disk; no duplicate installer or false readiness; recover with data intact | Unit/process and browser fixtures passed; native interruption matrix open |
| Existing customer update | Preserve property book, drafts, connections and an independent Hermes installation through update and rollback | Preservation boundaries tested; packaged upgrade/rollback open |
| First property task | Add/import a property, correct rejected rows, prepare a useful sourced repair or owner-update draft, inspect it, close/reopen and find it | Full native customer journey still open |
| Office pilot | A PM independently completes a real task with authorised sources; document setup time, first useful result and each intervention | Not yet observed |

Apple may require its system installation dialog, and a managed office machine may block installation. Do not describe these environments as universally automatic. Record measured time to the first useful result; do not promise a ten-minute setup before the clean-machine and office-pilot gates pass.

Pinned upstream sources reviewed for the stage contract:
- https://raw.githubusercontent.com/NousResearch/hermes-agent/7339f5f160db5c96657a3bab60151227cc61f66c/scripts/install.sh
- https://raw.githubusercontent.com/NousResearch/hermes-agent/7339f5f160db5c96657a3bab60151227cc61f66c/scripts/install.ps1
