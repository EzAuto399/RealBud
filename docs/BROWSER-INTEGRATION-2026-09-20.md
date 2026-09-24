# Saved-job browser integration

Updated 20 September 2026. BrowserSkill is the default browser connection for RealBud's attended saved website jobs. This supersedes the browser choices in the August computer-use proposal. This is a local implementation and verification record, not a deployed release or bank acceptance certificate.

## Everyday operation

1. In **You → Browser**, choose **Connect my browser**. The complete app includes the reviewed helper; staff do not run a terminal installer.
2. Add BrowserSkill from the Chrome or Edge store to the work profile. Enable Local connection and keep tab confirmation and requests for help enabled.
3. Check the connection and explicitly select that profile. A missing profile never silently switches to another browser. Joining or leaving a local office does not share or change this computer's browser connection.
4. Open the saved job's exact website and sign in yourself. Choose **Run beside me** in Schedule. Confirm the tab request in the browser.
5. Bud reads and prepares the permitted work. Review the resulting page. Stop is available in settings, and a stopped/interrupted job requires a new reviewed step.

The Browser settings section distinguishes access off, missing extension, profile selection, connection loss, update required, active work and recovery. Setup steps disappear when profile selection becomes the next action. Details about the helper stay in a disclosure. Browser work is not available as unrestricted ambient computer access in Ask.

Sign-in recovery offers a matching-page picker and two visible labels, instead of process/window IDs. People can correct the page check, stop during verification and select only the next reviewed step. A successful login check does not resume old work automatically. Missing/stale bindings, wrong accounts, expired checks, unknown dispatch and failed release remain held.

The resumed attempt is bound to the verified browser profile, exact tab and site. The visible account label must remain present before page contents are returned or an observed control is used. A missing label stops the attempt rather than switching to another account tab. Historical computer-window bindings remain readable in saved records, but product-mode verification requires selecting the connected browser page again. It never silently falls back to the previous computer backend.

BrowserSkill shows tab confirmation on an active ordinary website tab. Returning a tab can leave a blank tab selected in its original window. After verification, the UI tells the person to select the checked website again before starting the next step. If no website can display confirmation, RealBud provides that recovery instruction while keeping confirmation enabled; it does not retry the borrow or switch off consent.

## Operational rules

- Each attempt has a private authenticated browser capability and one durable local session owner. It is revoked on interruption/completion and cannot survive as a warm chat capability.
- The broker admits exact HTTPS job origins, fixed typed operations, a borrowed tab and fresh observed controls. Unrelated tabs are filtered before the model sees them. A returned or closed tab ends the job's browser access.
- The selected profile, session identity and confirmation settings are rechecked. No raw browser CLI, arbitrary JavaScript, recording or credential-entry tool is exposed through this broker. CUA is not also mounted on a browser attempt.
- Existing job capabilities, service admission and operation approvals apply at the server. Changed controls require fresh review. Approval is not a session-wide grant.
- Effects receive a metadata-only operation record before dispatch. Duplicate RPC requests return the first result. Unknown outcomes stop the attempt and are not retried automatically. A click acknowledgement does not prove the resulting business action succeeded.
- A private `browser/connection.json` records local preferences and a session lease. The installation owns its own `BSK_HOME`; it does not adopt a personal/global BrowserSkill daemon. Restart never resumes a held job. Recovery only stops sessions in that installation's private daemon.
- App browser endpoints require RealBud session authentication. The per-attempt MCP endpoint is loopback-only with a random bearer token, rejects browser-origin requests and redacts credentials from native protocol logs.

## Bank work

Start with human-selected statement and transaction-history pages, or the existing bank-file import/reconciliation workflow. Sign-in, passwords, codes, financial-field entry, transfers, payments and signing stay with the person. Original bank exports remain source evidence; Bud prepares a review rather than treating a receipt or browser click as confirmed rent or an authoritative ledger change.

The browser broker withholds pages containing identified login fields, blocks financial field preparation, rejects identified payment/account/send/sign controls and limits identified bank controls to reading/export affordances. Page content used for the job reaches the configured model and may appear in the normal work history. Do not describe this as bank data staying entirely on-device.

These semantic guards and approvals are not an operating-system sandbox, universal bank-site recognition or a bank-specific integration guarantee. Hermes retains its separately governed native capabilities. The pack directs browser work through the broker and forbids alternate browser routes; this does not establish isolation against arbitrary approved native code. Real-bank automation needs an attended, named-site acceptance check with the intended account, data policy and workflow scope.

An observation can be truncated and reports that fact. Clicking an export control does not yet establish an attributed, validated downloaded file: there is no dedicated download receipt tool in this integration. Use the existing file import path for complete bank extracts. Do not infer complete period coverage, a reconciled ledger, a payment or successful customer work from a page read.

## Reviewed dependency and packaging

The build stages unmodified [BrowserSkill CLI 0.3.0](https://github.com/Tencent/BrowserSkill/releases/tag/cli-v0.3.0), extension 0.3.0 and protocol 1.3. `scripts/prepare-browser.mjs` verifies the official archive SHA-256, extracts only its named executable, checks its version and includes the MIT license. `package:prepare` runs this step and `electron-builder.yml` copies the result into Resources/browser. A missing/incompatible helper produces a setup state, not a runtime download.

Source references: [upstream repository](https://github.com/Tencent/BrowserSkill), [agent installation contract](https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md), [skill contract](https://github.com/Tencent/BrowserSkill/blob/main/skill/SKILL.md). The extension remains a user-enabled browser-store installation. Browser store updates and future helper releases require compatibility review; this build does not follow upstream main automatically.

## Verification and remaining layers

- Focused automated coverage: selected profile, session ownership, policy changes, lost start reply, restart recovery, failed return, stop/disconnect, site filtering, returned-tab takeover, credential withholding, blocked transfers, fresh controls, duplicate/unknown effects, handoff correction and browser endpoint authentication.
- ACP contract coverage uses a fake worker to verify private MCP mounting, no parallel computer backend, service checks, secret redaction and revocation on interruption. This is not a paid-model completion test.
- `scripts/qa-browser-skill.ts` runs the real CLI and real extension in a disposable Chromium profile against a locally intercepted fictional bank page. It verifies sign-in labels, release, human selection of the returned tab, explicit re-borrowing, statement reading, a blocked transfer control, an allowed statement control, readback, withholding a changed account and session release. No personal profile or real bank account is used.
- `scripts/qa-browser-ui.mjs` renders the built UI against an isolated server, checks actual endpoint authentication, and simulates connection/handoff states. It exercises keyboard connection, explicit profile selection, incompatible-profile blocking, desktop/mobile layouts, stopping, disconnecting, label-based login and explicit step recovery. UI simulation is distinct from the real-helper test.

Receipts and inspected images live in `outputs/browser-integration-2026-09-20/`. Installed Chrome/Edge profile setup, real-model saved-job completion, Windows/Linux runtime behavior, actual bank/site workflows, customer acceptance and deployment remain separate verification gates.

Recorded checks: the complete suite passed **2,695 tests**, with **101 skipped** across 12 skipped files. The final focused regression run after the confirmation guidance fix passed **174 tests**. TypeScript, the UI build and compiled server build passed; Vite retains its existing large-chunk warnings. The unsigned macOS arm64 directory build includes the verified helper. Its compiled server was exercised using the packaged Electron executable and bundled UI, with isolated data and a fake worker, through the same browser settings/sign-in QA. This does not establish a signed installer, an installed production app or live model/site completion.
