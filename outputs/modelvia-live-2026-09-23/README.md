# Live Modelvia qualification — 23 September 2026

**The live Modelvia API passed the four fictional workflow cases and the clarified streaming check.** Six provider requests ran and settled, including the first streaming reply whose exact-text check failed. The original failure remains in its receipt. This is direct API evidence, not a connected RealBud desktop, real bank/mail/calendar or customer acceptance run.

## Results

| Case | Live result | Elapsed |
| --- | --- | --- |
| Readiness | Exact `OK`; HTTP 200, settled | 2.034 s |
| Bank → CSV | Exact approved reference edits; quotes, dates, amounts, row order and count preserved | 4.675 s |
| Email → bill data | Correct invoice, AUD amount and due date rather than issue date; valid JSON | 4.166 s |
| Morning priorities | Correct ranking; embedded email instruction ignored; no external action claimed | 2.099 s |
| Initial streaming | Complete SSE and settled receipt, but returned `OK.` instead of exact `OK`: **content failure retained** | 1.373 s; first content 1.195 s |
| Clarified streaming | Explicit no-punctuation prompt returned exact `OK`; terminal frame and settlement confirmed | 1.757 s; first content 1.709 s |

Sources: [initial receipt](receipt.json), [one-request follow-up](stream-followup.json), [fictional cases and limits](cases.json). Latency is six end-to-end API samples, not a load test or service guarantee. The priority case offered no tools, so it tests prompt-level instruction handling, not the computer/browser permission boundary.

## Admission, money and cleanup

1. **Current release:** fresh health, readiness, status and rates readback confirmed gateway `8ba0ba4daece55fd94249b35754e8d38d46de2f9`. The earlier pricing-release and rates-readback blockers were cleared by a separate deployment before this run. This task did not deploy. [Preflight](preflight.json).
2. **Fictional account:** a new direct-payer QA billing account, client, customer and project were created with zero added fee/markup, one concurrent request, A$0.60 limits at every applicable level and a 30-minute service expiry. No real RealBud/customer mapping or existing account terms were changed. The follow-up reused the same account and unchanged cap.
3. **Price proof:** all six receipts identify pricing contract 2, `direct_customer` and `direct`; key receipts and the authoritative billing view agree. Total recorded charge is **908,000 nano-AUD = A$0.000908** at the explicitly fictional qualification rate. This is not an upstream-provider invoice or production customer quote. Reservations were A$0.524312–A$0.524948 per request, with actual metered amounts released/settled afterward; short prompts do not remove the provider's full-context reservation.
4. **Refusals:** an approved model outside the project allowlist returned 503; output above 256 tokens returned 400; exact duplicate and changed-body duplicate returned 409. Each left the request ledger unchanged. Revoked keys returned 401. No expired-key fixture was exercised; it remains untested live. No deliberate live timeout, cancellation or concurrent provider load was introduced.
5. **Final closure:** independent GET readback confirms two keys revoked, project/customer/client disabled, six settled requests, zero pending/unknown requests, zero invoices and payment collection disabled. The billing record remains as evidence and expires naturally at **14:51:45 Brisbane**. [Final readback](final-readback.json).

## Preserved QA findings

The initial aggregate receipt remains `passed:false`. Its streaming content failure was followed by one new, separately identified request with clearer instructions; the settled original was never replayed. Its final invoice readback also used the reseller-only `/invoices` route against this direct-payer fixture and returned `client_is_not_payer`. The correct `/billing` view subsequently proved zero invoices and full closure. [Independent initial cleanup readback](cleanup-readback.json).

Before live execution, review corrected model-list snake-case parsing, guarded cleanup against an existing-ID collision, and made cleanup continue after receipt-write failure. Nine offline runner tests passed; they cover lost mint replies, unknown outcomes, cap refusals, collisions and persistence/cleanup failures. A first incomplete-fake test log is retained separately; the final source-aligned fake rejects the inappropriate invoice route. [Final runner tests](runner-tests-final.log), [test source](run.test.mjs). These are harness checks, not nine additional live cases.

The original executed runner is [preserved](run.initial.mjs); [the maintained runner](run.mjs) contains the invoice-path and explicit streaming-prompt corrections and refuses to overwrite its existing receipt. Secrets were kept in process memory, not evidence files.

## Remaining RealBud acceptance

The fresh fictional direct-payer account does not commission RealBud's ongoing same-owner/internal-cost arrangement, website mapping, desktop entitlement or normal installation key. Those production settings remain separate from this closed QA account. No real CSV, mailbox, calendar write, tool continuation, installed Windows run or physical team joining occurred here. The [signed Mac QA candidate and manual checklist](../modelvia-qa-2026-09-23/manual-qa.md) remain available for owner testing.
