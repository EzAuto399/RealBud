# Authorization and billing reconciliation repairs

15 September 2026. Local candidate following independent core review. **99 focused tests and the gateway TypeScript check pass.** The original 74-test checkpoint, source snapshot, benchmark, receipts and v2 patches remain unchanged.

## Failure and correction

An async provider could yield continuation and final usage, revoke the issuer, then return `done`. The last authorization check ran before revocation. The gateway subsequently invoked the private continuation callback without checking again.

Every output now passes through one guarded emitter. It checks cancellation, awaits the current lease, rechecks cancellation, validates the signed grant against the current ledger registry, and checks cancellation again immediately before invoking the callback. The final checks and callback invocation share one synchronous continuation. The callback is never eagerly invoked merely to construct a promise for a cancellation race.

Continuation and settled callbacks each receive an independent check. Revocation or expiry after the final provider event, during the final lease check, or between callbacks prevents the next callback. The same boundary protects reservation, duplicate and delta output.

Accounting is separate from delivery. Valid already-incurred usage is settled even when cancellation interrupts iterator completion after the final usage event. Settlement still uses the ordinary ledger checks for provider identity, integer units, bounds, uniqueness and saved retail authority. Invalid evidence remains unknown with its reservation held. Buffered evidence and continuation are copied on receipt so later mutation of a provider-owned object cannot change the saved candidate. Neither cancellation nor retry starts another inference or deletes the measured charge.

Grant decoding also requires numeric schema 1 or 2 and the matching numeric grant version before choosing its field set. String values such as `"2"` cannot bypass v2 fields.

## Evidence

- `evidence/final-output-fix/before.log`: the new 14-test suite against the frozen pre-fix source; 11 failed, including the issuer-revocation reproduction, expiry/lease cases, cancellation accounting and string-schema acceptance.
- `evidence/final-output-fix/regression.log`: all 14 authorization/accounting/type regressions pass after repair.
- `evidence/final-output-fix/tests.log`: all 99 focused tests pass, with no skips.
- `evidence/final-output-fix/typecheck-gateway.log`: standalone TypeScript check passes.
- `evidence/final-output-fix/reproduction.json`: the independently supplied reproduction adapted to the current candidate now reports `issuerRevoked=true`, `rejected=true`, `privateContinuationForwardedAfterRevocation=false`, only a `reserved` output, and `ledgerState=settled`.
- `evidence/final-output-fix/verification.json`: exact sources, commands and immutable prior-evidence checks.

The tests count callback invocation itself, not just the returned promise. They check issuer revocation, grant expiry, lease rejection, lease abort and client abort at both final-output boundaries; retained exact cost; a single settlement event; no repeated provider inference; and invalid-usage reservations remaining held.

## Refund and credit arrival order

The earlier guard caught a refund already present when a credit was closed into a statement. It missed the reverse order: close a credit into a later statement, then receive a verified refund for its original paid usage. The later statement was still reduced, yet the refund summary showed no unresolved allocation.

The repair derives unresolved allocation from persisted refund, payment, source usage and credit facts. It covers unapplied credits and credits already attached to a statement or local invoice. There is no mutable clear flag, migration or inferred matching policy. The issue identifies the source statement, refund, credit and any statement or invoice that consumed it. Even an aggregate refund that might concern care requires review when credited usage is in that paid statement; this service cannot infer its allocation.

Verified incoming payments and refunds remain recordable, duplicate receipts remain idempotent, and closed statements remain immutable and readable. `SquareBilling.paymentSummary` exposes `reconciliationRequired` and `allocationIssues`; the portal usage response exposes `billingReconciliation`. A hold blocks further billing for the affected company. Other companies remain independent.

The hold is checked inside statement/local-invoice closing transactions, local checkout/refund admission, and the Square outbox transaction that claims pending work. After asynchronous secret lookup, the Square POST checks it once more immediately before invoking transport. A refund arriving during merchant/location preflight cannot be bypassed by an earlier entry check. A refund arriving after claim but before POST stops transport and conservatively preserves the claim as `unknown`; it is not retried automatically. Effects already dispatched and their valid readback are retained. Draft return also checks the hold so a concurrent verified refund cannot be presented as a clear result.

This is a bounded reconciliation hold, not a resolution engine. There is no automatic credit/refund allocation or hold-clearing API. A reviewed repair is still required before further affected billing can resume; it must preserve original money facts and statements.

### Financial evidence

- `evidence/final-output-fix/refund-credit-before.log`: the first five new financial regressions all failed against the prior behavior.
- `evidence/final-output-fix/refund-credit-regression.log`: all six financial regressions pass, including both arrival orders, a credit already applied, two SQLite connections and restart, a refund during draft preflight, and a refund after the outbox claim but before POST.
- `evidence/final-output-fix/refund-credit-reproduction.json`: the adapted independent reproduction retains the 2-cent refund, net received of zero, and unchanged later statement total of 12499 cents, while reporting `reconciliationRequired=true`.

## DeepSeek reasoning effort

The adapter now maps explicit `low`, `high` and `max` to the top-level `reasoning_effort` field while retaining `thinking.type`, offered tools, signed request digest and output ceiling. An omitted effort stays omitted; the adapter invents no provider default. For this subset, an explicit effort requires thinking to be enabled. Alias values such as `ultra` remain unsupported. Five injected transport regressions cover these choices and digest binding. This follows the current [official DeepSeek thinking guide](https://api-docs.deepseek.com/guides/thinking_mode/); no provider call was made.

## Scope and remaining review

Core owns authoritative company/device execution, the outbound office lease and tool permissions. This repair adds no authority default and changes no core/shared checkout files. Automatic per-client historical-cost sync, website integration, real provider/Hermes/device compatibility, Square integration and deployment remain unproved.

The earlier latency measurements remain evidence for their exact 74-test source manifest. This repair adds output-boundary checks; its latency has not been remeasured. No old timing is presented as a measurement of this candidate. The broader independent financial/identity review is separate from these reproduced fixes.
