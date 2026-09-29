# Next Mac run: one ordered sheet

25 September 2026. This sheet covers one fresh macOS run in a separate test account, end to end:
- build and notarize RealBud, install it, and link the computer to the office on realbud.app;
- deliver its Modelvia key and Composio connector, and install Bud;
- ask Bud a question, check permissions, connect Gmail, scan mail into bills, and test a backup.

It records the steps. It does not prove any of them. After each step, record what was actually seen:
- `pass`: the check below was seen to pass;
- `fail`: record the exact message;
- `blocked`: record what blocked it;
- `not run`.

Evidence tiers stay separate: CI proves source, `pnpm package:mac` and its smoke prove the package, notarization proves distribution, and only this run proves the installed device and live integration.

Run the steps in order. Every step depends on the ones before it.

## A and B. Hosted setup and office setup

Do sections A and B of the [Windows sheet](NEXT-WINDOWS-RUN-2026-09-25.md) once; they are shared. If they are already done for this office, record that and start at step 11.

## C. The Mac (installed-device proof)

The Mac must be Apple Silicon with macOS 13 or later. Record `sw_vers -productVersion` and `uname -m` (it must print `arm64`).

11. **Build the candidate from main** (owner, in the owner's own account). Use a clean checkout of the merged main commit (5d162956 or later). The build needs the RealBud Developer ID identity in the owner's Keychain.
    ```bash
    pnpm install --frozen-lockfile
    pnpm package:mac
    codesign --verify --deep --strict --verbose=2 release/mac-arm64/RealBud.app
    pnpm smoke:mac
    ```
    - Check: signature verification and the smoke both pass.
    - Record `git rev-parse HEAD` and `git status --short`. A dirty tree is recorded, not attributed to HEAD.
12. **Notarize** (owner). Apple rejected the saved `realbud-notary` profile with HTTP 401 on 23 September. Run `pnpm notary:store` in your own Terminal first, and enter the app-specific password only at its prompt. Then:
    ```bash
    pnpm package:mac:notarize
    pnpm smoke:mac
    shasum -a 256 release/*.dmg release/*.zip
    ```
    - Check: `xcrun stapler validate release/RealBud-<version>.dmg` succeeds.
    - Write the hashes, HEAD and notarization result into the receipt.
    - If notarization fails or is not run, record distribution as `blocked` with the exact error line. The rest of this sheet can then continue only as a local signed build, not as distribution proof.
13. **Install in a separate macOS test account.**
    - `/Applications` is shared by every account on this Mac. The RealBud 0.1.18 there is the owner's personal install. Do not remove or replace it. Removing an app from `/Applications` removes it for every account, so only uninstall an old copy there on a dedicated test Mac.
    - Copy the DMG to `/Users/Shared`. Sign in as the test account and compare `shasum -a 256` with the receipt. Stop if they differ.
    - Open the DMG in Finder and drag RealBud into the test account's own `~/Applications` folder. Open it from there in Finder.
    - Never remove quarantine, never disable Gatekeeper, and never use "Open Anyway". If macOS blocks opening, stop and record the exact message.
    - Check: `ps -axo user,command | grep '[R]ealBud.app/Contents/MacOS'` shows the test account's `~/Applications` copy, not `/Applications`.
    - Check: welcome completes.
14. **Service administrator.** Support provisions `service-admin.json` for the test account:
    ```bash
    node scripts/provision-service-admin.mjs --data-dir "$HOME/.realbud" --generate-password-file <private path>
    ```
    Run this signed in as the test account, from a Node 24 source checkout at the installed revision. The script refuses a data directory that another account owns. The password file goes outside `.realbud`; hand the password over privately. It is not the macOS password.
15. **Link the computer.** On realbud.app, go to Account → Computers → Pair a new computer, then enter the code in the app under You → Website.
    - Allow up to a minute.
    - Check: the card shows the AI key and connector arrived, or one named reason with its next step. Record the exact reason.
    - If it reads "not arrived" or "needs review": remove the computer under Computers and link again.
16. **Install Bud** from the Bud card, using the service administrator password.
    - Before starting, check `launchctl getenv REALBUD_HERMES_CLI` prints nothing. If it prints a path, stop: that is a runtime override, and this run must test the managed setup.
    - On a Mac, setup runs the pinned upstream `install.sh` with `/bin/bash` and uses the system `git` (`server/worker-bootstrap.ts`, `server/hermes-runtime-check.ts`).
    - If a Command Line Tools install dialog appears, record it (screenshot and the setup stage shown), install them, then retry through the setup's own control. This is a known, untested path.
    - Check: Bud reports ready, with the model provider shown as Modelvia.
17. **Ask one question.**
    - Check: an answer arrives. Within 15 minutes the request appears in the desktop AI usage card and on realbud.app → AI usage & billing.
18. **Permissions.** Check the microphone, Accessibility and Screen Recording, as in step 3 of the [macOS installed-app checklist](MACOS-INSTALL-ACCEPTANCE.md).
    - When RealBud first asks for each one, deny it once. Check RealBud shows what to do next.
    - Then grant it in System Settings → Privacy & Security and retry. Screen Recording takes effect only after RealBud is relaunched.
    - Use a fictional spoken phrase for the microphone.
    - If RealBud never asks for one of them in this run, record that one as `not run`.
19. **Connect Gmail** (read-only) from Connected apps. The browser opens a Composio sign-in; finish it in the browser.
    - Check: Gmail shows connected.
    - If the sign-in lapsed, start again: a fresh attempt replaces a lapsed link.
20. **Check inbox for bills.**
    - Check: bill proposals appear for review. Nothing is paid or sent.
21. **Private backup:** check free space first, then export once, with the computer idle.
    - `df -h ~` must show more than 8.2 GiB available. With current defaults the export needs about 8.18 GiB free; 7.4 GiB free gave HTTP 507.
    - Check: an encrypted file is written.
    - If it fails, record the reason sentence shown. Attach the one `Private backup failure {…}` line from `~/Library/Logs/RealBud/office-service/stdout-stderr.log`.
    - "Stop waiting" only stops the screen. Use "Cancel this backup" to cancel.
22. **Revoke and re-link:** remove the computer on realbud.app.
    - Check: the desktop shows unlinked and the Modelvia key stops working.
    - Link again, and check a new key arrives.

## Known failures to watch for

- **Notarization fails with HTTP 401.** Capture the `[notarize-mac]` error line only, never a credential; the owner then re-runs `pnpm notary:store`. Seen on the 23 September candidate ([platform candidate](PLATFORM-CANDIDATE-2026-09-23.md), [Mac build and test](MACOS-BUILD-AND-TEST.md)).
- **Backup export is refused with HTTP 507.** Capture `df -h ~` and the reason sentence. Seen on the `b8aa9f2f` package QA with 7.4 GiB free ([platform follow-up](PLATFORM-FOLLOWUP-2026-09-24.md)).
- **A Command Line Tools dialog appears during Bud setup.** Capture a screenshot, the setup stage shown, and whether installing the tools let setup finish. Not yet seen: Mac setup calls the system `git`, which offers the tools when they are missing.
- **Opening RealBud shows an older window, an older version, or nothing.** The single-instance lock hands the launch to a RealBud that is already running. Capture the `ps` line from step 13, then quit every RealBud in the test account and reopen from `~/Applications`. Seen in the 22 September packaged smoke while another RealBud was running (`outputs/mac-smoke-2026-09-22/receipt.md`).
- **Bud setup stops at the download.** The upstream download returned HTTP 429 (rate limit). Capture the exact message and the time, retry once after a minute, and record both attempts. Seen in Windows CI; the Mac setup script comes from the same host ([platform candidate](PLATFORM-CANDIDATE-2026-09-23.md)).
- **Google warns that the app is unverified during Gmail sign-in.** Capture a screenshot of the warning and the app name, with no account details. Continue only if the account owner accepts it for this run; otherwise record step 19 as `blocked`. Listed as open in the [gates register](GATES-2026-09-22.md); not yet seen on a device.

## Stop conditions

- **Stop on any unexpected office, account or model.** An office, Modelvia customer or model the step did not name means stop and record it.
- **Never proceed past a money, send or notice action in REI or Gmail.** This run proves reading and preparing only.
- **From step 13 on, work only in the test account.** Do not change the owner's RealBud 0.1.18, its `~/.realbud` or its data.
- **Keep private material out of the repo.** Receipts go to `outputs/mac-run-2026-09-25/` with no secrets, customer rows or tokens. Live REI or Gmail data stays out of git.
