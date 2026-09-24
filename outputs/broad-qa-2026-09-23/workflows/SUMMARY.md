# Synthetic workflows and office isolation QA — 2026-09-23

Final rebuilt-renderer results: [all five harnesses pass](final-renderer/SUMMARY.md). Expanded PostgreSQL results: [127 unique cases pass](company-expanded/SUMMARY.md). The sections below retain the initial baseline and diagnosed failures.

Completed: **49 workflow assertion groups passed**, **16/16 PostgreSQL integration tests passed**, **15/16 old second-office contract checks passed**. These are local source/built-UI results; they do not certify a packaged release or a live customer integration.

| Area | Observed result | Evidence |
|---|---|---|
| Bank original/corrected CSV | 13 groups pass: byte-perfect original, BOM/Unicode/multiline, approved-reference-only change, unsupported encoding, retained draft/history and failure recovery | `bank-bytes-chrome/result.json` |
| Bank correction/restart | 7 groups pass: lost-response retry without duplicate, structured mapping preserved, fresh decisions required, distinct saved versions/artifacts, actual service restart | `bank-amendments-chrome/receipt.json` |
| Source bills/calendar | 25 groups pass in output-only current-history probe: source review/attachment hold, bill proposal/acceptance idempotency, encrypted drafts/two-window conflict, recurrence, paging, direct source access | `source-bills-current-history-probe/receipt.json` |
| Morning priorities | 4 groups pass: 45 conversations in 20/20/5 batches; staff edits/stale checks; schedule/timezone/revoke; desktop/mobile. History-coverage group uses in-process production seams. | `morning-mail-chrome/receipt.json` |
| Separate offices/departments/members | 3 files, 16 tests, 0 failed, 0 skipped: separate DB/TLS identities, foreign credentials/invitations/records denied, joins, private scopes, read/write/remove, owner transfer, revocation and uncertain-work holds | `company-postgres-locale-results.json` |
| Fresh second-home contract | 15 pass, 1 stale expectation: both homes retain separate six-property books; anonymous401, send403, stale409, no readiness false-positive, never-rule retained | `second-office-contract.log` |

## Failures diagnosed and retained

1. First bank UI attempts lacked a Playwright cached browser under disposable HOME. Retried with installed Chrome via the owned `playwright-disposable-chrome.mjs` adapter; passed. No download or user Chrome profile used.
2. Original `qa-source-bills.mjs:80` expected one total scan; current account checking has already initiated history acquisition. It observed two. Owned probe records the pre-click baseline and asserts **exactly one extra** manual collection; all 25 groups pass. Product/test source unchanged. Recommend updating the maintained harness to this invariant.
3. First PG setup failed before any of 16 test cases because stripped locale triggers PostgreSQL macOS `postmaster became multithreaded during startup`. Retained diagnostic log says set LC_ALL. Rerun with LC_ALL=C and LANG=C passes all 16; fixtures stopped and removed.
4. `qa-second-office-contract.mjs` sends empty `{}` to inbound-triage and expects old409. Current `server/index.ts:3071` requires requestId/revision and returns400. Recommend changing the maintained harness to exact400 plus response-body assertion; no evidence of unauthorized execution. Original failure kept, not converted into a pass.
5. Morning-mail receipt has stale wording that history is not wired in the app server. Current source wiring exists. The actual history group in this script remains an in-process seam test, so this run does not claim full app history coverage from that group.

## Proof limits

- HEAD fb6cebed63aaed9d81f9112005ac938644d2fa86 with active shared source changes; previous built `dist` renderer. Root changed onboarding during this pass. Final rebuilt renderer/package needs its own check.
- Synthetic local connector and deterministic worker. No real bank navigation/download, Gmail OAuth, Modelvia/provider use, REI upload, customer data, payment or external service call.
- No Windows/native installed-device, cross-device LAN, backup/restore, customer acceptance or native close-dialog proof.
- Desktop bank review and 390px bills screenshots visually inspected; readable, no clipped text or unintended horizontal overflow observed. Automated UI scripts report zero page errors.
- No product source edits, builds or commits. All owned output is in this directory. No owned child services, PostgreSQL fixtures or browser jobs remained at completion.

Next gate: root rebuilds and checks the new durable onboarding flow before final performance measurements; these baseline workflow receipts remain separate.
