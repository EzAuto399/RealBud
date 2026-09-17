# RealBud forwarding and billing — phase 2

15 September 2026. **Local, synthetic proof.** This is a small server-side service for the existing RealBud website and office integration. Fixed provider adapters, metering and billing remain internal implementation details. It is not a new public routing product. No provider keys are distributed to clients.

## Implemented scope

- Signed child model calls share an immutable job-attempt budget and parent deadline. SQLite v1 records and event bytes survive migration to v2.
- Direct DeepSeek and Kimi K3 adapters handle the supported text/thinking/function-tool stream, preserve the complete supported assistant continuation and normalize integer usage. Every provider adapter requires an explicitly injected transport; no default network fetch or secret lookup is enabled.
- Square owns the eventual tax invoice. Local usage statements feed an order-first, draft-invoice flow with immutable accepted AUD/GST totals, durable outbox records, read-only reconciliation, URL/raw-body signature verification, partial/manual payments and refunds. There is no publish, send, Payments API charge or refund-creation method.
- A private DeepSeek account-balance poller exposes freshness/errors and bounded backoff. It does not derive client costs from balance changes. Automatic historical per-key costs remain unsupported/unconfigured.
- Report import is a fallback seam with **synthetic JSON fixtures only**. No actual DeepSeek CSV/ZIP schema or monetary columns are claimed. It validates dated nonsecret key mappings, explicit cost/FX/pricing or accepted unit rates, review digests, overlaps, included periods and immutable close. Report and live meter cannot both charge the same customer month.

The nested website repository and all core runtime/member/device/UI files remain outside this task's edits. The original 55-test evidence, original patch and coordination receipt remain unchanged. Current checks and source hashes are in [evidence/phase2/verification.json](evidence/phase2/verification.json).

## Core contract: H09 / W05 / S02

Core agreed these fields and owns their authoritative issuance. Use the existing canonical Ed25519 envelope with all v1 fields, plus:

```text
schema=2, grantVersion=2
modelCallId
maxAttemptSpendNanoAud
attemptExpiresAt
provider
allowedModels=[{provider,model,capabilities:[text,tools]}]
```

`attemptId` stays fixed across the tool loop. Each new logical inference gets a distinct `modelCallId`, request idempotency key and signed digest of the full canonical request, including thinking history, tools and tool replies. `legacy` is reserved. The selected provider/model/capabilities must be inside the signed parent scope. A tool-capable request requires v2; tool execution permission remains in core's exact job/account/resource boundary.

The first child pins company, member, installation, device, licence, job, attempt, revision, authority version, account/resource, issuer key, allowed model scope, attempt deadline and spend ceiling. Later children must match. The per-call authorization also pins model, rate version and per-call ceiling. Renewed signatures may change `jti`, `iat` and `exp`, but cannot increase any saved budget, extend the parent deadline or restore revoked authority. The original reserved call deadline is never extended at dispatch.

Retries with the same child, keyed request fingerprint and idempotency key return persisted state. Changed content or authorization conflicts. An uncertain dispatch remains held and is never automatically sent again. Distinct children share:

```text
settled retail + outstanding reservations + proposed reservation <= attempt ceiling
```

The tenant monthly cap and concurrency checks still run in the same SQLite transaction. Credits do not replenish authorization. Provider overruns are absorbed rather than increasing customer liability. Migration copies v1 request bodies unchanged; any attempt containing a legacy call cannot acquire v2 children.

`ExecutionAuthority` is required. Core must supply a locally revocable lease backed by authenticated outbound office connectivity, tied to the current member/device/job. `assertCurrent()` is called before protected work and stream forwarding; the interface does not require a remote RPC per token. There is no permissive production authority. Central company/device execution and installed two-device proof remain core gates.

## Direct provider transport and private continuation

`direct-provider.ts` uses only the fixed official DeepSeek and Moonshot endpoints. `tools-v1` messages support system/user text, complete assistant `content`, `reasoning_content`, `tool_calls`, and tool replies with `tool_call_id`. Tool IDs/replies and function definitions are validated. Kimi K3 requires thinking history; DeepSeek thinking/tool requests preserve it as well. DeepSeek tool-message continuation also requires non-null content, following its current integration guidance; an incompatible response is held for reconciliation. Unknown assistant fields, unsupported usage fields, malformed/truncated tool output, changed provider identity or incomplete usage fail closed.

Reasoning and tool arguments are accumulated in bounded memory. The complete supported assistant message is forwarded to the authorized worker after current-authority checks and settlement. It is never written to SQLite, billing events, statements or portal usage. This adapter proposes no tool execution itself. Vision, computer-use compatibility, provider-specific extensions and end-to-end Hermes behavior are not proved by these fixtures.

Input reservations use a configured **provider-enforced full context ceiling**, including framing and tools. The 100-token ceiling is synthetic test data. Production must verify real model limits; smaller affordable reservations require a verified tokenizer or provider-enforced bound. No character-count estimate is used. Full-context reservations can reject otherwise affordable calls. Long thinking is still bounded by the five-minute call grant; automatic continuation/renewal is not implemented.

DeepSeek cached/uncached prompt tokens are disjoint; nested cached/reasoning details are cross-checked. Kimi cached tokens are subtracted from prompt total. Reasoning is already part of output tokens and is not added twice. Route versions fail on unexpected served model IDs. Temporal provider-cost reconciliation and moving-alias admission remain production work; no production rate, margin or provider account is selected here.

## Website billing seams

### Automatic supplier health

`DeepSeekBalancePoller.status()` and `.poll()` are operator-only seams. With no transport they stay disabled and do not read credentials. An injected successful poll calls only `GET /user/balance`, preserves decimal USD/CNY balances, and records the update time. One in-flight request is shared. Normal spacing is 60 seconds, data becomes stale after 120 seconds, and failed polls retain the last snapshot with an error and exponential backoff capped at ten minutes. The owning service clock must invoke polling; this module starts no scheduler or background process. Poll state is currently in memory and starts unknown after restart.

**Account balance is not client usage.** No verified automatic historical per-key usage/cost connector is configured, no private dashboard endpoint is scraped, and provisional client-uploaded usage is not an authoritative bill. Automatic direct-key cost billing remains incomplete. The public API reference and FAQ were checked again: per-request usage, account balance, dashboard key filtering and exports are documented, but a supported historical per-key cost endpoint was not verified. The precise dependency is a provider-supported read-only history API or automatic report feed with auth scopes, key identifiers, interval/timezone, cache/model/currency/cost fields, cursors and correction/finality rules. [Research receipt](evidence/phase2/history-connector-research.json). Provider confirmation may resolve this gap; no support message was sent.

### Report fallback and period close

Operator methods: `mapKey`, `recordPolicy`, `preview`, `commit`. Customer-safe preview strips supplier costs, key references, FX and margin. `realbud-synthetic-report-v1` is intentionally the only parsed format. Dated mapping windows permit key rotation and reject ambiguous ownership. Rows cannot cross a Brisbane month or included-service boundary. Missing source costs cannot be labelled verified; usage-only rows need accepted unit rates. Pricing is versioned and explicit, with no default markup.

Commit revalidates the preview atomically. Same report is idempotent; overlapping intervals are blocked. If live requests exist for that customer month, report billing requires reconciliation and adds no charge. Once report mode is committed, new live-meter reservations for that month are denied. This conservative boundary avoids double billing while a per-request reconciliation connector is absent.

`SquareBilling.closeStatement` aggregates measured/imported usage by model and rate version, adds explicitly agreed A$125 care, applies unused credits and rounds once to cents. Included usage is zero-charge. Unknown calls remain reserved and listed as deferred; later settled usage carries to a later statement. Closed periods and accepted totals cannot be edited. Customer acceptance is a separate exact statement digest, not implied by recording a private pricing policy.

Square draft composition currently uses one gross line referencing the detailed usage statement with 10% inclusive GST. Both returned order total/GST and computed invoice amount must match. More detailed Square line layouts and final Australian tax/account configuration need sandbox validation. Negative/zero statements require a separate adjustment path and cannot become payment requests.

### Square reliability and money proof

Tenant → merchant/customer/location mappings are immutable and collision-checked. Draft preparation verifies the mapped seller and active AUD location with injected reads. Order and invoice requests have persisted idempotency keys before dispatch. Concurrent/repeated clicks cannot claim an uncertain write again. Unknown outcomes require an explicit candidate-ID GET reconciliation; the same accepted statement and saved request remain authoritative. This slice cannot publish the draft.

Webhook verification uses constant-time HMAC-SHA256 over the exact registered URL plus raw body. Authenticated payment/refund retrieval checks IDs, merchant/location, customer/order/invoice and AUD totals. Duplicate event IDs and transaction IDs cannot create additional receipts. Pending observations create no money. Partial CARD and Square-recorded CASH/EXTERNAL payments are supported; their classification is retained. A Square-recorded manual payment is not independent bank or PayID verification. Invoice status or browser success alone records zero money.

Refund totals cannot exceed the original payment, and completed refunds are recorded once. No refund is initiated. If invoice credits coexist with a Square refund, close stops at `refund_credit_allocation_required`: linking a refund to a credit/adjustment is not yet implemented, so both cannot silently benefit the same charge. Overpayments/cash rounding differences, cancellations, disputes, statement corrections, and issued-invoice PDF export need explicit later reconciliation/adapter work.

## Local latency evidence

See [latency.json](evidence/phase2/latency.json) for all samples, arithmetic means, p50/p95, route baselines, paired overhead, startup labels, failure counts and source hashes. The benchmark uses the actual HTTP gateway, signed v2 grants, required authority checks, request validation, SQLite WAL/FULL reservation/settlement and the direct Kimi adapter with an injected timed SSE provider. Square is absent from inference.

There are 24 measured three-call workflows per route per scenario, six warm-up batches, concurrency 1/2/4 and starting ledgers of 0/1,000 real synthetic settled requests. The small ledger grows during measurement; exact row counts are recorded. Direct/gateway batch order alternates. Pairing is by matching batch position across sequential runs. First meaningful output excludes reservation/reasoning events. Completion includes continuation and settlement. This is local loopback evidence, not an existing RealBud production average or Australia-to-provider latency.

### Added time to first meaningful output

| Starting ledger | Concurrency | Mean (ms) | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- |
| 0 | 1 | 2.34 | 2.35 | 4.11 |
| 0 | 2 | 2.99 | 2.80 | 5.08 |
| 0 | 4 | 6.40 | 5.57 | 11.58 |
| 1,000 | 1 | 8.12 | 7.49 | 10.62 |
| 1,000 | 2 | 11.55 | 11.31 | 14.93 |
| 1,000 | 4 | 19.51 | 19.31 | 24.89 |

### Added time to complete the first model call

| Starting ledger | Concurrency | Mean (ms) | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- |
| 0 | 1 | 3.22 | 2.92 | 6.94 |
| 0 | 2 | 3.48 | 2.96 | 6.29 |
| 0 | 4 | 7.40 | 5.94 | 11.85 |
| 1,000 | 1 | 8.85 | 9.03 | 11.46 |
| 1,000 | 2 | 12.88 | 12.92 | 18.21 |
| 1,000 | 4 | 23.16 | 21.56 | 34.78 |

### Added time for the three-call workflow

| Starting ledger | Concurrency | Mean (ms) | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- |
| 0 | 1 | 8.05 | 7.61 | 13.11 |
| 0 | 2 | 8.24 | 7.25 | 14.09 |
| 0 | 4 | 14.53 | 15.44 | 22.01 |
| 1,000 | 1 | 22.96 | 22.94 | 27.67 |
| 1,000 | 2 | 30.34 | 29.59 | 37.50 |
| 1,000 | 4 | 44.84 | 43.24 | 54.29 |

The initial run is retained separately as `latency-initial.json`. Database-reopen timings include integrity verification in a warm process; first-server request timings are also recorded. Neither is a process-cold or OS-cache-cold measurement. Short synthetic chunks do not prove model token throughput. Required financial checks have not been removed to improve these numbers.

Proposed future matched-live gates remain **targets**: added first-meaningful mean ≤100 ms and p95 ≤150 ms, output throughput ≥95% of direct, and successful workflow p95 ≤5% slower. The current very short mock workflow does not satisfy a 5% relative-overhead target; absolute overhead, network placement and real model duration must be measured together. Growing whole-history scans and startup hash verification need a bounded indexed projection/pagination strategy before scale claims.

## Verification and remaining gates

The current focused test log and gateway TypeScript check are under `evidence/phase2/`. Tests include v1 migration byte preservation, two independent Node processes contending for an attempt budget, changed-parent/retry denial, provider continuation privacy, Square uncertain writes and payment faults, import overlaps/double-billing fences, and balance staleness/backoff. No tests are skipped. Prior app typecheck and demo evidence remain the original checkpoint; the new service is not imported into desktop packaging.

Still required: actual provider export schema/history connector; production pricing and accepted agreements; authoritative company/device lease implementation; live provider/model/tool admission; website authentication/BFF/UI integration; Square account mapping, sandbox tax/payment/refund/cancellation proof and issued PDF handling; durable deployment/backup/replay fencing; and installed macOS/Windows plus each workflow on both devices. No account reads, provider inference calls, Square writes, customer messages, publication or deployment occurred.

## Primary sources checked

- [Kimi K3 official repository](https://github.com/MoonshotAI/Kimi-K3) — model ID and complete preserved assistant history.
- [Kimi Chat API](https://platform.kimi.ai/docs/api/chat) — endpoint, streaming and cache usage.
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/) and [thinking/tool guide](https://api-docs.deepseek.com/guides/thinking_mode/) — usage fields and reasoning continuation.
- [DeepSeek integration guidance](https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/) — non-null assistant content and preserved reasoning for tool continuation.
- [DeepSeek balance API](https://api-docs.deepseek.com/api/get-user-balance/) — account availability and decimal balances.
- [Square invoices overview](https://developer.squareup.com/docs/invoices-api/overview), [create order](https://developer.squareup.com/reference/square/orders-api/create-order), [create invoice](https://developer.squareup.com/reference/square/invoices-api/create-invoice) — order before invoice, draft lifecycle, API version 2026-08-19.
- [Square webhook validation](https://developer.squareup.com/docs/webhooks/step3validate), [Payment](https://developer.squareup.com/reference/square/objects/Payment), [PaymentRefund](https://developer.squareup.com/reference/square/objects/PaymentRefund) — raw signature, partial/manual source classification and refund evidence.
