# Next Windows run: one ordered sheet

25 September 2026. This sheet covers one fresh Windows 11 run, end to end:
- install RealBud and link the computer to the office on realbud.app;
- deliver its Modelvia key and Composio connector, and install Bud;
- ask Bud a question, connect Gmail, scan mail into bills, and test a backup.

It records the steps. It does not prove any of them. After each step, record what was actually seen:
- `pass`: the check below was seen to pass;
- `fail`: record the exact message;
- `not run`.

Evidence tiers stay separate: CI proves source, the Package Windows run proves the installer, and only this run proves the installed device and live integration.

Run the steps in order. Every step depends on the ones before it.

## A. Hosted setup (once; owner)

1. **Secrets in the macOS Keychain.** They are stable values: every redeploy reuses them, and nothing regenerates them.
   - Create the two gateway↔website secrets once:
     ```bash
     for n in REALBUD_GATEWAY_PORTAL_SECRET REALBUD_GATEWAY_OPERATOR_SECRET; do security add-generic-password -a realbud -s "$n" -w "$(openssl rand -hex 32)"; done
     ```
   - Add the vendor values. Each command prompts, so no value goes into shell history:
     ```bash
     for n in REALBUD_COMPOSIO_ORG_KEY REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL REALBUD_MODELVIA_OPERATOR_SECRET REALBUD_MODELVIA_CLIENT_ID; do security add-generic-password -a realbud -s "$n" -w; done
     ```
   - Load them into the current shell when needed:
     ```bash
     for n in REALBUD_GATEWAY_PORTAL_SECRET REALBUD_GATEWAY_OPERATOR_SECRET REALBUD_COMPOSIO_ORG_KEY REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL REALBUD_MODELVIA_OPERATOR_SECRET REALBUD_MODELVIA_CLIENT_ID; do export "$n=$(security find-generic-password -a realbud -s "$n" -w)"; done; export REALBUD_MODELVIA_OPERATOR_SUBJECT=realbud-gateway REALBUD_GATEWAY_PUBLIC_ORIGIN=https://realbud-managed-gateway.fly.dev
     ```
2. **Deploy the gateway** from the main checkout:
   ```bash
   bash managed-gateway/deploy.sh --check && bash managed-gateway/deploy.sh
   ```
   - Check: `curl -s https://realbud-managed-gateway.fly.dev/health` shows `service: realbud-managed-ai`.
   - Check: `/ready` shows `ready: true`, `provisioning: composed`, `modelviaOperator: configured` and `operatorAccess: configured`.
3. **Point the website at the gateway.** Run in `website/` with the same shell:
   ```bash
   printf %s "$REALBUD_GATEWAY_PORTAL_SECRET" | vercel env add REALBUD_GATEWAY_PORTAL_SECRET production --force --sensitive
   printf %s "$REALBUD_GATEWAY_OPERATOR_SECRET" | vercel env add REALBUD_GATEWAY_OPERATOR_SECRET production --force --sensitive
   printf %s "$REALBUD_GATEWAY_PUBLIC_ORIGIN" | vercel env add REALBUD_GATEWAY_URL production --force
   printf %s "$REALBUD_MODELVIA_CLIENT_ID" | vercel env add PLATFORM_EXPECTED_CLIENT_ID production --force
   ```
4. **Apply the one pending migration**, `202609240003_release_provisioning_attempt.sql`. Use the same linked Supabase CLI workflow as `website/docs/REALBUD-SUPABASE-ROLLOUT-2026-09-24.md`: back up first, then push that file only. The other 14 are already applied.
5. **Redeploy realbud.app from main only:**
   ```bash
   bash scripts/website-deploy-bundle.sh
   ```
   Then run the `vercel deploy --prod --cwd …` command it prints.
   - Check: `curl -s https://realbud.app/deploy-source.json` shows the two main commits.
6. **Check everything in one place.** Sign in as an operator and open `https://realbud.app/admin/connection`. Every row must be pass or an understood warning:
   - Settings: gateway URL is not Modelvia; operator secret is distinct.
   - Database: all 15 migrations.
   - Modelvia connection: client ID matches.
   - Gateway: health, ready and identity.
   - Offices.

## B. Office setup (once per office; operator)

7. **Modelvia side** (Modelvia operator):
   - RealBud's client monthly cap must cover the offices' caps. Today it is A$0, which blocks every request.
   - The owner office needs an active commercial policy: internal cost for your own office, client-funded for customers.
   - Record what Modelvia's `"mode":"local"` permits for this run.
8. **Service entitlement** on the gateway machine, for the office you will link:
   ```bash
   fly ssh console -a realbud-managed-gateway -C "sh -c 'cd /app/managed-gateway && node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ref> --license <id> --name \"<legal name>\" --address \"<address>\" --go-live <YYYY-MM-DD today or earlier> --go-live-evidence <ref> --expires <YYYY-MM-DD>'"
   ```
9. **AI access:** `/admin/offices` → the office → AI access → Default (A$200/month) → Save.
   - Check: the badge reads "Default — A$200/month", and `/admin/connection` shows the office row as pass.
10. **Austin pack:** in the app, go to Schedule → Workflow packs, import `realbud-austin-office-v1.json` revision 2, and approve the `invoice-review` recipe. "Check inbox for bills" stays disabled until this is done.

## C. The Windows computer (installed-device proof)

11. **Install the build from main.** Use the NSIS installer from the Package Windows run for the merged main commit (5d162956 or later), not the older `67d51881` build. Uninstall the old app first.
    - Check: the window fits inside the screen at 800×600, and welcome completes.
12. **Service administrator.** Support provisions `service-admin.json` on this computer:
    ```bash
    node scripts/provision-service-admin.mjs --data-dir %USERPROFILE%\.realbud --generate-password-file <private path>
    ```
    Run this from a Node 24 source checkout, and hand the password over privately. It is not the Windows password.
13. **Link the computer.** On realbud.app, go to Account → Computers → Pair a new computer, then enter the code in the app under You → Website.
    - Allow up to a minute.
    - Check: the card shows the AI key and connector arrived, or one named reason with its next step. Record the exact reason.
    - If it reads "not arrived" or "needs review": remove the computer under Computers and link again.
14. **Install Bud** from the Bud card, using the service administrator password.
    - Check: Bud reports ready, with the model provider shown as Modelvia.
15. **Ask one question.**
    - Check: an answer arrives. Within 15 minutes the request appears in the desktop AI usage card and on realbud.app → AI usage & billing.
16. **Connect Gmail** (read-only) from Connected apps. The browser opens a Composio sign-in; finish it in the browser.
    - Check: Gmail shows connected.
    - If the sign-in lapsed, start again: a fresh attempt replaces a lapsed link.
17. **Check inbox for bills.**
    - Check: bill proposals appear for review. Nothing is paid or sent.
18. **Private backup:** export once, with the computer idle.
    - Check: an encrypted file is written.
    - If it fails, record the reason sentence shown. The service log now names the failing phase and code lines, so attach that one log line.
    - "Stop waiting" only stops the screen. Use "Cancel this backup" to cancel.
19. **Revoke and re-link:** remove the computer on realbud.app.
    - Check: the desktop shows unlinked and the Modelvia key stops working.
    - Link again, and check a new key arrives.

## Known failures to watch for

- **Backup export fails with "Finish the current work before continuing this backup operation."** This is the generic 409; its cause is still unknown. Capture the reason sentence, how long the export ran (the budget is now 120 s), and the one `Private backup failure {…}` line from `%APPDATA%\RealBud\logs\office-service\stdout-stderr.log`. Seen on the ARM VM ([Windows QA handoff](WINDOWS-QA-HANDOFF-2026-09-24.md)).
- **"The office service did not start" while the service comes up late.** Capture a screenshot, the time, and whether the desk opened on its own afterwards. Keep the logs private. Seen on the ARM VM ([external test lab](EXTERNAL-TEST-LAB-2026-09-24.md)). Fixed in `67d51881`; the late start has not been deliberately re-run on a device.
- **The window's right edge is cut off at 800×600.** Capture a screenshot and the display resolution and scale. Seen on the ARM VM ([Windows QA handoff](WINDOWS-QA-HANDOFF-2026-09-24.md)). Fixed in `815e5a41` and `248115d9`; not yet checked on a device.
- **Bud setup stops at the download.** The upstream download returned HTTP 429 (rate limit). Capture the exact message and the time, retry once after a minute, and record both attempts. Seen in Windows CI ([platform candidate](PLATFORM-CANDIDATE-2026-09-23.md), [Windows QA handoff](WINDOWS-QA-HANDOFF-2026-09-24.md)).
- **Google warns that the app is unverified during Gmail sign-in.** Capture a screenshot of the warning and the app name, with no account details. Continue only if the account owner accepts it for this run; otherwise record step 16 as `not run`, with the warning. Listed as open in the [gates register](GATES-2026-09-22.md); not yet seen on a device.
- **SmartScreen warns about the unsigned installer.** Capture the exact prompt text and the choice made. The installer has no Authenticode signature: the lab recorded `NotSigned` ([external test lab](EXTERNAL-TEST-LAB-2026-09-24.md)). The prompt itself has not been seen yet.

## Stop conditions

- **Stop on any unexpected office, account or model.** An office, Modelvia customer or model the step did not name means stop and record it.
- **Never proceed past a money, send or notice action in REI or Gmail.** This run proves reading and preparing only.
- **Keep private material out of the repo.** Receipts go to `outputs/windows-run-2026-09-25/` with no secrets, customer rows or tokens. Live REI or Gmail data stays out of git.
