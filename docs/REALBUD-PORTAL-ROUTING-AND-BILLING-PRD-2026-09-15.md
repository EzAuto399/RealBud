# RealBud portal, provider routing and customer billing

15 September 2026 · Product Manager plan · Revised for website billing and minimum necessary API access; Square retained; no deployment, provider purchase, final retail price or live payment approval

## Product decision

Use **RealBud as the customer-facing brand and website**, with customer accounts, monthly usage statements and Square payment links in that site. The latest request is to simplify to website billing and client API access, avoiding a separate routing product. Keep only the backend functions needed for authenticated API access, usage/cap enforcement and accurate billing. Reuse the existing prototype modules; a second brand, model marketplace or sophisticated model-selection engine is outside the first release. This recommendation treats “Robot” in the earlier request as RealBud, not an instruction to rename the product.

Customers want their office assistant to work, a predictable spending ceiling, and an understandable bill. They do not need provider accounts, master API keys or a model dashboard. The supplier remains Yo-Da Lai, sole trader, ABN 84 992 526 369. Internal margin is private; customer usage units, retail prices, GST and spending limits remain visible and accepted.

The proposed minimal path is **RealBud desktop → our authenticated backend endpoint → DeepSeek or Kimi**, with **our website → usage statement → Square invoice/payment** as a separate asynchronous billing path. This still forwards and meters API requests; it is a small proxy function, not merely a billing page. Direct provider calls, private configurable retail pricing and Square remain the selected commercial direction. One provider route per approved workflow is enough initially. Keep the backend behind the existing website/account experience; the physical deployment choice remains open because the current website and Node SQLite prototype have different runtimes.

## Direct provider keys: current evidence and trade-off

The user's proposed alternative is **customer desktop → provider**, with our website importing each customer's provider usage and adding our margin to the monthly bill. This can remove our inference hop if the provider supports authorised customer credentials, reliable per-customer usage evidence and suitable limits. A provider key gives calling access; it does not itself send usage to our website or enforce our contract and retail spending cap.

However, current published provider terms do not support simply handing out keys from our account:

- DeepSeek Open Platform terms §2.2 say not to share API keys with others or expose them in client-side code, and put resulting fees/losses on the account holder.
- Kimi OpenPlatform terms §3.4(9) prohibit buying, selling or transferring API keys with third parties. Its customer-application permission is distinct from selling provider keys.
- Kimi documents project-level consumption and daily/monthly budgets, but all projects share the organisation balance and its documented cutoff can lag about ten minutes. This is useful upstream accounting, not proof of an exact RealBud GST-inclusive retail cap or permission to transfer keys. Automated per-project billing extraction has not been verified here.
- DeepSeek per-key reporting is now confirmed from its official FAQ's publicly served content: open Platform → Usage, select the time range and API Key, or export the ZIP and read the `amount` CSV for per-key usage details. This corrects the earlier extraction gap. A website CSV importer could use those records for monthly attribution and agreed pricing without sitting in the inference path. An actual export schema, per-key monetary cost fields, automated supported historical usage API and hard per-key spending cap remain unverified. The documented `/user/balance` endpoint reports account balance, not per-key historical usage. Reporting support does not change the separate provider-key sharing restriction.

Recommendation: issue RealBud-scoped access credentials backed by the existing company/member/device/job checks, and retain provider keys only on our server. A customer access key cannot replace job authority. With a raw provider key, desktop licence checks or website payment status cannot prevent calls made outside RealBud; downstream licence and spend controls would no longer cover that path.

If the user instead selects a provider-approved delegation/reseller arrangement or customer-owned account, direct calls can be evaluated separately. Require isolated customer usage, supported reconciliation, credential revocation and documented budget behaviour; local client telemetry alone is insufficient billing evidence. Customer-owned accounts with direct provider payment would also change the commercial billing flow and cannot silently duplicate provider charges. No such arrangement has been verified or selected. No customer credential delivery or provider account changes are authorised by this planning update.

## Evidence and scope

The current `website/` is an existing React/Next-compatible Vinext site with Cloudflare Vite integration and a Sites-managed D1 enquiry store. `website/.openai/hosting.json` identifies the existing Sites project; `website/app/layout.tsx` has a chatgpt.site fallback origin. No new custom domain ownership or working account portal was verified. Extend this site, not the unrelated personal portfolio. Use the Sites workflow before any hosting changes.

The isolated `/Users/yoda/projects/realbud-managed-gateway/managed-gateway/` implementation has recorded 55 passing focused tests and local invoice/payment simulation. It supports a single durable Node SQLite service, not serverless ephemeral storage or independent replicas. Its OpenAI adapter is **text-only**; Hermes tool-call traffic, DeepSeek/Kimi, Square and core identity/authority are not yet integrated. Reading this evidence is not a fresh installed test run. Do not advertise it as production-ready.

The active core build owns member/device/job authority. The gateway build owns provider adapters, metering and billing. This document is planning only; implementation ownership must be coordinated, not duplicated.

## Recommended stack

| Layer | Recommendation | Rationale / constraint |
|---|---|---|
| Public site and account UI | Extend existing `website/` and current Sites/Cloudflare deployment | Reuse current investment. Add `/account`, usage, invoices, setup/downloads and support. Confirm secure auth/session capabilities before rollout. |
| Portal login | Established authentication integration with short-lived server-side sessions | Separate billing owner/read-only permissions and operator MFA. Select provider after matching current host; never use a client's office invitation as billing login. |
| API access and metering | A minimal backend endpoint behind the existing RealBud website/account experience; reuse gateway modules | Keep provider secrets and authoritative metering server-side. Co-hosting is an implementation option only after runtime compatibility is proven. An internal Node service such as Fly Sydney remains a candidate if needed; no separate public product or hosting commitment. |
| Operational billing storage | Single durable volume for bounded pilot; central PostgreSQL before replicas/HA | Keep atomic reservation/idempotency semantics. Never place current node:sqlite file in an ephemeral serverless function or share it as a network filesystem. D1 enquiry storage is not silently the financial ledger. |
| Model inference | Direct admitted DeepSeek and Kimi API routes | We buy upstream API service; provider keys remain in gateway secret storage. Per-workflow model capability is tested before admission. Fewer intermediary services by design; fastest route is unmeasured. |
| Provider selection | Fixed approved provider/model per workflow, with the corresponding tested adapter | No separate dynamic routing engine or automatic cross-provider failover for MVP. Retain capability checks, model admission, caps and rate versions. |
| Billing/payment | Square Orders + Invoices APIs and Square-hosted invoice payment page | Our ledger calculates usage and retail prices; Square issues the canonical invoice and collects payment. Reuse the user's Square setup, with account/location configuration and adapter verification still required. Retain contract PayID with verified manual reconciliation. |

Fly is an internal hosting fallback to compare with co-hosting, not a selected purchase or high-availability claim. One volume/process is an availability constraint. Production needs TLS, secret storage, startup fencing, verified backups/restore, minimal logs and service health. An Australian backend does not mean the downstream model processes data in Australia. A website-only invoice module can operate independently, but cannot enforce access or measure direct external provider calls without a supported provider integration.

## Provider routing alternatives

| Route | Useful when | Cost/performance considerations from official docs |
|---|---|---|
| Our gateway → provider directly | Small approved model set, full accounting control | No aggregator platform fee. We own adapter and outage handling. Extra-hop removal alone does not prove lower end-to-end latency. |
| Our gateway → OpenRouter → provider | Many providers/models, explicit latency/throughput preferences | Current pricing page lists 5.5% pay-as-you-go platform fees. Defaults prioritise price; configure allowed providers/parameters and latency policy deliberately. FAQ/BYOK figures differ from the newer pricing table, so verify the applicable account plan before costing. |
| Our gateway → Vercel AI Gateway → provider | Unified route coverage without advertised inference markup | Official docs advertise no markup including BYOK. Still verify supported model/protocol, telemetry and actual route latency. This does not require moving our website to Vercel. |
| Our gateway → Cloudflare AI Gateway → provider | Observability/rate limiting in an existing Cloudflare stack | Core features are free; current Unified Billing adds 5% to credit purchases. BYOK and Unified Billing have different costs. It does not replace our customer retail ledger or invoices. |

Decision: fixed direct DeepSeek/Kimi connections through the minimum RealBud backend for the first release. The alternatives above are background research only and are not on the current build path. Provider-native caching is worth measuring; do not cache personalised AI responses across tenants or return stale results for live account tasks.

## How direct DeepSeek and Kimi routing works

1. A RealBud job is authenticated by the current company/member/device authority. The gateway receives a short-lived scoped request, never raw provider secrets from the desktop.
2. The selected route pins provider, accepted retail rate version, protocol, model identity/capability and output/budget ceiling. Each job attempt can contain multiple signed child `modelCallId` values; retries keep the same child identity. Reserve against the aggregate job envelope as well as the tenant ceiling. Do not increment the job attempt to bypass the prototype's current one-inference-per-attempt constraint. Do not let customers inject arbitrary base URLs or privileged routing overrides.
3. Reserve worst-case authorised retail spend atomically, including GST and concurrent requests, before contacting the provider.
4. The selected provider adapter calls its official API, streams responses immediately, preserves tool-call IDs/arguments/results and handles the selected thinking/protocol mode explicitly. DeepSeek supports OpenAI-format and Anthropic-format APIs. Moonshot's official Kimi K3 repository identifies `kimi-k3` and OpenAI/Anthropic-compatible APIs. Kimi K3 requires the complete assistant continuation, including `reasoning_content` and `tool_calls`, to be preserved for subsequent turns. DeepSeek thinking/tool use also needs provider-specific continuation handling. Keep this transient continuation within the confined worker path, out of billing records and application logs; do not strip it through a text-only adapter. Verify endpoint, model availability and capabilities for our actual provider accounts before enabling routes.
5. Account separately for cache-hit input, cache-miss input, output and other admitted units. DeepSeek currently has peak/off-peak rates and moving legacy aliases: record the applicable cost basis, provider timing and actual served identity when available, and invalidate admission on observed capability drift. RealBud-controlled updates cannot prevent upstream alias replacement. Kimi has its own rate and capability admission; never reuse DeepSeek's price card or unit assumptions.
6. Reconcile provider usage/request identity with our reservation. Uncertain streams stay unresolved; no automatic duplicate bill or automatic replay after a possible completed request/tool effect.

The current `/v1/model/stream` normalized gateway endpoint is **not** a drop-in OpenAI base URL. Add a reviewed Hermes transport/adapter or compatible facade with scoped grant issuance. A generic new base URL is not complete integration. Include every permitted model path while preserving blocked operations.

Bound input/output admission to tested workflow limits; reserving an entire million-token model context for every small request would make ordinary work unusable under a modest spending cap. Any smaller reserve must follow an enforced input ceiling or verified safe count. Long workflows need explicit per-call lease renewal and cancellation, without silently extending authority.

A cheap text model cannot be assumed capable of screenshot-driven CUA. Route selection is filtered by required tool/vision/schema/data-policy capability before cost or speed. Deterministic CSV validation stays deterministic. Composio tool-call/connection charges are separate upstream cost categories from model tokens; model margin alone must not silently become undisclosed tool charges. Initially absorb routine connector overhead in the service economics unless a separately priced category is agreed.

## Measuring speed and useful quality

The user explicitly wants to preserve current API speed and compare average latency. No measured RealBud direct-versus-proxy average was found in the gateway's current source/handoff search. No provider requests or live benchmarks were run for this decision. Published speed claims are not our deployment evidence.

Public comparison snapshot checked 15 September 2026, from Artificial Analysis's current comparison page (use the opened page, not its older search snippet):

| Direct first-party API, max reasoning | First stream token | First answer token | Output speed |
|---|---:|---:|---:|
| DeepSeek V4.1 Flash | 1.19s | 10.17s | 222.8 tokens/s |
| Kimi K3 | 4.54s | 60.56s | 35.7 tokens/s |

These published typical values use median measurements, not an arithmetic mean from Auston's workflow. Artificial Analysis defaults to 10k input tokens and US-central testing, reports a rolling 72-hour median, and standardises speed tokens rather than using provider billing tokens. First stream tokens may be reasoning; they are not necessarily a usable answer. Thinking-effort settings, task correctness, prompt/context size, region and account load matter.

For proxy context only, Maxim's own Bifrost benchmark reports 0.99ms added internal processing versus 40ms for its compared LiteLLM configuration, subtracting a 60ms mock upstream response. This is a vendor-run specific-configuration result, not a universal gateway average, a RealBud benchmark or an estimate of our Internet detour. Do not adopt another gateway solely from this comparison.

Proposed matched live acceptance gates: added request-to-first-meaningful-chunk mean <=100ms and p95 <=150ms; streamed output throughput >=95% of direct; successful complete-workflow p95 <=5% slower. These are engineering proposals, not measured performance or a contractual SLA. Report first answer and first valid tool-call timing separately when applicable. For illustration, 100ms added to each of ten sequential calls totals one extra second before other effects. A nearby warm server, stream forwarding without buffering, and billing outside inference can reduce overhead; none guarantees these gates.

Pilot benchmark specification:

- Same admitted model/version where providers expose it; same prompt, tools, thinking level, output cap and stream settings. Record unavoidable differences rather than label different models equivalent.
- Synthetic fixtures for (a) priority classification/draft summary, (b) CSV reference reasoning with deterministic validation, (c) multi-step tool loop, and (d) image/native task when the route supports it.
- Compare provider-direct baseline with our gateway→the same provider/model. Probe Sydney and Singapore deployments with independent non-financial benchmark ledgers. Interleave at least 30 repetitions per route/time slot, with concurrency 1, 2 and 4. An aggregator comparison is optional later. Use a user-approved provider budget before paid tests.
- Record arithmetic mean plus p50/p95 first meaningful stream chunk, first answer/valid tool call, useful completion time, tool-roundtrip time, gateway admission/auth/DB overhead, timeout/error rate, verified usage, successful-task cost and cache-hit ratio. Retain raw timing samples, source/fixture identity and the chosen percentile method. Count incorrect/unsupported results as failures, not fast wins; show timeout and cold-start counts separately instead of excluding them from the result.
- Initial local admission/ledger target remains p95 under 50ms, excluding office lease/network/provider time. Measure direct and mediated paths from the same client, with warmed and cold runs separated. Only a matched hosted/client test can establish Internet overhead; loopback mock results cannot establish real office speed. Select Sydney/Singapore only after measuring their complete office-to-backend-to-provider path. Keep atomic reservations and authority checks synchronous where required; move invoice generation and payment calls off the inference path.
- Avoid a second LLM call solely to choose a model for simple routes. Use bounded deterministic rules. Stream without proxy buffering; keep connections warm. No synchronous Square/customer-portal calls on inference dispatch. Use indexed period/outstanding aggregates and paginated history instead of reparsing a tenant's whole ledger for every request.
- The mandatory live core authority lease needs authenticated outbound connectivity from the office; do not expose the customer's database or require open inbound home-router ports. Check current lease state locally per stream event and refresh/revoke through the supported transport, with explicit expiry and outage behavior. Do not silently replace revocable authority with a reusable static API key to win a latency benchmark.

Choose a route only after it passes workflow correctness and privacy/permission gates. Optimise **cost per successfully completed workflow**, not cheapest token or highest tokens/second in isolation.

## Margin policy and pricing example

Our operator settings can define a markup multiplier or explicit retail unit prices per provider/model, with customer-specific overrides. The gateway calculates the bill using a versioned, accepted retail rate card; Square does not calculate the markup. New pricing has an effective date and audit history, with retirement of superseded cards for new calls. Past usage retains its original price. Internal provider cost and margin stay private; customer-facing usage units, retail prices and totals remain clear.

For evaluation, **30% markup on the dated AUD provider unit-cost basis** is an illustration, not a selected rate. Include FX and provider-related fees in the costing basis; model cache/output rates separately. Publish stable GST-inclusive customer unit prices for acceptance rather than change charges silently with upstream prices or exchange rates. Hosting and Square payment fees belong in the operator contribution calculation even when absorbed in the care fee.

For illustration only: A$50 net provider cost × 1.30 = A$65 usage revenue excluding GST; customer usage total A$71.50 including GST. Add the existing A$125 GST-inclusive care fee: A$196.50 monthly total, before separately approved extra help/credits. A$15 is the spread before hosting, payment fees, service costs and income tax; it is not net profit. A 30% markup is 23.08% gross margin before those extra costs. At A$5 provider cost the same markup yields only A$1.50 before those costs. This is why the care fee remains meaningful; usage markup alone will not fund bespoke support.

Calculate pricing from unit costs, then apply the accepted retail card to metered units. Realised margin can vary with peak/off-peak pricing, cache hits and FX. Supplier absorbs unapproved cap overruns. Confirm provider-specific resale/API terms and data processing before enabling a customer route; a public price page is not reseller approval.

No global markup, customer price, auto-debit mandate or extra charge is activated by this document. Internal cost/margin policy is not displayed on invoices; units, retail rates, tax, credits and amount payable are.

## Monthly customer billing

Customer account area needs only: **This month's usage / Spending limit / Invoices / Downloads & setup / Support**. Show A$125 care separately from variable AI usage, included-month status and GST-inclusive total. Provider keys and internal margin remain operator-only.

1. Gateway meter records verified usage and immutable accepted price version. Daily reconciliation checks supplier evidence; unresolved usage is not guessed or blindly invoiced. Included usage is metered but produces no customer usage charge during the agreed included period.
2. Close the month once, group usage by model/rate/unit and provide a detailed statement, add the agreed care amount only when applicable, apply credits and calculate GST. Calendar month versus accepted-go-live anniversaries and first/last-month proration must be explicit. Select a documented verified-usage close/adjustment policy so an unresolved request does not indefinitely block unrelated care charges; never estimate a missing usage charge.
3. Map the tenant to our **Square customer and location**, create an **Orders API order**, then **one Square draft invoice** referencing it. Use durable idempotency keys, invoice versions and an outbox that reconciles an unknown API outcome before retry. Square is the canonical issued invoice/numbering authority; the gateway keeps a usage statement, not a competing second tax invoice. Aggregate line items and confirm Square limits. GST-inclusive accepted totals must reconcile exactly without adding GST twice.
4. Publish/send only under the user's authorised billing policy. Square generates its hosted payment URL after publication/scheduling; our portal shows that invoice link. Square manages invoice payments; do not separately charge its invoice order via the Payments API. Automatic card collection needs a separate customer mandate. The current local simulation remains default-off for external calls.
5. Validate Square webhook signatures over the exact raw body and registered notification URL, then reconcile server-side with mapped merchant/location, customer, order/invoice, AUD amounts and payment/refund evidence. Handle duplicate/late/out-of-order events, partial payments, balances, credits, cancellation, refunds and verified PayID/manual payments. A browser return is not payment proof; an invoice labelled paid is not automatically proof of a card transaction. Avoid duplicated receipts, credits or refunds.

Use the existing Square account's applicable Australian fees and invoice/tax settings when calculating contribution. Account configuration and credentials have not been verified by this plan. Do not carry over Stripe fee assumptions, API limits or payment semantics, or silently add a payment surcharge. Sandbox evidence and live paid invoice evidence remain separate gates.

## Delivery priority and measurable exit criteria

### Website billing MVP: report upload to customer invoice

Latest user priority: import provider usage/cost evidence into our website and easily export each customer's bill including our margin. This billing module is independent of how inference is delivered and must not wait for a proxy rollout.

One operator screen, **Billing**, with three steps:

1. **Upload report.** Accept a supported DeepSeek export and billing period. Validate the schema, currency, period/time zone and file limits before previewing anything. Map provider key identifiers to clients once, retaining dated mappings for rotated keys. Never require raw secret API keys. Flag unknown/ambiguous identifiers for review; do not assign them automatically or reveal another client's data.
2. **Review totals.** Show client, verified provider cost or explicitly identified rated usage, saved customer pricing/markup, applicable care fee, credits, GST and final AUD total. Internal cost and margin are operator-only. Show exceptions and permit correction before the bill is issued. Confirm an actual export's columns: the FAQ verifies per-key usage, not per-key monetary cost fields. If only tokens are provided, use a validated historical price/FX basis with cache/model/time distinctions; do not present estimated cost as a verified supplier charge or silently change accepted customer pricing.
3. **Generate invoice.** Prepare one invoice per client/period, with itemised AI usage, applicable care fee, tax, credits and payment details. Operator actions: preview, generate Square draft, issue/send when authorised, and download the issued invoice PDF or the supporting usage statement. Square remains the canonical invoice issuer; our own preview/statement is not a competing tax invoice. A PDF preview alone does not send a bill. Customer documents omit internal supplier cost and markup breakdown, but retain agreed charges and tax.

Save source hashes, mapping/rate/FX versions, immutable period close and Square references. Reimporting the same or overlapping report must not double bill. An imported provider report and existing live-meter data must reconcile to one source of billable usage, never be added together. Lock issued amounts; subsequent corrections require a tracked credit/adjustment. Included-period usage remains zero-charge. Decimal/minor-unit arithmetic and one explicit tax-rounding policy must reconcile the preview, Square order and issued invoice.

The user has clarified that the desired experience is **automatic synchronisation**, not monthly manual uploads. Keep CSV import as a reconciliation/recovery fallback rather than describe it as the completed product. Separate the integration capabilities:

- **Automatic supplier balance:** DeepSeek documents authenticated `GET https://api.deepseek.com/user/balance`, returning availability and total/granted/topped-up balances by currency. Our backend can poll it periodically and display the last successful update, currency and stale/error status, with configurable low-balance alerts. It is account-wide, not a separate balance per client/key. Never infer per-key spending from aggregate balance differences because top-ups, grants and other keys can change the balance. Keep the supplier balance operator-only and API secrets server-side; polling is independent of inference.
- **Automatic historical per-key charges:** no supported public usage/cost-history API was found in the reviewed current API reference or FAQ. The FAQ confirms the Usage key filter/export and Billing invoice UI, not an automated billing-history contract. Do not label private dashboard endpoints or browser-session automation as an official stable API. Verify an available provider-supported integration before promising unattended direct-key billing; do not access authenticated endpoints or automate the account from this planning request.
- **Automatic usage captured by RealBud:** model responses contain usage data. A server-side forwarding path can record this authoritatively for calls it handles; a direct-call desktop can upload local records asynchronously but these can be missing, modified or bypassed and need independent provider reconciliation before final billing. Neither approach silently supplies missing historical provider charges. Missing final usage keeps a request unresolved rather than estimated into an invoice.
- **Automatic customer billing preparation:** once the source is reconciled, the website can apply accepted pricing, prepare the period close and Square draft automatically. Invoice issuance/sending or charging follows an explicitly configured operator policy; none is activated here.

Implement the balance adapter and scheduler seam with synthetic fixtures, bounded polling/backoff and default-off external transport. Keep provider-history sync behind an explicit unsupported/unconfigured state until verified. Production import/sync acceptance requires actual provider evidence and a reconciled supplier-period total. No customer reports, provider credentials, Square writes or invoice sends have been accessed/authorised by this planning update.

**Now:** narrow the existing work to website billing plus the minimum API forwarding/metering module; avoid a separate routing product or dynamic routing engine. Agree core grant/lease and signed child-model-call identities; complete Hermes tool-call transport; direct DeepSeek/Kimi adapters with provider fixtures, capability admission and cost reconciliation; isolated Square Orders/Invoices adapter with injected mock fixtures and default-off network transport; readonly portal/auth design against the existing website; benchmark harness that defaults offline. Each belongs to the current responsible build task, not another parallel implementation. The nested `website/` is a separate Git repository and was not included in the gateway's earlier source snapshot; coordinate its ownership and Sites runtime constraints explicitly. Do not port Node SQLite into the website runtime or add another public application just to make the packaging look unified.

**Next, with selected accounts and approved tests:** authenticated portal, low-budget provider benchmarks, Square sandbox invoice/settlement/refund proof, durable deployment/backup/restore and replay-fencing rehearsal, and installed host+peer end-to-end checks. Paid provider tests, domain purchase, deployment and invoice sending need their own existing or explicit authority.

**Pilot launch:** each person completes the three agreed workflows; zero cross-tenant access or duplicate debits in fault tests; cap enforcement survives concurrent requests, restart and uncertain results; totals reconcile to cents; invoice and verified payment match; no prompt or secret retention in application/proxy logs. Both customer desktops and supported OS installers remain separate evidence gates.

**Later:** more providers, routing tuned by observed performance, team billing reports, high availability/central Postgres and additional customer products sharing the same internal gateway. No public API marketplace, GPU hosting, autonomous model switching with unapproved data recipients, or another portal per customer in MVP.

Measure at first paid-month close: successful workflow rate, p95 useful completion time, cost and contribution per tenant, unknown-usage queue age, billing corrections/disputes and time spent on support. Research confidence is medium: current source and primary docs are available; actual traffic volumes, model quality/latency, production accounts and customer rate acceptance are not. Do not fabricate customer interviews or numerical RICE evidence.

## Primary references checked

- DeepSeek models, capabilities and variable pricing: https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek thinking/tool continuation: https://api-docs.deepseek.com/guides/thinking_mode/
- Kimi K3 official model ID and continuation requirements: https://github.com/MoonshotAI/Kimi-K3
- DeepSeek key handling terms, §2.2: https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html
- DeepSeek official FAQ, “How to view usage by API Keys” (content verified in the FAQ's publicly linked JavaScript bundle): https://static.deepseek.com/faq/index.html?lang=en
- DeepSeek account balance API: https://api-docs.deepseek.com/api/get-user-balance/
- Kimi customer applications and API key transfer terms, §§1 and 3.4(9): https://platform.kimi.ai/docs/agreement/modeluse
- Kimi project usage, shared balance and delayed budget enforcement: https://platform.kimi.ai/docs/guide/org-best-practice
- Current direct API performance comparison: https://artificialanalysis.ai/models/comparisons/deepseek-v4-1-flash-vs-kimi-k3
- Benchmark workload, median, region and token definitions: https://artificialanalysis.ai/methodology/performance-benchmarking
- Vendor-run proxy processing benchmark, mock upstream: https://www.getmaxim.ai/bifrost/resources/benchmarks
- OpenRouter current pricing: https://openrouter.ai/pricing
- OpenRouter routing options: https://openrouter.ai/docs/guides/routing/provider-selection
- Vercel gateway pricing: https://vercel.com/docs/ai-gateway/pricing
- Cloudflare gateway pricing: https://developers.cloudflare.com/ai-gateway/reference/pricing/
- Fly regional availability: https://fly.io/docs/reference/regions/
- Render regions (Singapore alternative): https://render.com/docs/regions
- Square invoice workflow and payment constraints: https://developer.squareup.com/docs/invoices-api/overview
- Square draft/publication flow: https://developer.squareup.com/docs/invoices-api/create-publish-invoices
- Square webhook validation: https://developer.squareup.com/docs/webhooks/step3validate
