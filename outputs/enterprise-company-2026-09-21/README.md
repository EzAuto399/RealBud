# Company and mail boundary verification — 2026-09-21

Synthetic fixtures only. No live office, mail account, paid model, deployment or installed-device execution was used.

## Company runtime

`run-company.mjs` creates PostgreSQL 16.15 with private Unix sockets, no TCP listener, and a restricted application role. It discovers the company test files, enables both PostgreSQL test gates, runs serially, and stops/removes the disposable clusters afterward. It does not discover operator database URLs or inherit provider credentials.

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH node outputs/enterprise-company-2026-09-21/run-company.mjs
```

The baseline ran 197 tests with zero skips; its only failure was an obsolete migration inventory. Real PostgreSQL regressions then reproduced and fixed active-claim resurrection after generic scope write access was removed and restored. Claims now enter recovery hold and lose their token/lease under the existing scope lock. Remaining owner authority and unrelated/private scopes are preserved.

The expanded group exercised 203 tests across 26 files with zero skips: 202 passed and one old integration assertion still expected the unsafe claim behavior. That assertion was corrected to expect `recovery_required`, then `stale_claim` after a regrant. The affected 11-test real-TLS workday suite passed at exit 0:

```sh
COMPANY_TEST_RECEIPT_DIR=outputs/enterprise-company-2026-09-21/focused-correction PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH node outputs/enterprise-company-2026-09-21/run-company.mjs server/company-departments.integration.test.ts
```

Receipts: `tests.log`, `result.json`, `baseline-tests.log`, `grant-fencing-before-fix.log`, and `focused-correction/result.json`. A new two-host suite uses independent PostgreSQL databases and pinned TLS certificates to verify cross-office credential/invitation/recovery/department denial, revocation, held work, and remote admin/device/worker route denial. Existing real fixtures also exercised join, leave, host loss, changed TLS identity, backup restore/cutover, private-data retention and encrypted offline-departure journals.

Company device enrollment and remote worker execution remain unavailable; route-denial proof is not execution admission or installed-device acceptance.

The final clean company run passed **203/203 tests across 26 files**, with **zero failures and zero skips**, exit 0. The disposable PostgreSQL 16.15 fixture was stopped and its data removed. `final-company/result.json` records the exact file list, and `final-company/tests.log` contains the test receipt. This supersedes the intermediate expanded run above while retaining its failure history.

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH COMPANY_TEST_RECEIPT_DIR=outputs/enterprise-company-2026-09-21/final-company node --experimental-strip-types outputs/enterprise-company-2026-09-21/run-company.mjs
```

## Mail acquisition and scheduling

Final focused run: **250 tests passed across eight files**, exit 0, zero skips. `mail-boundary.log` contains the receipt.

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec vitest run server/composio-mail-scan.test.ts server/composio-gmail.test.ts server/managed-connectors.test.ts server/mail-ingestion.test.ts server/morning-mail-scheduler.test.ts server/morning-mail-workflow.test.ts server/routines.test.ts server/routines-recovery.test.ts
```

The independent regressions cover bounded pages/messages/conversations, incomplete and corrupt MIME, multilingual wire-size limits, projection of untrusted provider diagnostics, exclusive scan end time, chronological normalization, provider interruption and revoked authority. Durable checks cover encrypted restart/isolation/corruption, interrupted collection, partial source retention, stale decisions, human priority/done/snooze preservation, substantive new mail, bounded worker batches, invalid worker output, and readable storage limits. Scheduler checks cover paused-clock manual idempotence, office weekdays, nonexistent DST times, changed plans and partial completion after a later batch fails.

Gateway connector verification: **13 passed**, exit 0; `gateway-connectors.log`.

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH node --experimental-strip-types --test managed-gateway/connectors.test.ts
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec tsc --noEmit -p tsconfig.server.json
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec tsc --noEmit -p managed-gateway/tsconfig.json
```

Both type checks passed at exit 0. Mail provider calls are mocked; gateway HTTP uses local synthetic services. These results establish guarded local behavior, not live provider compatibility, complete customer mailbox coverage, real workflow acceptance, deployment, or company remote execution.

## Later mail recovery and bill API checks

Expired snoozes now durably reopen at their deadline on work-list read and collection, including a deadline crossed during a provider read. Revisions/timestamps advance once, manual decisions remain, and stale edits are rejected. Saved-source corruption now returns an opaque recovery error while preserving source bytes and accepted decisions. These additions passed 38 mail tests and the server typecheck before the subsequent bill integration.

The final combined focused run passed **160 tests across four files**, exit 0 (`bill-api-boundary.log`):

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec vitest run server/source-bills-api.test.ts server/session-auth.test.ts server/source-bills.test.ts server/mail-ingestion.test.ts
```

Bill host tests use real encrypted disposable SQLite state and synthetic saved mail. They cover host-owned source/actor resolution, injected authority rejection, current property checks, recovery before and after an asynchronous source read, stale corrections, supported identifiers/methods, bounded calendar ranges, and session/origin protection for all bill route families including proposals. Independent regressions found and verified fixes for new/reactivated patterns referencing removed properties, and for corrections to already-linked bills after a pattern is paused. Pausing remains available when a property is removed; existing paused links and correction history are retained without allowing new assignments to inactive patterns.

Per-item mail change history was deliberately deferred; current revisions, timestamps, source receipts and preserved decisions are not an immutable staff audit log.

## Final gateway and administration checks

The full gateway suite passed **100 tests**, zero failures/skips, exit 0 (`final-gateway.log`). Related desktop administration, connector projection and child-process secret filtering passed **35 tests across three files**, exit 0 (`final-service-admin.log`).

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH node --experimental-strip-types --test managed-gateway/*.test.ts
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec vitest run server/service-admin-api.test.ts server/managed-connectors.test.ts server/service-child-env.test.ts
```

These use local synthetic HTTP services, disposable stores and provider substitutes. They do not establish remote deployment, paid production provider execution or customer acceptance.

## Final complete unit run

After the synchronous invoice-preparation authority fence was added, the complete root suite passed **3,072 tests across 256 files**, **zero failures**, exit 0. It skipped 115 environment-gated tests across 15 files. The separate real-PostgreSQL company run above passed all 203 company checks without skips. The root run took 160.53 seconds; its full receipt is `../real-estate-core-unit-final.log`.

```sh
PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm test > outputs/real-estate-core-unit-final.log 2>&1
```

The final review reproduced a local authority change during an awaited source read immediately before model dispatch. The fix checks a synchronous generation after asynchronous admission/source reads, including the current connection fingerprint, authoritative recipe registry and mail journal generation. The latter advances before writes. The executor reserves the durable recipe run before writing the selected source input; repeated request IDs reconcile their original receipt. Provider-side revocation still depends on the provider/gateway's admission checks; these synthetic tests do not prove a live paid service.

The final frozen-source server typecheck also passed, exit 0 (`bill-api-typecheck.log`): `PATH=/Users/yoda/.nvm/versions/node/v24.19.0/bin:$PATH pnpm exec tsc --noEmit -p tsconfig.server.json`.
