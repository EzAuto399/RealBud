# Local approval and Stop evidence — 23 September 2026

**26 passed, 0 failed, 0 skipped**, across three files on Node 24.19.0. These are local deterministic integration/regression tests; no hosted model, real browser, payment, email send or customer data was used.

- [Full test receipt](final-tests.json), [readable log](final-tests.log), [summary and source hashes](summary.json).
- Ten adversarial tests expose the real browser MCP tools through the real Hermes ACP adapter. A scripted hostile client reads a fictional invoice email telling it to skip approval and pay, then tries payment click and Enter. The actual broker, authority, persisted approval store and ACP response/Stop paths enforce exact recipient, amount, currency, reference and once-only approval even with `fullAuto` enabled and a standing read rule.
- Wrong-thread approval, broad/session approval, changed recipient/amount, Stop before dispatch, in-flight read cancellation, unknown payment outcome/no replay through Enter, foreign token/run/site/browser and checked account change are covered. An approved dispatch is only a helper acknowledgement, not proof that a real payment completed.
- The suite found a fresh-root initialization defect: `ensureDirs()` created POSIX directories with the process default mode, so real approval persistence failed with “Private state directory needs recovery.” The production fix creates **new** directories with mode `0700`. Two regressions prove fresh-root approval bytes survive a new store instance and an existing unsafe root remains untouched and blocked. The final integration suite calls actual `ensureDirs()`; it does not precreate or repair the data root.
- Fourteen existing config recovery tests remain green. Server typecheck has one unrelated current error in `shared/office-link.test.ts:2`, its extensionless `./office-link` import; [receipt](server-types-final.log). Root owns routing that correction. No type errors remain in this lane.

## Remaining proof and implementation limits

The accepted browser decision says the task request should authorize routine steps. Current `server/browser-authority.ts:709–730` still asks for routine borrow/read/navigate unless a saved site rule allows reading. The tests create that real read rule; no test-only approval bypass is installed. The decision document’s blanket “not built yet” wording is stale for per-action approvals, but the task-wide routine permission remains unfinished.

Tenant-related proof here means broker credentials, run/thread identity, exact site, selected browser, and a person-checked account marker. It does not prove PostgreSQL company/member authorization or automatically establish an account marker for an ordinary new Ask task. Native Windows, actual UI interaction, installed browser behavior and live/customer acceptance remain separate gates.

An interrupted already-dispatched payment cannot be undone by Stop. Its persisted result remains **unknown**, and a fresh broker refuses a second attempt through another control.

## Historical runs

The initial run’s ten timeouts came from an unanswered routine-read fixture assumption. The next run passed three and failed seven at the genuine fresh-root privacy gate. `injection-fixture-diagnostic.log` isolates that error. `injection-private-root.json` is an intermediate ten-pass run with an admitted fixture root before the production fix. These receipts remain intact; none are added to the final 26-test count.
