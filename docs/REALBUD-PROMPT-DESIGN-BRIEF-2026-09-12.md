# RealBud — complete brief for a prompt-design and architecture agent

Prepared 12 September 2026. Copy this entire document into the other agent. It is self-contained; repository and interview paths at the end are optional supporting evidence for agents that can access them.

---

## Your assignment

You are helping me, Yoda, improve the instructions we give an implementation agent to build RealBud correctly. Act as a practical product architect, engineering reviewer and prompt designer. Understand the situation before writing the prompt. Challenge weak assumptions with reasons; do not simply agree with me, repeat an earlier agent's verdict or produce a generic agent-platform checklist.

Your main deliverable is **one self-contained master implementation prompt for a repository-enabled coding agent**, grounded in the context below. That prompt must direct useful implementation, beginning with the next executable milestone, while preserving the longer-term product direction. Also provide a shorter first-milestone prompt I can use immediately.

In this conversation your task is to critique and write prompts, not implement the application, contact Austin, connect accounts or activate routines. If you have repository access, you may inspect it to improve accuracy. If you do not, identify the supplied findings as a dated handoff; do not claim to have inspected code or listened to recordings.

Do not ask me to restate information already here. Ask at most three questions only if the answers materially change architecture or the first executable task. Put non-blocking questions after your deliverables, state reasonable assumptions and proceed. Do not make your output another request for a later agent to write yet another prompt: produce the actual implementation instructions.

## 1. Who we are and what RealBud is

I am Yoda, the founder/developer. We are building **RealBud as its own reusable commercial product for real-estate agencies and property offices**, with its own installation, identity, user experience, settings, work history and support model.

Austin Realty is an early design partner/customer prospect and a family-friend connection, with possible referrals. Austin is our first concrete workflow case, not the definition of the entire product. We need a reusable product plus configured workflows and scoped onboarding/support, not a separate codebase for every office. Referrals are potential upside, not guaranteed revenue or a reason to accept unlimited work.

RealBud should be an agentic assistant connected primarily to the office computer and its working environment. It should understand an outcome, use approved files, websites and native applications, prepare or perform permitted work, verify results, handle interruptions and turn proven recurring tasks into dependable routines.

RealBud is the product people use. **Bud** is the assistant's identity inside it. **Hermes Agent** is the current headless execution engine behind RealBud, not the product window. **Cua** supplies computer interaction. Codex/Cursor and other coding agents help us build RealBud; customers should not have to use a coding environment instead of our product.

Keep these distinctions:

- RealBud owns the interface, job control, permissions, approval records, schedules, operational history and results.
- Hermes runs bounded work behind a supported adapter. It should not create another scheduler or expose its personal desktop product inside RealBud.
- Existing agency systems keep authority over their business records. REI is Austin's financial/property-management system. Bud operates around and through it.
- Optional CRM is a separately scoped product module/service. RealBud remains useful without it, and its removal must not break the PM workflows.
- Agency-specific sources, mappings, procedures, schedules and reviewers are configuration. Product improvements should be reusable.

Some commercial documents call Stage 1 “Agent OS.” Treat that as an inconsistent working label, not an instruction to build a generic OS, agent roster, terminal playground or clone of Hermes Desktop. Use RealBud as the product name.

## 2. The correction we have just made

We drifted toward polishing a local property catalogue and sample-book workflow while the actual model connection and computer execution were still unreliable. We questioned whether staff need to record and maintain their portfolios again inside RealBud.

The relevant Cursor continuation said:

> “We were wrong on the centre of gravity.”
>
> RealBud is the supervised desk and permission boundary. The PMS remains the property/money source of truth. The local portfolio should become source pointers and policy, not another manually maintained rent roll. “Like Hermes” means capable hands inside RealBud, not the Hermes window. Isolate Bud under `~/.realbud/hermes`, use the person's intended browser session, and keep one RealBud clock.

Its immediate order was:

1. Hands green: model attachment works.
2. One live morning: export or attached portal produces useful Needs you items.
3. One saved site/workflow procedure for REI or the agency PMS.
4. Clean Telegram decisions on that same path.
5. Then calendars, teaching refinements and cosmetics.

We accept this order. The next task is not more portfolio UI or another broad architecture exercise.

The subsequent review adds necessary nuance:

- A full manually maintained portfolio is unnecessary for most jobs, but **no structured memory** would also fail. Bud must retain expected obligations, source identity/coverage, unresolved cases, prior decisions and execution history.
- A thin address index by itself cannot detect missing bills. Bud needs expectations and evidence of which sources were actually checked.
- Computer-connected does not mean every step should be a screenshot click. Use direct file operations, APIs, browser semantics or native UI according to the job.
- One Bud identity does not require permanent single-person data ownership. Danny wants company-owned information across staff. Start with one operator/device while preserving agency/account/operator identity.
- The interview does not prove the competitive claim “you lose to AiMe.” The stronger evidence is Kevin's actual duplicate-work complaint.

Challenge these conclusions if you can identify a concrete contradiction or simpler way to meet the real needs. Do not treat either my opinion or another agent's confidence as evidence.

## 3. Austin meeting: people, sources and evidence quality

We interviewed Austin Realty on 10 September 2026. There are three clips, approximately 52 minutes in total, primarily Mandarin with English business/software terms.

- **Kevin:** main interviewee/operator, explaining accounts, bank exports, rent receipting, bills and support for the PM.
- **Danny:** principal/boss, concerned with agency ownership, customer information, sales classification and team continuity.
- **Yoda:** developer/interviewer, asking for actual workflow examples and proposing possible automation.
- A separate property manager is mentioned as owning maintenance operations. The name is uncertain in the transcript; do not rely on its spelling.

The transcripts are review drafts created with local multilingual ASR, targeted second passes, textual review and selected video-frame checks. Speaker labels remain provisional. Quiet file-search passages contain quarantined ASR hallucinations. We read all three draft transcripts in this architecture review but did not re-listen to every second of the recordings.

Do not treat my spoken “we can do that” claims as a tested product capability. Do not turn quoted references to legal notices, payment timing or software behaviour into legal advice or independently verified vendor facts. The interview supplies no measured savings, signed acceptance or blanket account-access permission.

## 4. What the meeting actually establishes

### A. Bank CSV and payment-reference preparation

Evidence: C1 01:26–05:54 and C2 00:00–03:42.

Kevin exports bank transactions to CSV, reviews/corrects references and imports into REI Cloud Bulk Receipting. REI already does some matching. Remaining exceptions involve blank references, names, property addresses, inconsistent payer text and repeated incorrect matches. Two tenants sharing a first name is one example; names or amounts alone cannot safely determine the property.

Bud's useful role is to retrieve the approved reference context, inspect the export, propose explainable reference corrections, hold uncertain rows and produce a checked copy. Preserve the original bytes, dates, amounts, row identity/order and non-reference data. The reviewed file is not proof of REI acceptance, financial posting or reconciliation.

Kevin describes receipting as roughly every two days, confirmed again at C3 10:07–10:10. A fixed daily schedule or Mon/Wed/Fri schedule is not a customer-confirmed interpretation. Establish the actual cadence, weekends, timezone and date-coverage rules.

### B. Expected bills, levies and duplicate tracking

Evidence: C1 07:33–10:53 and C2 05:57–10:14.

Council rates, water bills and body-corporate levies may be expected but never arrive. Changes to providers or delivery arrangements can cause gaps. Kevin tried an Excel tracker with properties, expected dates, receipt and payment states, but maintaining it alongside REI creates duplicate work. At C1 08:09–09:18 he explicitly describes this burden.

The desired outcome is to use history to estimate when a bill should arrive, flag its absence, help staff investigate, and record that a received bill has entered processing. Water-bill arrival dates are described as variable.

Required distinctions:

- Expected arrival window is different from an invoice's payment due date.
- No bill found is different from a complete search proving no receipt in the agreed sources.
- Received, processing/payment arranged, and verified paid are different.
- A received bill may also have insufficient owner funds, require owner action or involve a company advance. These are separate dimensions, not necessarily one mutually exclusive status.
- Acknowledging an alert does not prove settlement.
- Duplicate, forwarded, late or corrected invoices must not create duplicate obligations/payables.

Bud should derive observations from source evidence where possible; Kevin should supply decisions or missing knowledge, not maintain another full register. New properties or providers without history need explicit setup/confirmation rather than invented expectations.

### C. Inbox to a work list

Evidence: C3 09:44–10:10, plus the invoice/email discussion in clips 1–2.

Kevin starts with email, identifies urgent items, helps the PM and routes work. Email is an input to several workflows. A daily work list, linked to messages and existing cases, is useful. Preserve staff edits, dismissals, completion and ownership across rescans.

Later planning includes daily inbox organisation and up to two agreed Gmail sources, with read access by default. This is proposal scope, not evidence of a complete deployed integration. Avoid silently turning “inbox supports bills/payment prep” into an unlimited new automation programme. Mailbox edits, sending and broad access remain separate permissions.

### D. Evidence filing

Evidence: C2 03:45–05:57.

Staff report difficulty retrieving evidence of sent notices, so they save documents or copy messages to themselves. The cause of the retrieval issue is unverified. This supports a later filing/retrieval workflow using real source material. A generated/downloaded PDF alone does not prove sending or delivery. Bud must not start drafting or issuing statutory notices because evidence retention is useful.

### E. Airbnb payouts

Evidence: C1 13:15–14:14.

One payout can cover several bookings/properties. Staff inspect the Airbnb backend, split the allocation and enter booking references, names, dates and amounts in REI. This supports a later allocation-preparation job with fees/refunds/adjustments explicitly checked. It is not the same matching problem as one rent payment to one tenant.

### F. Maintenance

Evidence: C1 10:55–12:51.

The discussion describes tenant report → inspection → repair/replacement estimate → owner approval when required. The participants correct missing steps and say authority limits vary. Kevin is not the full operational owner. Do not invent a universal dollar threshold or automate maintenance end-to-end without the PM's actual walkthrough.

### G. Company buyer information and CRM

Evidence: C2 11:57–18:21; C3 00:00–03:52 and 10:15–14:12.

Buyer/enquiry information is currently maintained in Excel, with Drive/shared files visible in the prior frame review. Danny wants information owned by the company, not scattered across individual agents. Enquiries can reach two agents for the same listing, creating a possible duplicate-capture problem.

Danny initially discusses urgency, budget and property type, but C3 explicitly simplifies the initial matching request to **price range**. Do not preserve the earlier two-clip interpretation that all three dimensions are mandatory from the start.

Kevin explains that richer information is entered after phone calls and that the company lacks information when agents fail to submit their spreadsheets. Automatic enquiry capture cannot invent unrecorded buyer preferences. A listing price is not a confirmed buyer budget. The workflow needs staff enrichment, submission visibility, deduplication and one designated company record.

### H. Agreed starting area

At C3 14:17–14:32, Yoda proposes REI and bills first; Kevin agrees, with Excel/classification later. This is the clearest in-principle sequence. It does not establish a final feature ranking, signed scope or account access. Our choice to prove bank preparation first within that area is an implementation recommendation.

## 5. Product experience and architecture direction

Preserve the existing four places unless a concrete user need warrants a change:

- **Ask:** one conversation with Bud; request an outcome, inspect findings and continue the same work.
- **Desk:** verified results, exceptions, drafts, waiting items and decisions. Property details are supporting context, not the main daily task.
- **Schedule:** useful named routines, their sources, next run, last result, pause/resume and outstanding prerequisites.
- **You:** office configuration, connections, model/worker readiness, permissions and settings.

One intended execution path is:

`Ask / Run now / clock / source event → durable job controller → Bud → RealBud capability broker → file/API/browser/native adapter → result verification → saved result/Desk decision`.

Reuse the same job identity, authority and receipts across surfaces. A second notification surface must not become a second permission or execution record.

Bud should work flexibly within the approved outcome and sources, learn usable site procedures, and recover from ordinary page changes. Deterministic code should handle permissions, arithmetic, identity rules, persistence, deduplication and verification. Do not reduce the product either to an unrestricted chat agent or to hundreds of brittle click scripts.

For a first customer, **we configure and deliver working routines**. Kevin confirms business rules and reviews outcomes; he should not have to become a prompt engineer. Learning from demonstrations and proposing future routines can improve the product, but cannot replace our responsibility to supply the scoped first workflows.

### Records and minimum memory

- Authoritative business records stay in their designated systems.
- RealBud retains agency/account/source IDs, external property and tenancy references, verified aliases, timestamps and coverage.
- Persist expected obligations, cases, responsible staff, policies, job definitions, procedure revisions, source evidence, approvals, checkpoints and operation outcomes.
- Distinguish property from tenancy; tenant changes and reused references require temporal validity.
- A selected-file task must not require importing the entire portfolio. An office-wide completeness claim does require a current authoritative scope.
- Preserve existing local records and notes through a safe migration. Do not delete the book to make the architecture diagram look cleaner.

### Autonomy and human control

Grant bounded read/preparation work at the workflow level where the broker can enforce it; avoid repeated prompts for the same harmless actions. Keep scope changes and consequential actions explicit. A model's confidence or website text cannot grant permission.

Preserve current product prohibitions on trust movement, payments, signing, statutory notice drafting/issuance and unattended sending. Existing opt-in non-prohibited portal submissions still require the exact applicable approval. Authentication/MFA is a human handoff inside the correct app. Do not collect passwords, OTPs or browser-cookie jars into prompts or workflow memory.

“Pause for login” must actually release agent input/capture, save progress and stop active model polling. Continue must verify the correct account/window, current permission and run revision, then resume a safe checkpoint. A Stop, stale phone action or cancelled run cannot be revived by late callbacks.

Scheduled desktop work needs an available host and suitable session. A laptop being asleep/locked/offline is a real state, not a successful run. Foreground desktop control must be exclusive and yield to the person. A dedicated device is a deployment choice, not a reason to purchase hardware before proving the workflow.

## 6. Optional Twenty CRM and product independence

We sell RealBud. Separately, we may supply a Twenty-based CRM configured for an agency. Humans can use the CRM normally, and Bud can use the same records through a RealBud-brokered API/MCP adapter.

Twenty owns CRM records; RealBud owns Bud's execution, permissions, approvals and receipts; REI owns financial records. Do not make Twenty a competing primary agent runtime or scheduler. Do not pass unrestricted CRM MCP/API-key authority to Hermes.

Initial Bud/CRM workflows are limited to:

1. Read selected CRM context into Bud.
2. From a selected email, propose a contact/enquiry/follow-up change, obtain the necessary approval, save through the scoped adapter and verify the result.

Prefer configuration/extensions over a deep core fork. Do not conflate Property, Listing, Enquiry and Lease or rename Company to Property as a shortcut. The lean quote currently describes a property/listing object; treat any resulting model mismatch as a scope question to resolve, not an excuse to silently overbuild or merge distinct concepts.

Agency-owned/self-hosted data is the preferred direction; actual hosting, edition, access controls, licences and maintenance costs require verification. CRM can be disconnected without destroying PM setup or records. Engine update/removal must also preserve CRM and other unrelated agency data. Removing integration code and erasing business data are separate operations.

Start with separate agency configurations/deployments. Do not assume folders or profiles alone provide a secure shared multi-tenant service. Avoid adding a hosted control plane, marketplace, extra engine or agent team without a concrete requirement.

## 7. Technical context and evidence already available

Repository: `/Users/yoda/projects/PropertyMe`; product/repository name RealBud, `EzAuto399/RealBud`.

Observed package configuration: version 0.1.18, Electron 43, React 19, TypeScript 5.8, Vite 7, Tailwind 4, Node >=24, pnpm 10.33.0. There is a local Node HTTP/SSE service, existing provider/ACP adapters, JSON stores, encrypted Desk state and encrypted SQLite workflow payloads. Do not assume every store or credential is encrypted.

Hermes uses the `property` profile. The source installation pin is 0.20.3 with an explicit compatibility entry for 0.21.0; verify the actual executable/version used by each running path. Cua is pinned to 0.19.3. The product intends a RealBud-owned Hermes home under `~/.realbud/hermes`; personal Hermes Desktop state must remain separate.

Relevant implementation areas:

| Area | Files / responsibility |
|---|---|
| Worker identity, readiness, authentication | `server/hermes-pack.ts`, `hermes-status.ts`, `hermes-hands.ts`, `hermes-oauth.ts`, `hermes-pin.ts`, `worker-bootstrap.ts` |
| Interactive execution and connected apps | `server/drivers/acp/hermes.ts`, `server/drivers/acp/core.ts`, `server/connected-apps-broker.ts`, connected-app operation store |
| Clock, recipes and runs | `server/routines.ts`, `routine-persistence.ts`, `recipes.ts`, `job-runs.ts`, `job-executor.ts`, `workflow-packs.ts` |
| Browser/control authority | `server/cua-bounded.ts`, `portal-fence.ts`, `portal-sessions.ts`, `attended-run.ts`, `computer-lease.ts` |
| Native host and human handoff | `electron/cua.mjs`, `cua-control.mjs`, `cua-login-check.mjs`, `server/cua-human-control.ts`, `human-handoffs.ts` |
| Bank preparation and storage | `server/bank-reference.ts`, `bank-reference-store.ts`, `workflow-database.ts`, `src/components/schedule/BankReferenceReview.tsx` |
| Bills and saved context | `server/expected-bills.ts`, `desk-context.ts`, `desk-store.ts`, `server/index.ts`, `shared/contracts.ts` |

The checkout contains substantial pre-existing modified/untracked work. A base Git SHA alone cannot reproduce it. Inspect status and relevant dependencies, preserve others' edits and review the actual intended change set. Do not stage the entire directory, discard uncommitted work or hand-edit generated `openwiki/` pages.

### What prior implementation evidence says

The September 11 implementation report records bank-reference review/export, encrypted revisioned login handoffs and explicit reviewed-step recovery as implemented. It records 215 focused tests across 14 files, a scripted built-app journey, separate real Hermes/Cua component canaries on macOS, and a Windows installer/runtime smoke on Windows Server 2025 x64. These are dated evidence claims to inspect, not a fresh test run or proof of a complete Austin workflow.

The bank review retains the original, deduplicates identical source files, uses approved payer aliases/reference mappings, requires a decision for every row and produces a reference-only copy. The report specifies CSV limits of 750 KB, 3,000 rows and 100 columns with explicit date/signed-amount formats. XLSX or alternate debit/credit formats need separate calibration. Automatic bank acquisition and REI compatibility are still open gates.

The current sign-in recovery is browser-specific and uses explicit next-step review. Do not describe it as a fully automatic native-app continuation system. Earlier rehearsal docs calling all handoff work unimplemented predate this implementation report.

Our September 12 architecture review ran 84 existing tests across routines recovery, job executor, portal fence, bank reference and expected bills: all passed. That does not validate the proposed broader adapters or migration.

**Latest same-session running-app observation on September 12:** the actual RealBud UI at local port 8799 displayed “Model needed,” “Bud readiness check missed,” and “Sample book.” This is an observed UI state, not a proven root cause. No fresh successful worker call was demonstrated in that check. Earlier component canaries do not contradict a later broken/stale running-app configuration. Check the actual loaded artifact, configuration and provider path before drawing conclusions.

### Specific gaps identified for re-verification

- Scheduled preparation in `job-executor.ts` uses file/web/todo toolsets and saved context; it does not automatically inherit the complete interactive live-app/computer path.
- The expected-bills template describes reading Gmail but its declared preparation capabilities are `read-book/analyse/draft` with no allowed origins. A saved template is not a live ingestion pipeline.
- The bounded portal contract permits navigation, reading, filling and semantic clicks; raw desktop tools are prohibited in that path. Broader files/native apps require an enforceable adapter design, not deletion of a deny list.
- The shared computer lease is in-process and distinguishes owner categories; the same owner category can replace another work item's lease. Inspect all callers before concluding an exploitable race, but strengthen per-run/device ownership before broader concurrent scheduling.
- Expected-bills JSON loading currently treats read/parse failures as an empty list. Its flat status and optional source reference do not establish recurrence, complete coverage or payment evidence.
- A structurally valid model summary is not independent proof that a file was saved, an inbox read or a record changed. Verify using the actual adapter/result state.
- The older bounded Gmail Ask path has limited coverage. Verify pagination, attachments, account selection and recurring ingestion instead of assuming a connection supports the whole bill workflow.
- Windows packaging/component smoke, actual Windows 11 interaction, real Austin source access, mobile notification delivery and customer acceptance are separate gates.

## 8. Current commercial context — proposed, not signed

The latest local commercial brief checked for this handoff is revision 18. Older documents contain materially different prices and support promises; do not combine them.

| Stage | Latest local proposed terms |
|---|---|
| Stage 1 RealBud workflows | A$5,500 founding implementation; A$299/month including A$75 usage; two care months included in the project, retainer invoices from month three |
| Stage 1 care | Month 1 training/guided handover; month 2 monitoring/stabilisation; eligible usage above the allowance in those included months absorbed under the proposed scope |
| Optional Stage 2 CRM | A$2,000 founding setup; A$149/month care after its separate accepted go-live; lean Twenty setup, three users, up to 2,000 records from one agreed export |
| Both ongoing stages | A$448/month when both retainers apply; Stage 1 usage allowance shared; hosting/licences additional at approved cost |

Stage 1 is centred on expected bills and payment-reference preparation, with inbox evidence/work organisation supporting them. Airbnb and notice-evidence filing are later Phase 1.5 work. Stage 2 needs its own written scope/approval. These are local proposal terms, not proof of a signed customer contract or permission to start customer actions. Check final wording, inclusions and arithmetic before using any proposal in a customer conversation.

The commercial purpose is to deliver measurable staff value with sustainable support. Account for implementation labour, training, ongoing workflow repair, model/tool costs, connector/hosting expenses, release upkeep and incident effort. Do not assume usage pass-through creates margin or referrals pay for overruns. Do not reopen a large pricing study unless it changes the recommended product scope.

## 9. Build sequence the implementation prompt must enforce

**First milestone: make Bud's hands work in the actual application.**

Identify which source/artifact is running, resolve the actual model/profile/provider path, diagnose the readiness failure, prove a harmless successful response through RealBud and verify isolation from personal Hermes. Check cancellation/restart recovery. Then prove access to one explicitly selected existing browser page, with the intended session and no silent fresh-browser/login detour. If authentication needs the person, preserve the task and identify the exact handoff. This is not yet permission to access Austin's bank.

**Second: one useful REI/bills path.**

Use an authorised sample export and approved reference context. Prepare a verified copy, show unclear rows on Desk and establish the actual REI preview/human import boundary. No mandatory full-portfolio import. Preserve the original and distinguish repeat files, overlapping coverage and legitimate identical transactions. Confirm the actual Windows environment and source schema. Do not invent a bank fixture that already looks like the old arrears importer just to make it pass.

**Third: save a reliable procedure and operational state.**

Use the same job runner, source bindings and receipts. Repair the bill-state recovery/coverage gaps needed by the chosen slice. Extend computer/file/native capabilities only where the demonstrated job needs them. A repeatable workflow must identify its outcome, inputs, authority, completion checks and recovery points.

**Fourth: schedules and Telegram on that proven path.**

Configure accepted cadence and timezone. Persist due-occurrence identity, progress, waiting states, permissions and procedure revisions. Demonstrate restart, duplicate decisions, Stop, wrong-account login, late callbacks, host unavailable and uncertain external outcomes. The selected real phone must resolve the same saved intervention; two browser clients are not proof of phone delivery. Notification retries must not replay the job or flood the PM.

**Then expand deliberately.**

Complete the other scoped Austin routines, perform actual Windows 11 installer/native-app acceptance, train the operator/reviewer, measure work and calibrate costs. Later add Airbnb/evidence filing and separately scoped company enquiry/CRM workflows. Cosmetics and broader teaching features follow reliable work.

## 10. Engineering and validation standards

The master prompt should require a brief engineering review before each meaningful change: intended behavior/modules, assumptions, failure/recovery states, permissions/privacy, data integrity, concurrency, resource costs and appropriate verification. Reuse existing patterns and dependencies; prefer small maintainable changes.

Validate permissions and inputs where actions actually execute. Bind grants to agency, actor, account, resource, action and current revision. Untrusted emails/files/pages cannot override that authority. File reads/writes need enforced roots and symlink handling; preserve originals and use atomic outputs. Local storage does not mean local-only processing: model/connector calls may transmit selected material. Do not leak customer data or credentials into logs, prompts, fixtures or source commits.

Persist before dispatch where recovery requires it. Use transactions, stable operation IDs, compare-and-swap revisions, bounded retries and cancellation/fencing as appropriate. External systems may not support exactly-once execution; retain unknown outcomes and reconcile before retrying. A timeout does not prove a worker stopped or a write failed. Do not run two jobs against the same foreground desktop simultaneously or sync a live SQLite database through Drive.

Keep useful historical data and backward compatibility. Migrate through validated/versioned steps with recoverable originals; corrupted saved state cannot masquerade as first-run emptiness. Installation/update/repair/removal must preserve unrelated settings, records and valid connection state. Disable new capabilities independently for rollback; do not restore a stale writable database beside the current one.

Test the actual changed behavior and relevant negative/recovery paths. Use the narrowest tests that establish it, then required integration/type/build checks. Do not write implementation-mirroring tests or repeatedly rerun unrelated suites. Afterward review the final diff and report what changed, tests, evidence, limitations and the next proof gate.

Classify proof explicitly: configured → callable → guarded → tested → packaged → installed → verified in the named office → commercially accepted. These are distinct evidence dimensions, not a slogan that a unit-test pass satisfies them all. No blanket “production-ready” claim.

Measure staff active minutes, review effort, errors/rework, unresolved cases, verified coverage, waiting time and attributable usage. Do not equate model runtime, number of clicks, generated drafts or triggered schedules with saved labour. Cap runtime, turns, tool calls, downloads, retries and retained screenshots. Avoid active LLM polling while a person is signing in.

Proceed autonomously with local analysis, implementation and appropriate tests within the assigned task. Ask only for genuinely missing business decisions, credentials entered by their owner, new sensitive access or consequential external actions. Do not contact people, move money, send messages, publish, purchase hardware or enable customer routines merely because this brief describes them.

## 11. Required response from you

Return these in order:

1. **Your diagnosis**, in no more than 12 concise bullets: what is sound, what is contradictory, what we risk overbuilding and what should change. Separate evidence from recommendations. Include the product-versus-Austin distinction and the actual next milestone.
2. **A compact ownership map:** RealBud, Bud/Hermes, Cua, existing PMS/bank/mail/files, optional Twenty, human staff. Say who owns records, permissions, scheduling and proof.
3. **The complete master implementation prompt**, in one clearly delimited copyable block. Address the coding agent directly. Include sufficient context to stand alone, evidence rules, first milestone, staged follow-through, scope boundaries, inspection points, testing, recovery and reporting. Do not say “refer to the context above” as a substitute for essential information. Paths may supplement the prompt but cannot be its only context.
4. **A shorter first-milestone prompt**, focused on the actual app's model/worker readiness and existing-session browser access. It should start executable work immediately without starting the entire roadmap or rebuilding working foundations.
5. **Decisions still needed**, at most three that are actually blocking; identify other assumptions without stopping progress.

The result should help a capable agent build the right next thing. Avoid ceremonial roles, repeated warnings, a generic enterprise audit, an unsolicited new tech stack, vendor switching, speculative features, artificial deadlines and confidence unsupported by evidence. Use plain, precise language.

## 12. Optional supporting material for a local/repository-enabled agent

Use the evidence hierarchy: current user decisions → actual source/tests/runtime for implementation facts → current architecture review → dated implementation reports → older design/rehearsal notes. Interview recordings remain the authority for spoken evidence, with transcript uncertainty preserved. Commercial scope is a separate proposal authority and does not enable runtime permissions.

Current direction:

- `/Users/yoda/projects/PropertyMe/docs/REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md`
- `/Users/yoda/projects/PropertyMe/docs/SCOPE-REALIGN-2026-09-12.md`
- `/Users/yoda/projects/PropertyMe/docs/GOAL-PROMPT.md`
- `/Users/yoda/projects/PropertyMe/docs/NEXT-WAVE.md`

Austin and technical context:

- `docs/AUSTIN-IMPLEMENTATION-2026-09-11.md` — later component and installer evidence; full office path unverified.
- `docs/AUSTIN-REHEARSAL-2026-09-11.md` — earlier rehearsal; some “not implemented” findings subsequently changed.
- `docs/AUSTIN-COMMERCIAL-AND-WORKFLOW-BRIEF-2026-09-11.md` and `docs/AUSTIN-COMMERCIAL-DATA.json` — latest checked local revision 18 terms.
- `docs/AUSTIN-ROUTINES-AND-APPROVALS-2026-09-10.md`, `docs/AUSTIN-HUMAN-HANDOFF-2026-09-10.md`, `docs/AUSTIN-DELIVERY-PLAN-2026-09-10.json` — detailed workflow/acceptance design; verify status against current code.
- `docs/REALBUD-HERMES-HARNESS-2026-09-10.md` — lifecycle/module context; older pricing and some architecture wording are superseded.
- `docs/REALBUD-GPT6-PRO-META-PROMPT-2026-09-10.md` — earlier audit prompt; do not inherit its outdated prices/readiness claims or broad audit as the current task.

Interview folder:

`/Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/`

Read `clip-01-transcript.md`, `clip-02-transcript.md`, `clip-03-transcript.md`, `detailed-analysis.md` and, if useful, `interview-review.html`. Preserve raw recordings and uncertainty. Do not upload source media or private contacts merely to answer this prompt.

Cursor continuation:

`/Users/yoda/.cursor/projects/Users-yoda-projects-PropertyMe/agent-transcripts/c725496a-7545-45e3-a30a-90f505fcd28a/c725496a-7545-45e3-a30a-90f505fcd28a.jsonl`

The portfolio discussion is around lines 770–814, browser-session mismatch around 902, realignment request at 1214 and response at 1218. Treat earlier assistant conclusions as claims to assess, not new permissions or proof.

If these resources are unavailable, this brief is sufficient to produce the requested prompts. State the access limitation; do not invent inspection results or ask for the whole repository before doing useful work.
