> Predates docs/decisions/2026-09-24-modelvia-sole-billing.md: AI invoices come only from Modelvia; Square collects only the RealBud care fee.

# RealBud / Modelvia usage and payment handoff

Status: local integration implemented and verified, 23 September 2026. This checkpoint establishes no deployment, installed-device proof, live collection, paid inference or customer acceptance.

Follow-up, 24 September: the [runtime account-rendering checkpoint](ACCOUNT-RUNTIME-RENDERING-2026-09-24.md) adds a separately verified five-page delta. The original source manifest and run-5 evidence below remain immutable records of their tested snapshot.

## Ownership and trust boundary

- RealBud task owns this repository's authenticated website adapters, customer usage/payment UI, local tests and this handoff. Modelvia task `01a0ce52-b6e0-74e3-91db-2656d47370c1` owns `/Users/yoda/projects/modelvia-candidate`.
- The signed-in RealBud billing account selects `companyId`. Server-only `REALBUD_PLATFORM_CUSTOMERS_JSON` maps it to a distinct Modelvia customer. The browser cannot select a client/customer, merchant, amount, or payment policy. `PLATFORM_CLIENT_KEY` remains server-only and independently scopes Modelvia access.
- The billing UI binds reads and checkout to the server-rendered company using `X-RealBud-Company-Id`. The API compares that expected value with the independently authenticated account; it never uses it to choose authority. A stale tab after another-tab sign-in must be refused before Modelvia. Checkout retains exactly `{invoiceId}` in its JSON body. Actual route and browser regressions verify this boundary below.
- Customer responses explicitly project customer-safe fields. Supplier cost, wholesale invoices, platform margin, integration credentials and upstream diagnostics stay private. Internal owner usage must be visible without becoming a customer invoice.
- RealBud configures the collection method. Square is a processor; merchant ownership must be explicit. A return from a checkout is not proof of payment. Only verified settlement or a provider-authorized, durable reconciliation may establish payment.

## Existing upstream contract

All paths below use `/v1/client/customers/:customerId`, selected by the authoritative mapping above:

| Method / suffix | Purpose |
|---|---|
| `GET /usage-summary?period=YYYY-MM` | Actual attributed activity; wire shape below. |
| `GET /analytics`, `GET /analytics/trend` | Detailed customer activity and trends. |
| `GET /billing?period=YYYY-MM` | Customer billing view and scoped invoices. |
| `GET /invoices/:invoiceId`, `GET /invoices/:invoiceId/document` | Scoped invoice and document. |
| `POST /invoices/:invoiceId/checkout` | Owner-only handoff; server selects invoice amount and immutable merchant binding. |

Existing billing fields include `clientName`, `customerName`, `payer`, `customerCheckout` (`client_app`, `portal`, `both`, `off`), nullable `customerPriceNanoAud`, `usageAvailable`, `usageError`, `pendingRequests`, `unreconciledRequests`, `paymentMode` (`sandbox`, `live`, `disabled`), invoices and requests.

Confirmed usage wire (Modelvia → RealBud server):

```ts
{
  period: string; requests: number;
  tokens: { input: string; output: string };
  money: { customerNetNanoAud: string | null };
  monthlyCapNanoAud: string;
  remainingNanoAud: string | null;
  updatedAt: number; // epoch milliseconds
}
```

There is no customer/client/accounting-mode field in this response. Authenticated mapping and the upstream path establish scope. RealBud validates the requested period, bounded integer strings and counts, strips additions, and converts `updatedAt` to ISO for its website/desktop response. Missing price stays null. Input excludes cache buckets; input/output must not be labelled a cache-inclusive total. Remaining is display headroom against the reported cap, not an authorization to spend. A cohort over 10,000 requests returns `413 analytics_query_too_large`. The desktop's current-month helper now uses the same Brisbane accounting month as Modelvia and the portal; explicit historical months still roundtrip exactly.

Confirmed payment additions (Modelvia → RealBud server):

```ts
customerPayment: {
  methods: 'square' | 'direct' | 'both' | 'disabled';
  directInstructions?: string;
}
// Each issued retail invoice also has:
sellerName: string;
directPaymentAvailable: boolean;
```

Absent `customerPayment` retains legacy Square behavior; it never invents direct collection. RealBud's customer projection attaches plain-text instructions only to an invoice eligible for direct payment. It preserves Square handoff only when the server's invoice and provider policy permit it, displays the actual seller, and treats Square as the processor. Production checkout refuses sandbox mode before creating a link. No invoice / zero customer price does not by itself establish an internal accounting mode, nor does `payer` alone establish whether a charge is due.

Provider administration stays in Modelvia's client-admin portal. Its `GET/POST /v1/client/payment-settings` uses `{clientId,version,customerPayment,squareConfigured,paymentMode}` and versioned writes `{clientId,version,customerPayment}` (the submitted client ID is an assertion compared with the independently authenticated client; a mismatch returns `409 payment_settings_scope_changed` without changing policy). External-payment recording uses `POST /v1/client/customers/:customer/invoices/:invoice/external-payment` with exactly `{reference,amountCents,currency:'AUD',receivedAt}`. **RealBud exposes neither mutation to a customer billing owner**: this integration does not establish trusted RealBud-provider authority. Received payments are recorded only by provider administration; customers cannot self-report settlement.

## Feature contract

Product / user / job: RealBud account console for a business billing owner or reader to understand actual AI use and, when authorized, follow the provider's configured payment instructions.

Archetype: existing account dashboard, compact desktop layout with usable phone/tablet reflow. Reuse its tokens, notices, buttons and account navigation; no redesign.

Happy path:
1. Sign into the existing RealBud account and open AI usage & billing.
2. Read actual request/token activity, reporting period and any incomplete-data notice.
3. Inspect the customer price when priced; an unpriced account or one with no invoice still shows activity.
4. Read who issued the invoice and receives payment, and the available configured method.
5. A billing owner follows the allowed handoff; returning to the page reads authoritative payment status.

| State | Visible behavior | Next action |
|---|---|---|
| Loading | Stable region with accessible loading status; retain resolved neighboring sections. | Wait for the current read. |
| Empty | Explicit no recorded activity / no invoices, never an invented zero on a failed read. | Refresh when activity exists. |
| Loaded | Actual activity, period, customer-safe pricing and merchant/method explanation. | Inspect the relevant invoice. |
| No issued invoice | Usage remains readable; no checkout invitation or inference about internal accounting mode. | Review activity. |
| Unpriced / partial | Activity remains available; missing pricing or failed region is named. | Retry the failed read. |
| Unavailable / unlinked | Reason and recovery/support route; no fabricated totals or payment button. | Retry or contact RealBud. |
| Reader / collection blocked | Invoice remains readable with why payment is unavailable. | Ask the billing owner / RealBud. |
| Payment returned / interrupted | Reload authoritative invoice state; no optimistic paid label or automatic duplicate checkout. | Refresh invoice status. |

Edge paths: a failed usage read preserves invoices and supports retry; an empty account shows no-activity copy; an interrupted payment resumes from server state. Customer controls never edit provider payment configuration.

## Verification and live prerequisites

Final local checks: the full website suite passes **152 / 0 / 0** (passed / failed / skipped) in `outputs/modelvia-usage-payment-2026-09-23/preclaim-tests.log`. This includes 20 billing tests, 10 usage adapter/route tests, 24 middleware tests, eight payment-attempt tests and six expected-company route tests. Root independently reran the eight payment-attempt and six actual-route cases; prior independent 62 / 0 / 0 desktop/shared tests remain current with unchanged desktop source hashes (`desktop-tests-final.json`). Focused adapter, middleware, UI and harness lint passed. The production Next build, including TypeScript and static generation, passes as **`A3s2ZYJdsmi4nAtcRLG1f`** (`preclaim-build.log`). These local tests use fictional provider responses, not live accounts.

Final rendered verification passes **29 behavior groups and 71 captures** at 360 / 768 / 1280 px in `gui/run-5/receipt.json`, against the actual production Next build and disposable PostgreSQL identity RPCs. There are 165 database RPCs, zero database/auth/route violations, and exactly three deliberately independent fictional checkout POSTs. Modelvia transport and Square handoff remain local; Square is never contacted. The checks cover keyboard use, filters/reload, loading/empty/partial failure/unpriced/no-invoice/direct/Square/disabled/paid/unknown states, reader and other-office refusal, dark mode, reduced motion and container bounds. Body/muted/placeholder contrast checks pass in both themes. These spot checks are not a complete assistive-technology audit. All owned browser/server/database processes closed.

The final run additionally proves the pre-claim window: a checkout POST is paused before the gateway records an attempt; full reload and explicit refresh still return `not_started`, `paid: false` and both payment methods eligible, yet the matching invoice stays held and no second POST occurs. Storage-write failure prevents dispatch. Another invoice and another authenticated office remain independent, and returning to the first office retains its hold. Only authoritative `paid: true` retires that receipt. A shared-cookie account change before either refresh or checkout returns `409 account_changed`, clears invoice actions and makes zero Modelvia calls; full reload then binds the newly signed-in office.

The authentication-cache patch is also verified in the final build: actual signed-out requests return `401` and `307` with `private, no-store`. Focused tests cover authentication-dependent hidden-admin `404` responses while preserving public caching and existing authorization.

Final evidence is summarized in `outputs/modelvia-usage-payment-2026-09-23/verification.json`. Its `source-manifest.json` records 26 production/test file hashes; `qa-source-manifest.json` adds two harness files. Root matched all 28 files and all 16 browser-receipt hashes to current disk. `website-source.patch` (22 files) and `website-qa.patch` apply against website base `b9c764c0b97d406b0c9ce3bfd6dddb06ac7bba2a`; reverse checks against the verified checkout pass. A candidate that already includes the authentication-cache patch should exclude `middleware.ts` and `lib/middleware.test.mjs` when importing the source patch. `desktop-source.patch` isolates this task's desktop changes and excludes the pre-existing connector metadata edit in `shared/office-link.ts`. The shared parser test file was already untracked; retain its earlier coverage when importing the month-boundary tests. Earlier run-4 manifests and patches remain as explicitly superseded snapshots.

No required local work remains for this integration. Native packaging/device qualification and the live prerequisites below remain separate gates.

Review findings and resolutions:

- Numeric upstream timestamps failed the desktop ISO parser; the shared adapter now converts them explicitly. UTC-vs-Brisbane month boundaries now agree.
- Invalid analytics filters could normalize to the unchanged selection after setting loading, leaving the UI stuck. Validation now runs before entering loading and retains the user's input.
- A lost Square response could leave stale direct instructions visible. Invoice state is independent of the selected usage month, so changing month cannot reset an in-flight payment hold. The added company/invoice receipt survives full reload and a successful but unchanged `not_started` invoice read; that response cannot establish that the earlier checkout attempt ended. A compare-only expected-company header also prevents a cookie switch from silently retargeting a stale tab. Only verified paid status clears a receipt; no automatic checkout retry is permitted. Run-4 covered reload with an already-unknown upstream invoice; run-5 closes the distinct pre-claim and stale-tab cases.
- A fictional `external_receivable` / `client_funded` request exposed `20212500` nano-AUD wholesale as customer net despite zero retail invoice lines. Modelvia fixed its customer analytics projection while preserving wholesale accounting. Root's exact before/after reproduction now passes: customer net `0`, wholesale unchanged, one request and all tokens retained, zero retail invoice lines. Evidence: `client-funded-privacy.json` (retained failure) and `client-funded-privacy-after.json` (pass). The cross-repository fixture probe now passes 14/14 at `/Users/yoda/projects/modelvia-candidate/docs/evidence/customer-usage-payments-2026-09-23/cross-repo-contract.json`. Production must include the fixed gateway revision; RealBud cannot infer the accounting mode or repair that upstream amount from this wire alone.
- The first rendered tablet check found a month/form grid overflow; a second review found child cards exceeding their own container despite fitting the page. Explicit flexible grid tracks and minimum widths fix both without hiding overflow. Final rendered checks inspect both page width and child/card bounds. Negative `gui/run-1` is retained. `gui/run-2` also records a fixture-only sign-in conflict from changing the same fictional user's provider subject; stable per-actor subjects fixed the fixture while preserving the real identity gate.

The browser payment hold is a same-tab recovery aid, not financial authorization or a cross-device lock. It cannot replace gateway invoice/merchant binding, idempotency, verified settlement or provider reconciliation. An unresolved attempted checkout must not be retried by clearing browser storage or switching browsers; support must establish the outcome first. Provider configuration and receipt recording remain outside the customer controls.

Live prerequisites: deployed compatible Modelvia and RealBud revisions; scoped integration credential and verified company/customer bindings; provider-approved commercial terms and payment policy; verified Square merchant configuration for Square collection; authorized authenticated real-account readback and, separately, payment acceptance. This task does not authorize those external effects.
