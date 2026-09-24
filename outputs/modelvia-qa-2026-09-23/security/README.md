# Modelvia boundary and failure-edge QA — 23 September 2026

Local synthetic evidence only. No real credential, customer record, hosted Modelvia request, paid call, PostgreSQL suite, package or installed-device run was used.

## Reproduced findings

The original source hashes are in `focused-summary.json`; `failure-probes.json` records the four negative observations before corrections. Line references below describe that inspected source revision.

| Severity | Finding and reproduction | Correction |
|---|---|---|
| P1 | `server/office-link.ts:401,407–408`: a 403 records a revoked link, then config recovery can refuse withdrawal. Repairing config and reporting again did not retry withdrawal. The access record and index-equivalent launch snapshot remained active. | Fixed: retry a saved revoked link before reconciliation, hold access during failed withdrawal, and gate boot/refresh against the durable link before and after the asynchronous vault read. Clear the launch snapshot before withdrawal/clear; ignore superseded refreshes. A fresh access-object regression proves cold restart never reads the key from the saved revoked installation. |
| P1 | `server/office-link.ts:152,159,171`: delayed office A usage finished after disconnect/status/relink to B; B then displayed A's request/cost figures without fetching B's usage. | Fixed: cache and in-flight checks are installation/token/company scoped; a response is discarded if its owner changed. The new installation may refresh while the old request remains in flight. |
| P2 | `server/worker-model-access.ts:222`: vault removal refused a damaged/private-file condition, but the error was swallowed. Clear resolved and deleted the provisioning and binding records while retaining the encrypted credential. | Fixed: propagate refusal, preserve recovery records, hold model access, then complete cleanup only after deliberate repair. Regression uses damaged fictional envelope bytes and verifies retry. |
| P2 | `server/redact.ts:79`: an env-style `{name,value}` entry with an ordinary name returned unchanged, including a recognizable `rbk_` credential value. Ordinary text redacted the same value. This helper feeds the native protocol tee and harness event log. | Fixed by root: recursively redact the entry's other fields and apply prefix redaction to values even when the env name is not a credential name. [Redaction tests](redact-tests.json) pass 11/11; [consumer tests](redaction-consumers.json) pass 87/87. These overlap the combined root regression. |

## Checks

- Initial existing desktop selection: **142 passed, 0 failed, 0 skipped**, five files. `desktop-results.json`, `desktop-tests.log`.
- Existing gateway authority/accounting/provisioning selection: **79 passed, 0 failed, 0 skipped**, seven files. `gateway-tests.log`. Includes scoped grants, revocation, unknown usage, duplicate admission, concurrent caps, lost provisioning replies, secret-free errors and operator response validation.
- Final changed lifecycle selection: **58 passed, 0 failed, 0 skipped** on macOS; server typecheck and scoped diff check passed. `lifecycle-fixed-tests.json`, `lifecycle-fixed-tests.log`, `lifecycle-fixed-summary.json`, `lifecycle-server-types.log`. These overlap the initial desktop selection and are not additional unique tests.
- Source changes are limited to office-link and worker-model-access plus their tests, and the scoped launch-snapshot composition block in `server/index.ts`. The final summary records all five source hashes. Root independently integrates/rechecks other consumers.

The final private-directory refusal regression is POSIX-only and will skip on Windows. No native Windows behavior is proved here. `modelAccessEnv` is an internal server capability, not a new renderer route; unlinked manual models still receive no managed environment injection.

If both recording revocation and cleanup fail because durable storage is unavailable, the in-memory hold cannot survive a process restart. The ordinary case—revocation saved, cleanup held—does survive restart and retries safely. This packet adds no general recovery journal or guided repair UI.

`failure-probes.mjs` deliberately asserts the old defects and is historical reproduction evidence, not the post-fix acceptance command. Harness setup and intermediate test corrections are recorded in `execution-notes.md`.
