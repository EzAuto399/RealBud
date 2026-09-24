# Remote work through the account portal

This checkpoint implements protocol 2 for an explicitly opted-in **private workspace**. An invited, locally confirmed person can request either Morning priorities or an admitted recipe preparation, read its complete approved disclosure template, decide on that exact review, and follow the existing desktop executor's outcome. Enrollment alone never enables sharing or execution. This source is not deployed and does not establish installed Windows or live customer acceptance.

## Implemented behavior

The desktop has a separate sharing switch below Workspace access. It defaults off, requires current reviewed templates and confirmed people, and creates a new activation identity whenever enabled again. The portal names the workspace and preparation, shows waiting/review/running/result states, and preserves exact action identifiers across an uncertain reply. Full review text is separately retrieved and verified against its canonical template and review hashes before display or decision. Mobile selectors and long review sections fit the viewport.

Only typed complete templates cross the disclosure boundary. Private source messages, actual mailbox identifiers, execution bindings and vendor credentials remain local or in their established managed service. Status receipts contain bounded metadata. SQL stores the review projection once and prunes it seven days after the applicable terminal/expiry boundary without allowing replay to restore the text. Decision and execution evidence remain available.

SQL checks immutable portal person, identity epoch, current installation/parent/enrollment, exact descriptor and disclosure scope, explicit audience, expiry and cancellation. The first eligible approve/reject wins one immutable decision slot. Billing ownership is insufficient. A fresh online claim binds the exact review and decision and cannot renew its original maximum 60-second enqueue lease. Protocol 1 and 2 reserve executor request UUIDs in one nonreusable registry so neither protocol can reuse the other's existing executor key.

Both operations reuse the existing recipe/loop executors. No generic remote shell, new worker journal or alternate idempotency namespace was introduced. The final lookup, guard and durable enqueue do not yield after claim admission. Queued provider/source callbacks retain website provenance and recheck permission after awaited settings probes. Disabling sharing invalidates local admission immediately; cancellation and revocation preserve factual running/completed work and reconcile its outcome.

Cold startup reconciles an ambiguous claim or dispatch against the existing executor record. A claim with no durable job becomes interrupted, including on the portal; it never launches a replacement. An existing job is reattached and reported. Exact review, claim, decision, event and cancellation identifiers survive uncertain replies. A held workspace can reconcile previous status without collecting sources, publishing new text or claiming work.

Both encrypted backup formats retain complete review, audience/enrollment evidence and actual execution links. Restore under a different installation key clears usable intents, sharing authority and credentials; unfinished history becomes interrupted. Graph admission rejects missing/changed templates, absent or mismatched people, foreign workspaces and unrelated executor keys. Historical evidence can be re-exported without becoming live authority.

## Verification

Evidence directory: `outputs/remote-work-2026-09-22/`.

- PostgreSQL 16: **422 assertions passed**, including observed concurrent transaction waits, competing decisions/claims, both protocol collision orderings, revocation, expiry, rollback, pruning and immutable replay. See `sql-verification.json` and `sql-implementation.md`.
- Website: **63 tests passed**; production build passed. The scoped portal/API lint and TypeScript checks passed during implementation.
- Desktop: production UI/type build and compiled service build passed. Focused encrypted backup tests: **11 passed**. HTTP/provenance checks: **56 passed**. Adapter enqueue boundary tests: **15 passed**. Final no-run recovery tests: **25 passed**. These overlap the full suite and must not be added to its count.
- Final full regression: **4,678 passed, zero failures, 191 environment-gated skips**, including the additional no-run interruption-reply case. See `full-tests-final.json`. The earlier 4,677-pass run remains in `full-tests.json` as historical evidence.
- Actual source desktop + built Next + disposable PostgreSQL + rendered browser: **seven groups passed**, including both executors, default-off behavior, lost committed review/decision/claim/event replies, actual SIGKILL on both sides of enqueue and headless revocation recovery. Final source fixture used three worker calls and one mailbox scan; no real provider or customer data was used. One expected stale-revision SQL conflict was recovered after the lost claim; no unexpected database error or route/auth violation occurred. See `gui-source/receipt.json` and `cleanup.json`.
- The isolated compiled service/UI bundle also passes **all seven application groups**, with three fixture worker calls, one mailbox scan and complete cleanup. Its files are recorded in `compiled-manifest.json`; see `gui-compiled/receipt.json`. Source and compiled artifacts were hash-checked after verification. This is not an Electron installer or installed-device proof.

The final machine-readable checkpoint is `verification.json`. Source and compiled GUI screenshots are retained beside their receipts. Phone review text was visually inspected, not inferred from build success.

## Findings resolved during integration

1. A capability could be revoked while an adapter settings check awaited. Rechecking the request capability after that await closes provider entry; `website-execution-context.test.ts` exercises the race and queued Morning provenance.
2. Async lookup yielded between claim lease validation and enqueue. The adapter now uses synchronous existing-record lookup at that boundary while preserving its async recovery interface and original request keys.
3. Cancellation after a lost running acknowledgement could strand an accepted request even after its existing worker finished. Factual accepted-to-running-to-terminal reporting now continues through cancellation.
4. A committed claim with no enqueue could strand the portal at accepted. Recovery now reports interrupted with null run reference and retries a lost interruption acknowledgement exactly across another restart.
5. Long workspace choices overflowed the phone viewport. Scoped sizing and single-column full review sections fix it. One incremental Next build omitted the new CSS despite success; clearing only its generated Turbopack cache and checking the emitted CSS plus rendered viewport proved the replacement. Negative artifacts remain under `gui-mobile-overflow-failure/` and `gui-stale-css-failure/`.
6. Status copy said a review was still waiting for publication after it was ready. Current review/result copy now follows the saved state.

## Remaining goal and release gates

The next implementation is **company/department-scoped execution**, beginning with an explicit attended portal-person to authenticated company-member/host binding and an existing assigned department-case preparation. Private workspace authority cannot substitute for company membership, department access, case assignment or a current claim fence. See `outputs/remote-work-2026-09-22/department-integration-next-map.md` for 38 checked source links, transaction boundaries and required tests. Morning priorities stays private until a real department source scope exists.

Fresh native macOS packaging/signing/installed-profile behavior and Windows GUI, key custody, memory journal, update/uninstall and two-device gates remain separate. Hosted migrations, managed service/subscription commissioning, real bank/REI/Gmail authorization and customer acceptance remain unproved. This checkpoint authorizes none of those external actions and does not claim production rollout readiness.

The prior Grok diagnostic still offers only 4.6 and 4.5, not the requested 4.7. No new Grok prompt or silent substitution was made during this checkpoint; Codex subagents implemented and reviewed the bounded components. Preserve the earlier availability and successful historical receipts rather than treating either as present model availability.
