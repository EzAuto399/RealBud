# RealBud v0.21 commercial delivery plan

Date: 2026-09-01
Status: approved direction, execution and live proof incomplete
Decision owner: founder
Delivery owners: product, engineering, website, named pilot PM

## Executive decision

RealBud is close to a source-ready product, but it is not yet a fully proven commercial product. The remaining work is a controlled bridge from strong local evidence to an installed, named-office, paid pilot with measurable time returned and no unauthorised side effects.

Hermes v0.21 is an input to that bridge. It is not a reason to replace RealBud's product model or expose every upstream feature. We will selectively adopt improvements that make Bud safer, more observable, faster, and cheaper. RealBud remains the governed property-management layer. The PM remains the authority for sends, payments, notices, and portal submission.

## Problem, evidence, and success

### Problem

Property managers lose time checking routine work across exports, inboxes, maintenance, owners, and portals. General agents can generate text, but they do not provide the bounded authority, evidence trail, or recovery behaviour required for property-management work.

### Evidence already available

- RealBud can inspect PMS exports, prepare exception cards and drafts, and preserve an explicit human decision boundary.
- The core source and automated test suite cover local happy paths and important exception paths.
- A packaged Mac build and local release work exist.
- The website already has a focused pilot proposition and a non-transactional lead path.

### Evidence still required

- Exact credential and provider identity under real profile configurations.
- Durable, retry-safe delivery outcomes for any external channel.
- Exact-origin browser authority and a bounded portal recipe.
- An isolated Hermes v0.21 canary with a proven rollback to v0.20.3.
- Installed-app proof across restart, recovery, and the named PM's normal workday.
- A named-office shadow pilot using current data and an agreed source-of-truth export.
- Commercial proof that time saved is valuable enough to support the proposed price and gross margin.

### North star

**Verified PM minutes returned per active portfolio per week.**

Minutes count only when the PM confirms that RealBud replaced a real check or preparation step without creating rework or an unauthorised side effect.

### First commercial success criteria

- At least 120 verified minutes returned per named PM per week by week four.
- At least 95 percent of pilot work items end in a clear outcome: cleared, held with reason, allowed, denied, or explicitly abandoned.
- Zero unauthorised sends, payments, notices, portal submissions, or cross-agency data exposure.
- Less than 5 percent of completed items require material factual correction.
- Managed model and infrastructure cost stays below 20 percent of recurring revenue.
- The named PM wants to continue as a paying user after the design pilot.

## Product boundary

RealBud observes, correlates, prepares, queues, and explains. It does not become the legal or money system of record.

Always human-controlled:

- send or publish a message
- pay, allocate, disburse, or reconcile money
- issue a notice or make a licensing judgment
- submit a portal form
- expand access to a new source, agency, or portfolio

These safety boundaries are product policy, not premium features. They are never paywalled.

## Hermes v0.21 adoption map

| Upstream capability | Decision | RealBud use | Gate before use |
|---|---|---|---|
| Credential redaction and security fixes | Adopt | Reduce secret exposure in worker errors and diagnostics | Isolated profile tests and log review |
| Stalled-provider recovery | Adopt | Recover a Bud turn without duplicating work or hiding the failure | Idempotent work-item receipt and forced-failure test |
| Observability and richer model metadata | Adopt | Show provider health, model identity, latency, usage, and failure class | Sanitised event schema and cost reconciliation |
| Structured subagent steering and schemas | Adapt | Parallel internal research or classification inside one bounded work item | Shared budget, cancellation, schema validation, no external authority |
| Cost reporting | Adapt | Per-workflow cost ledger and managed-AI margin guardrail | Provider usage reconciliation and missing-usage state |
| In-app browser | Adapt | Read or prefill one allow-listed portal recipe | Exact origin, typed tools, lease, expiry, human Submit |
| Messaging relay | Adapt | Deliver approved copies and receipts through RealBud's channel contracts | Durable queue, deduplication, retry receipt, per-channel permissions |
| Cron memory | Adapt later | Inform scheduling internals only | Existing Routine ownership remains canonical |
| MCP centre | Avoid as a product surface | No generic connector marketplace in the pilot | Add a connector only for a named workflow and owner |
| Bot Mode and peer networks | Avoid for now | No autonomous office-wide swarm | Reconsider only after multi-PM governance proof |

The production pin remains v0.20.3 until the v0.21 canary completes. A release announcement is not compatibility proof.

## Commercial ladder

All figures below are internal hypotheses until a named buyer validates them. Do not publish them as fixed prices yet.

### 1. Paid design pilot

- One agency, one named PM, one data source, and up to three agreed workflows.
- Two to four weeks with weekly outcome review.
- Hypothesis: AU$1,500 to AU$3,000 setup and enablement, plus AU$149 per named PM for the pilot month.
- Deliverable: measured baseline, verified minutes returned, exception accuracy, cost ledger, and a continue or stop decision.

The setup fee pays for data mapping, workflow tuning, training, and proof work. It prevents RealBud from subsidising custom implementation for buyers who are not committed.

### 2. Solo

- One PM, one agency workspace, core export checks, Desk, drafts, schedules, and approval receipts.
- Hypothesis: AU$129 to AU$179 per month per named PM.
- Bring-your-own model key by default. Managed AI is an optional metered allowance after cost proof.

### 3. Agency

- Shared governance, team visibility, portfolio scopes, approved templates, and office-level reporting.
- Hypothesis: AU$499 per month for three named PM seats, then portfolio or seat bands.
- Launch only after multi-PM permission and cross-portfolio isolation tests pass.

### 4. Training and channel partners

- Partner-led enablement with governed templates and a defined support boundary.
- Hypothesis: annual seat commitments at 25 to 40 percent wholesale discount.
- No white-label or reseller promise before support load and tenant isolation are measured.

### Unit economics guardrails

- Gross margin target: at least 75 percent after model, infrastructure, and direct support.
- Managed AI variable cost warning at 15 percent of recurring revenue and hard review at 20 percent.
- Setup work must be paid or reusable across the product. Unbounded bespoke portal work is out of scope.
- Expansion revenue follows measured portfolio value, not token volume.

## Funnel and website job

The website should move one credible property-management buyer into a qualified paid pilot conversation. It should not imply universal PMS support or public availability.

Funnel:

1. Buyer recognises the morning-check problem.
2. Buyer sees a truthful example and the authority boundary.
3. Buyer chooses one workflow and identifies their PMS and portfolio shape.
4. RealBud qualifies source access, decision owner, urgency, and a measurable baseline.
5. Both parties agree a paid design pilot or make a fast no-fit decision.
6. A successful pilot converts to Solo or Agency. An unsuccessful pilot stops cleanly with no live integration left behind.

## Public claims matrix

| Website label | Safe claim | Evidence needed |
|---|---|---|
| Available in a supervised pilot | Import a current export, check routine money work, prepare exception cards and drafts, and keep the PM in control | Source and local workflow evidence plus pilot contract |
| Named pilot workflow | Owner updates, inbox and maintenance triage, or a bounded portal prefill for the agreed office | Named source, permissions, shadow run, recovery and receipt proof |
| Planned after proof | Managed AI, agency team controls, expanded provider support, and partner distribution | Cost, isolation, support, and multi-PM proof |
| Not offered | Autonomous payments, notices, sends, universal portal submission, or unsupervised office bots | Outside current product boundary |

## Delivery sequence

### Now: release prerequisites

1. Make model status exact to the configured provider. Never infer readiness from an unrelated credential.
2. Compare browser targets against exact allowed origins. Reject prefix lookalikes, scheme changes, and port changes.
3. Make external channel delivery durable, deduplicated, retry-safe, and visible after restart.
4. Add sanitised per-work-item usage, latency, provider, and outcome records.
5. Return the full typecheck and focused safety tests to green.
6. Publish the website's pilot, proof-state, workflow, and commercial ladder without claiming unproven availability.

Exit gate: all release-prerequisite checks green, no known credential ambiguity, and no external action without a durable receipt.

### Next: isolated v0.21 canary

1. Install v0.21 beside the production pin in a new Hermes home and profile.
2. Apply the RealBud pack to the canary only.
3. Replay the same demo and exception corpus on v0.20.3 and v0.21.
4. Force provider timeout, cancellation, malformed output, restart, and duplicate retry.
5. Compare outcome, latency, token or cost record, redaction, and final receipt.
6. Run one read-only installed-app shadow day.
7. Promote only if the canary improves or preserves every safety and recovery gate.

Rollback: stop the canary, retain its sanitised evidence, and continue using the current v0.20.3 production pin. Never rewrite the working profile in place.

### Then: named-office paid pilot

1. Complete the eight office fields with a real agency and named PM.
2. Record a one-week baseline for the chosen routine.
3. Map one stable source and run read-only shadow checks.
4. Add no more than three agreed workflows.
5. Review outcomes, corrections, time returned, and cost weekly.
6. End with an explicit continue, change, or stop decision.

Rollout: one PM, then 10 percent of the agreed book, then 50 percent, then the full agreed book. Each stage requires clean receipts and PM sign-off. Do not jump from a demo book to an office-wide rollout.

### Later: repeatable growth

- Convert proven workflows into reusable onboarding recipes.
- Introduce Agency only after permission and portfolio isolation proof.
- Add managed AI only after cost reconciliation is reliable.
- Recruit training or channel partners after support effort is known.
- Use outcome evidence, not generic agent capability, as the marketing engine.

## Prioritisation

RICE score uses reach x impact x confidence divided by effort. The numbers are relative planning values, not forecasts.

| Work | Reach | Impact | Confidence | Effort | RICE | Order |
|---|---:|---:|---:|---:|---:|---:|
| Exact provider credential status | 10 | 3.0 | 0.95 | 1 | 28.5 | 1 |
| Exact browser origin authority | 8 | 3.0 | 0.95 | 1 | 22.8 | 2 |
| Durable channel delivery receipts | 8 | 3.0 | 0.80 | 4 | 4.8 | 3 |
| Sanitised usage and outcome ledger | 10 | 2.0 | 0.80 | 4 | 4.0 | 4 |
| v0.21 isolated canary | 8 | 2.0 | 0.75 | 4 | 3.0 | 5 |
| Named-office paid pilot | 5 | 3.0 | 0.70 | 4 | 2.6 | 6 |
| Agency plan and partner channel | 3 | 2.0 | 0.50 | 6 | 0.5 | 7 |

## Test and observability contract

Every promoted workflow needs:

- a stable work-item id and idempotency key
- input source, freshness, and portfolio scope
- provider and model identity without secret material
- start, completion, cancellation, retry, and final outcome timestamps
- usage and cost when supplied, plus an explicit unavailable state when not supplied
- a durable decision or delivery receipt
- restart and replay coverage
- clear empty, held, partial, failed, and recovered states in the UI

Required proof buckets remain separate:

1. source and unit tests
2. packaged app
3. installed app on the target OS
4. named-office shadow workflow
5. approved live workflow
6. production rollout

Passing an earlier bucket never implies a later one.

## 30, 60, and 90 day scorecard

### 30 days

- Release prerequisites green.
- Website producing qualified pilot conversations.
- v0.21 canary decision recorded.
- One named paid pilot contracted or a documented no-fit decision.

### 60 days

- At least one pilot reaches 120 verified minutes returned per PM per week.
- Zero unauthorised consequential actions.
- Cost ledger covers at least 95 percent of completed Bud turns.
- Two workflows are reusable without engineering intervention.

### 90 days

- At least three paying named PMs or a deliberate pivot based on evidence.
- At least 75 percent gross margin on recurring usage.
- Measured conversion from qualified pilot to continuing subscription.
- Agency tier decision based on actual multi-PM demand and permission complexity.

## Pre-mortem

| Failure | Early signal | Prevention | Recovery |
|---|---|---|---|
| Website creates interest but no qualified pilots | Forms lack a named source, owner, or urgent routine | Qualify PMS, portfolio size, routine, authority, and start window | Narrow the target and offer a paid workflow diagnostic |
| Bud appears connected but uses the wrong credential or model | Status and provider readback disagree | Exact-provider checks and explicit unavailable states | Hold all work, repair profile, replay from receipts |
| Retry causes duplicate delivery | Two external ids for one work item | Durable idempotency and provider readback | Reconcile, disclose, and disable the channel until fixed |
| Browser automation exceeds scope | Redirect or origin differs from manifest | Exact origins, typed tools, lease expiry, human Submit | Revoke lease and return the item to held |
| Pilot saves time but support destroys margin | Repeated bespoke mapping and manual rescue | Paid setup, workflow cap, reusable recipes, cost ledger | Raise setup price, narrow support, or stop the segment |
| New upstream features dilute RealBud | Roadmap fills with generic bot and connector surfaces | Existing-owner rule and named-workflow gate | Remove unused surface and return to the PM outcome |
| Local green tests are mistaken for commercial readiness | No named PM or restart evidence in the release decision | Proof-bucket checklist in every launch review | Stop rollout and reopen the exact missing gate |

## Immediate owner checklist

- Founder: approve the paid pilot range and choose the first named office.
- Product: qualify one routine with a measurable weekly baseline.
- Engineering: finish the release prerequisites and v0.21 canary evidence.
- Website: publish the supervised-pilot offer and proof-state labels.
- Pilot PM: approve data scope, shadow-run boundaries, and weekly outcome review.

The next milestone is not “all features shipped.” It is one paid, named PM who can prove that RealBud safely returned meaningful time.
