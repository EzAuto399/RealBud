# Customer cost and spending budget — 30 September 2026

Owner choice: show percentage of the customer's spending budget, with cost so
far and tokens available in details. Implemented locally, uncommitted and not
deployed or packaged.

The shared `usageBudget` helper uses Modelvia's cap and remaining headroom with
BigInt arithmetic. This reflects gross customer-priced spend and outstanding
reservations, before credits. Cost so far uses the separate net amount after
credits. Neither value is a supplier price or a subscription token allowance.
Zero cap is disabled; unknown headroom is unavailable; neither invents 0%.

The nested website's overview and billing summary use this helper. The billing
summary refreshes every 30 seconds while visible, marks cached figures stale on
errors, and clears figures on account/authorization changes. The selected month
owns the pricing explanation; invoice state remains independent. The desktop
card uses the same helper, polls local status while visible, and its server
refreshes account usage at most every 30 seconds instead of every three minutes.
Modelvia remains the sole AI accounting source. No payment or admission rule was
changed.

Verification: 58 focused shared/server/desktop tests; app and server typechecks;
website 345 tests passed with two existing database-gated skips; website build,
typecheck and focused lint passed. The actual Modelvia adapter acceptance passed
as part of both its native (907 passed, one PostgreSQL-only skip) and disposable
PostgreSQL suites (612 passed, zero skips).

`website/scripts/qa-usage-budget.mjs` passed eight browser groups with actual
Next pages and disposable PostgreSQL identity. Evidence is in
`outputs/usage-budget-1790764653086/`. The supplementary billing UI harness passed
the changed screens on the final build, then failed at its unchanged operator
readiness/migration fixture; see
`outputs/usage-budget-billing-regression-2026-09-30/receipt.json`. It is not an
all-green full admin QA run.

Coordinate the separate RealBud and RealBud-website revisions: the website
requires the new `shared/usage-budget.ts` in its parent checkout. The Modelvia
checkout records the complete contract and proof limits in
`docs/REALBUD-BUDGET-DISPLAY-2026-09-30.md`. Existing unrelated work in all checkouts
was preserved. A coordinated authorized release, signed-in customer readback
and packaged/installed desktop qualification remain separate; no live provider
call, collection or customer acceptance was performed.
