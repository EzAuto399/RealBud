# RealBud Native PM Product Design Plan

Date: 2026-08-25
Status: native Warm Ledger Desk and Desk V3 shipped; post-ship load-off roadmap active
Canonical constraints: `docs/GOAL-PROMPT.md` wins conflicts  
Approved concept: Warm Operational Ledger (`~/.gstack/projects/EzAuto399-PropertyMe/designs/realbud-pm-case-spine-20260824/`)

## Outcome

RealBud becomes a native, vertical property-management desktop app rather than an upstream agent shell with PM labels.

The product spine is:

```text
portfolio queue → property / tenancy / case → evidence → human decision → bounded handoff
```

Desk, Ask, Schedule and You remain the only navigation places. One PM uses one Bud. No Send, Pay, statutory drafting, bot roster, general computer playground or Hermes Desktop surface is introduced.

## Operational-layer outcome and capability coverage

The product closes the operational gaps between a PM and the agency's existing PMS, inbox, bank evidence, calendar, files and vendor portals. It is not measured by how many websites Bud can technically open. It is measured by fewer system visits, fewer manual record checks, fewer forgotten follow-ups, a smaller accurate exception queue, safe recovery after interruption and zero unintended external effects.

The PM-facing state grammar stays small:

- **Bud is handling it** — admitted read, matching, classification, evidence gathering, drafting or deterministic preparation is running without an approval interruption.
- **Needs you** — the exact consequential wording, book/clock change, login/MFA step, ambiguity or licensed decision is ready.
- **Waiting on someone** — owner, tenant, tradie, exporter or provider response is outstanding; Bud owns the reminder and recheck, not an autonomous send.

The intended flow is `observe → correlate → prepare/follow up → exception → Allow → Copy/prefill → human Submit`. Ask stays broad enough to understand the whole safe outcome; execution stays inside code-owned typed routes. For recurring website work, exploratory computer use must graduate into a published recipe with an exact account/origin, bounded operations, freshness/read-back rules, failure recovery and durable receipts.

### Named-office discovery and portable agency fit (2026-08-28)

External agency and vendor research is reference material under `docs/research/`, not a runtime tenant registry. It cannot prove an office's PM, PMS, exporter, bank, inbox, operating system, jurisdictions, credentials or vendor account. The session-gated read-only `realbud.pilot-discovery.v1` projection reads only the code-owned pilot contract, remains agency-neutral at 0/8 under Demo and cannot mutate setup or unlock a capability. A partially named office retains explicit incomplete fields rather than inheriting facts from research.

The reusable product seam is seven system families—PMS/rent roll, read-only bank evidence, inbox/calendar, leasing/inspections, maintenance/compliance, listings/leads and PM Pocket—not an exhaustive list of Australian agency websites. Each family publishes recognised examples, the route preference and the proof required for the named account. The adapter order remains structured export/API → restricted named connector → code-owned browser recipe → bounded CUA. This handles the small recurring vendor ecosystem without claiming universal compatibility, screen scraping or authority from a logo. Research, counter-evidence and the office-visit script are in `docs/research/AUSTON-PILOT-DISCOVERY.md`.

### Honest capability matrix

| PM work | Load removed | Current evidence | Gate before a live capability claim |
|---|---|---|---|
| Book intake and current PMS money | Batch import, identity matching, freshness checks, exception cards and courtesy drafts | Source-built and fixture/source verified; structured export remains authority | Named office export dialect, exporter/cadence and one observed PM workflow |
| Read-only bank corroboration | Read recent credits, match exact property code/amount and hold discrepancies | Typed fake-bank browser/CUA fixture; no transfer/payee path | Named bank plus approved read-only test account; PM login/MFA, selectors, expiry, rate limits, revocation and terms |
| Inbox and maintenance interruption shield | Classify inbound work, link property/case, collect evidence, prepare reply and own follow-up timing | Source-safe Demo envelope, digest dedupe/thread correlation, encrypted cases, reply drafts and Waiting/Close UI built; read-only mail adapter not built | Pilot mailbox, OAuth/read scope, real classification set, attachment quarantine, reply-draft review and disconnect/recovery proof |
| Tenancy, inspection and waiting-date loops | Surface upcoming work, prepare checklists and remember follow-ups | Typed routine model and declared case kinds; live fields/loops not built | Pilot's real tenancy/date fields and PM-approved shop cadence; no statutory clocks or notices |
| Owner updates and preference memory | Gather factual changes, apply explicit style preferences and prepare a weekly update | Friday owner letter v0, Notes boundary and Review memory source verified | Named PM use, real owner cadence and wording evaluation; Copy/human send remains external |
| PMS or vendor portal preparation | Navigate an admitted case, prefill exact approved wording and return control for Submit | Visible fake portal plus durable bounded broker fixture | Named vendor test account, packaged recipe-to-Electron bridge, installed permissions, SSO/MFA/layout/read-back and human-Submit proof |
| Pocket control | Ask Bud, inspect the same action card and make the same revision-checked decision from a private PM channel | Telegram and official WhatsApp Business Cloud adapters source-built but Demo network-off | Named agency/PM, privacy approval, dedicated channel identity, stable HTTPS infrastructure where required and live delivery/restart evidence |
| Local multi-property execution | One structured batch, selected-file analysis and safe route fallback without a cloud requirement | Planner, structured broker, serial brokered selected-file analysis and offline 131-item simulation source verified | OS resource boundary/two-lane benchmark, private Chromium/profile pool, installed measurements and real-account session-safety proof |
| Cloud acceleration | Add independent remote lanes without changing Desk, approval or local functionality | Contract only; no provider selected | A named workflow need plus region, retention, deletion, encryption, spend, orphan cleanup and complete local-fallback proof |
| Reminders, waiting work and load-off proof | Bring failed/held work back, remember who is awaited and quantify avoided effort | Privacy-safe desktop reminders shipped; load-off ledger not built | Named workflow baselines and receipt-derived time/touch measurements; drafted never counts as sent |

A row is **named-office capable** only after the real account/file and named PM complete the success, unavailable, stale, auth-expired, duplicate, interrupted, partial and recovery paths on an installed build. Durable receipts must prove what was observed and what remains unknown. The workflow must reduce measured PM time or touches while every send/pay/statutory/trust boundary stays unreachable. Until then, the UI and owner-facing material use the evidence label in the table rather than “connected,” “automated” or “production ready.”

## Approved decisions

1. All three design spines ship as one system: PM case/evidence Desk, PM-native Ask and source-to-handoff trust journey.
2. Visual direction: **Warm Operational Ledger**.
3. Browser presentation supports all three per-session modes; default is side-by-side. Idle space is evidence/context, not arbitrary browsing.
4. Handoff completion is verified by read-back when possible, otherwise human-confirmed; unknown remains unknown.
5. Ask is PM-first with technical activity under Advanced diagnostics.
6. Layout is adaptive desktop split view; Pocket is a dedicated projection into canonical Ask, never a fifth place or a squeezed mobile desktop.
7. Full PM object/data migration is part of this implementation, not deferred.
8. V3 first cut includes the full model breadth: historic tenancies, owner/tradie contacts, maintenance intake and all browser presentations.
9. Migration is one atomic V3 cutover behind an in-memory V2 compatibility snapshot; there is no dual-write authority.
10. Evaluation reads an immutable-evidence-backed current projection, never history or Notes.
11. Unmatched/ambiguous source rows become `ImportIssue` records, not fake Properties or unresolved Cases.
12. Proposal edits append immutable revisions; Decisions reference one exact revision.
13. Portal binding, immutable recipe, one-use authorization and Handoff remain distinct security objects.
14. Properties archive; tenancies close; Decisions, Evidence and Handoffs are never cascade-deleted.
15. Routine outputs link by `runId`; `loops.json` remains the run store and is not duplicated into Desk.
16. Multi-property execution is local-first and route-selected: complete structured inputs stay one batch; same-account browser work stays serial; independent private browser lanes cap at two; visible CUA caps at one; cloud is optional acceleration. Hermes stays an externally owned pinned runtime and is never patched or forked for this topology.

## What already exists

- Four-place navigation and Desk-first new-window startup; session-only view continuity keeps an in-window refresh on the PM's current place and fails safely back to Desk when storage is absent or invalid.
- Desk exception sections, draft decisions, source provenance, holds and licensee escalation.
- Typed WorkItem state machine and proposal hashes.
- Named Schedule loops with clock persistence and run history.
- Notes in the vault, isolated from evaluation.
- Bounded CUA capability, origin/recipe constraints, lease expiry and human Submit boundary.
- Manual approval and unconditional send 403 gates.
- Recovery mode, encrypted Desk v2 store and atomic writes/backups.
- A broad CheckReason model for partial/reversed/stale/unmatched/ambiguous facts.

These are reused. The redesign changes the visible object grammar and normalizes persisted PM records; it does not replace the safety harness.

## NOT in scope

- New navigation places, teams, rooms or additional agents.
- Tenant-facing chat or autonomous communication.
- Statutory notice preparation, legal clocks, trust movement or payments.
- Generic web browser, URL bar, arbitrary computer control or background Submit.
- Mobile-responsive desktop UI. Pocket is a separate, one-PM transport into Ask; its Telegram and official WhatsApp Business Cloud text/manual-decision adapters are source-built, while live enrollment, public HTTPS infrastructure and mobile media remain pilot-gated.
- Hermes Desktop, upstream Preview pane, model shop or plugin marketplace.
- Dark mode in this implementation.

## Domain model: Desk v3

Current `DeskFileV2` combines the asset, current tenancy and tenant contact inside `Property`. V3 separates domain records while preserving existing IDs and hard gates.

### Records

| Record | Purpose | Key relationships |
|---|---|---|
| `Agency` | Name, timezone, jurisdictions, source readiness | owns portfolio |
| `Source` | Authority, collector, stable identity and freshness policy | produces Evidence |
| `PropertyGroup` | Building/strata complex or portfolio bucket (name, address, notes) | groups many Properties; optional on Property |
| `Property` | Stable managed asset, address, policy/options | has tenancies, cases, notes |
| `Tenancy` | Current/historic lease context, rent cadence/due rule | belongs to property; has contacts |
| `Contact` | Tenant, occupant, owner, tradie; preferences and safeguards | linked to tenancy/property |
| `ImportIssue` | Unmatched/ambiguous external identity and candidates | resolves into a property/source match |
| `Case` | One actionable PM exception or update | property + tenancy + evidence + proposals |
| `Evidence` | Source-stamped observed fact with freshness | attached to case/property |
| `MoneyPosition` | Bounded current fact projection for evaluation | one per current tenancy |
| `Proposal` | Draft wording or bounded next step awaiting human decision | belongs to case |
| `ProposalRevision` | Immutable wording/recipient/channel revision | belongs to proposal |
| `Decision` | Allow/Edit/Deny/Copy/Done record with actor/time/revision | belongs to proposal/case |
| `PortalBinding` | Property/remote-account mapping and recipe reference | configuration, not execution |
| `PortalRecipe` | Published immutable steps/version | configuration, not authority |
| `Handoff` | Bounded execution/audit record and verification result | belongs to approved proposal revision |
| `RoutineRun` | Named loop execution and outputs | links to cases/proposals produced |

### Case types in this plan

- `money-arrears`
- `owner-update`
- `inbound-triage`
- `maintenance-intake` (classify, evidence and drafts only; no dispatch)
- `lease-review` and `inspection-prep` (read-only dates/checklists and draft wording; no statutory action)

`ImportIssue` is not a Case. It remains a source-matching object in the same Desk queue until a PM links or rejects it.

### Migration V2 → V3

1. Read and retain the original encrypted V2 bytes; compute a ciphertext hash.
2. Decrypt and strictly decode every V2 record. For V1, run the existing pure V1→V2 transform first, then strict V2 validation.
3. Write an exact encrypted pre-migration backup, fsync file and parent directory, read it back and verify the hash. Current post-write best-effort backup rotation is insufficient for this migration.
4. Preserve every current property ID and `vault/properties/<id>.md` path.
5. Convert each V2 `Property` into:
   - one V3 Property;
   - one current Tenancy with deterministic ID derived from property ID;
   - one tenant Contact with deterministic ID derived from property ID;
   - no owner Contact unless real data exists.
6. Preserve property policies/options, but derive hard `NEVER_ACTIONS` from code; persisted input cannot remove them.
7. Convert current ledger facts into `legacy-unverified` Evidence where source-observed time is unavailable. Do not manufacture PMS authority. These positions hold until a fresh recheck.
8. Preserve existing Observation IDs where possible. V3 imports create one immutable Evidence record per accepted source row with authority, collector, observed/ingested/stale times and the exact factual payload.
9. Convert each WorkItem into a Case with the same ID. Held work without a Draft remains a Case without a Proposal. Existing Escalations become `licensee-required` Cases without invented Work history.
10. Convert each Draft into a Proposal with the same ID and one known ProposalRevision. Do not invent lost edit history. Existing Allow/Deny state becomes a Decision with `legacy-unknown` actor when no actor exists.
11. Convert unmatched/ambiguous holds into `ImportIssue` records; never create placeholder Properties.
12. Preserve PortalBinding and PortalRecipe as configuration. Preserve capability IDs as Handoff IDs, but migration-invalidates every unused legacy capability; reissue requires a new visible PM action.
13. Validate duplicate IDs, references, property/tenancy cardinality, source authority, projection state, hard gates and handoff non-expansion.
14. Encrypt the V3 candidate with the existing key, write/fsync a sibling file, read back, decrypt and validate it.
15. Atomically rename the candidate over `desk.json`, then fsync the parent directory. Desk APIs, schedules and browser work start only after commit.
16. During screen migration, generate the current DeskSnapshot shape from V3 in memory. Commands write only V3; no V2 dual-write exists.
17. On any failure, leave original V2 bytes at `desk.json`, enter read-only recovery, and keep schedules/browser work stopped.

Migration tests cover empty/demo/live books, 200 properties, missing optional fields, V1→V2→V3, deterministic IDs, every WorkState, orphan/duplicate references, capability expiry/invalidation, interrupted writes at every commit phase, corrupt/encrypted records, idempotent reload and all hard-gate invariants.

### Evidence authority and current projections

Evidence is immutable and separates **authority** from **collector**. Authority is PMS, demo or `legacy-unverified`; collector is CSV, Hermes, bounded portal or migration.

One bounded `MoneyPosition` projection exists per current tenancy and contains the exact Evidence ID, source ID, observed/stale times, current facts and status (`current`, `stale`, `conflicted`, `requires-recheck`). Only fresh, uniquely matched, PMS-authoritative evidence may produce actionable wording. Legacy-unverified, stale, unmatched, ambiguous, reversed or conflicted evidence holds.

Shipped hardening (2026-08-26): a structured PMS import is treated as one complete portfolio observation. It appends one Evidence row per active property with `coverage: observed | missing | conflicted`; duplicate rows never use last-row-wins. Projection considers only rows at the newest PMS-observed instant, so a newer snapshot supersedes an older still-fresh snapshot while equally current disagreement conflicts. Future timestamps, missing coverage, stale facts, reversals and Hermes-collected balances cannot produce wording. Live evaluation now consumes that projection, pending proposals are marked stale when the outcome/period loses support, and Allow revalidates the exact current evidence, classification, period and recipient.

The persisted file remains V3-authoritative, but ordinary commands still mutate the temporary V2-shaped compatibility working copy before `syncWorkingV2IntoV3`. Evaluation and Allow never trust that compatibility ledger. Each save now derives and validates one V3 candidate from the last committed authority, applies retention, encrypts it and classifies atomic-write failure as `not-landed` or `landed-uncertain`. A pre-replace failure restores the exact committed working copy; an uncertain landed candidate stays visible and forces read-only recovery. The direct-V3 command cut-over in migration item 16 remains architecture debt, but it is no longer carrying an unhandled partial/unknown-commit release risk.

Evaluators receive a DTO containing Property, current Tenancy, applicable policy and one MoneyPosition. They never scan history and never receive Notes. Owner-update proposal enrichment may read one property Note after factual evaluation, treating it as untrusted editable wording and recording only note path/hash provenance.

### Proposal, decision and lifecycle rules

- At most one current Tenancy per active Property; historic tenancies are retained.
- Proposal edits append ProposalRevision; they do not overwrite prior wording.
- Allow/Deny/Copy/Done are Decisions that reference one exact ProposalRevision.
- Edit is a revision event, not authorization.
- Unknown migrated actors remain `legacy-unknown`.
- Property deletion becomes archive. Archived properties leave routine/source matching by default but retain tenancies, Cases, Evidence, Decisions, Handoffs and Notes.
- Closing a tenancy preserves its records and creates no replacement until real data exists.

### Approval load-off and Review memory

Bud's internal work is not approval-gated: admitted-source checks, scheduled evaluations, classification, diagnostics and draft preparation run under their existing code-owned boundaries and put only exceptions or proposed consequences on Desk. Manual approval remains attached to the exact consequential object—wording, a book/clock change or one bounded handoff—not to every read or reasoning step. Send, pay, statutory drafting and trust work remain unreachable rather than learnable.

Desk shortens repeated review without adding a hidden preference store. A read-only `reviewAssist` projection is derived at snapshot time from immutable ProposalRevisions and explicit Allow Decisions for the same property and draft kind. It compares current evidence status, recipient, channel and a conservative wording pattern that masks only known property identity, AU dates and currency. A clean repeat starts with exact wording and prior property history collapsed, presents unchanged comparisons in plain language and compresses the four clear safeguard rows into one checked result. The evidence rail still names source freshness, why Bud surfaced the case and the Notes/evaluation boundary; the fixed decision bar still says that Allow binds only this exact version and sends nothing. Any changed field, current-card edit, active recipient safeguard, stale/missing evidence or levy/trust-boundary flag stays expanded. Denials and unrelated properties/kinds never train it. The projection has no mutation/approval field, performs no model/network work, and falls back to first-time/attention when history is incomplete.

This is the MVP learning boundary: learn where the PM spends review attention, not authority, law, source facts or permission. Later wording templates remain an explicit Wave 3 capability and require real-office evidence; Review memory must not silently rewrite a future proposal.

### Routine output linkage

LoopRun remains in `loops.json`. The executor passes `runId` and `loopId` into Desk; created/updated Cases and Proposals store `origin: { kind: "routine", runId, loopId }`. Schedule derives outputs by indexed lookup. No cross-file dual-write of the run object is introduced.

Each scheduled occurrence also owns `scheduled:<loopId>:<scheduledFor>` before any source/evaluation effect. This closes the crash window where a completed run could persist while `handledThrough` remained stale: startup/tick advances past the existing occurrence instead of replaying it. Manual idempotency ids bind to exactly one routine. `LoopRun.steps` is an optional, bounded list of code-owned phase receipts (`preflight`, `collect`, `evaluate`, `stage-desk`); v3 files and legacy runs remain readable without a file-version migration. Running steps become interrupted on startup and are never replayed automatically.

### Calendar, retention and scale

- Agency timezone controls shop-calendar calculations. Source dates remain calendar dates where available. Migration does not infer a lease due rule from `daysSinceDue`.
- Retention never removes Evidence referenced by open Cases, Decisions or Handoffs.
- Full evidence/decision timelines are paginated; the default queue excludes Notes, contacts, tenancy history and terminal work. Selected case/property detail is fetched on demand, and property Notes load only after that property opens.
- Book navigation searches address, property code, tenant and phone, renders 24 properties per page and keeps unmatched source identities in a separate searchable resolver. Link/reject is an explicit revision-bound decision with an idempotency receipt; an exact normalized future row may reuse only that recorded decision.
- Source-wide failure becomes one incident with affected count. PM-facing status stays limited to Bud is handling it, Needs you and Waiting on someone; Waiting sorts by its operational next check and supports snooze, cancellation and closure receipts without becoming a legal clock.
- Build in-memory maps by primary/foreign key and indexes for normalized address/property code.
- Evaluation remains O(current tenancies), not O(evidence history).
- The source suite now bounds a 200-property active queue below 750 KB. Benchmark 18k–36k Evidence rows and installed renderer interaction before choosing SQLite or a journal; do not infer named-office responsiveness from the fixture alone.

## Atomic routine catalog and field inventory

A routine is a typed kind + a schedule shape + a scope + enabled/revision. Adding a kind always means: evaluator + Hermes skill + case type. Schedule shapes: `daily-time`, `weekly-time`, `monthly-dom`, `per-property-anniversary`, `event-driven`. It is never just Monday and Friday — the two built loops are the first two shapes, not the catalogue.

### Catalogue

| Kind | Schedule shape | Default | Scope | Inputs | Outputs | Status |
|---|---|---|---|---|---|---|
| `morning-money` | daily-time (weekdays + time) | Mon–Fri 07:30 | all active properties | MoneyPosition batch, ImportIssues | money-arrears cases, licensee escalations | built |
| `owner-update` | weekly-time **or per-property cadence** | Fri 16:00; property policy may say monthly/off | properties whose `ownerUpdateCadence` is due this run | money position, open cases, lease milestones, one Note | owner-update case + proposal | built (per-property cadence pending) |
| `inbound-triage` | event-driven (+ optional poll) | manual/poll | all | mail items | inbound cases | declared |
| `lease-review` | weekly-time digest; fires per tenancy at T-90/T-60/T-30 | Thu 09:00 | active tenancies | tenancy end dates | lease-review case (no statutory action) | declared |
| `inspection-prep` | per-property inspection date + T-14 lead | none set | opted properties | inspection dates | inspection-prep checklist case | declared |
| `maintenance-followup` | event-driven + T+2 reminder per open case | — | open maintenance cases | case evidence | follow-up proposal | declared |
| `compliance-reminder` | per-property anniversary month | none | opted | last-service dates (manual evidence) | reminder case; shop rule only, no legal claims | future |
| `rent-review` | per-tenancy anniversary | none | opted | lease start, market notes | review case; **never an increase notice** | future |

### Atomic fields per record

- **Property**: `id, groupId?, address{street, suburb, state, postcode}, status(active|archived), policy, notesPath`
- **Policy** (property-level, shop rules): `rentSource, dueRule{weekday|dayOfMonth}, graceDays, courtesyUntilDay, levyFromRent{amountCents, cadence}?, notifyChannel, ownerUpdateCadence(weekly|monthly|off), spendCapCents?, afterHours?` — never-rules stay code-derived
- **Tenancy**: `id, propertyId, status, startedAt?, closedAt?, weeklyRentCents, cadence(weekly default), dueWeekday?, bondCents?`
- **Contact**: `id, role(tenant|owner|tradie), name, phone, email?, preferredChannel, tenancyId?, propertyId, safeguards{hardship, dispute, paymentArrangement, doNotContact}`; tradie adds `trade, afterHours`
- **Case**: `id, kind, state, propertyId, tenancyId?, holdReason?, origin{routine runId}?, evidenceIds[], proposalIds[]`
- **Evidence**: `id, sourceId, authority, collectedBy, observedAt, ingestedAt, staleAt, propertyId?, payload`
- **ImportIssue**: `id, kind, status, rawIdentity, candidates[], linkedPropertyId?, sourceId, createdAt`
- **PropertyGroup**: `id, name, address?, notes, defaultPolicyOverrides?`
- **Routine**: `id(=kind), schedule{type, time, weekdays?, dayOfMonth?}, scope{all|groupIds|propertyIds}, enabled, revision`

### Atomic rules

1. Per-property `ownerUpdateCadence` gates the owner-update loop per property; the loop runs weekly and skips properties not due.
2. Anniversary shapes compute from tenancy/property dates in agency timezone; a missing date means the routine skips, never guesses.
3. Scope may be all, a PropertyGroup, or explicit ids; archived properties and closed tenancies are excluded automatically.
4. Event-driven kinds (inbound, maintenance follow-up) are still typed kinds with evaluators — never saved prompts.

## Vertical load-off roadmap (after V3 + native Desk ship)

Ordered by PM hours removed per doctrine risk. Every wave stays draft/prepare/escalate only.

- **Wave 1 — the interrupt layer.** The source-safe foundation is built: a fixed Demo envelope → deterministic classify/exact property match → digest-addressed Evidence → one Desk case per thread → supervised reply draft → explicit external-send attestation → Waiting/Close. It stores no raw body/provider id/attachment bytes and holds licensed, ambiguous, secret-like or do-not-contact content. Next, after the named-office gate, add the actual read-only mail edge (IMAP or Graph OAuth; SMS webhook later), attachment quarantine and provider auth/revocation/recovery; then enrich maintenance detail (issue, tradie, quote status, access window) and graduate the operational Waiting date into the typed `maintenance-followup` reminder. This is the week-destroyer the PMS assistants never touch.
- **Wave 2 — calendar-driven loops.** Tenancy date entry in Book mode (fast batch paste + per-tenancy edit) feeds `lease-review` (T-90/60/30), `inspection-prep` (T-14), and a vacate/end-of-lease checklist flow (bond-claim prep drafts; the human lodges). Entry notices and rent-increase notices stay forbidden — coordination and prep drafts only.
- **Wave 3 — portfolio growth and the bad week.** New-management onboarding checklist (first-90-days case set), storm/event mode (one event → group case, bulk welfare-check drafts, owner bulk update), agency wording templates (courtesy SMS + owner letter voice overrides at policy level).
- **Wave 4 — proof.** A load-off ledger computed from Decisions: drafted / approved / escalated counts and honest minutes-saved (drafted never equals sent). Weekly view on Desk; feeds the training-partner pitch.
- **Never:** trust work, disbursements, tribunal bundles, tradie dispatch, tenant-facing automation, statutory anything.

## Screen architecture

### Desk

Default layout at ≥1280px:

```text
┌──────────┬─────────────────┬──────────────────────────────┬──────────────────┐
│ Nav      │ Case queue      │ Focused case                 │ Evidence/browser │
│ 4 places │ needs you/held  │ property + tenancy + person  │ why + handoff    │
└──────────┴─────────────────┴──────────────────────────────┴──────────────────┘
```

#### Queue

- Search address/person.
- Filter by needs-decision, held, licensee, source, age and routine.
- Sort by urgency/freshness.
- Rows show property, case type, age, source status and next human action.
- Queue count reflects cases, not properties.
- **Grouping:** rows collapse under `PropertyGroup` headers (building/strata complex or custom bucket) with per-group need-you/held counts; ungrouped properties sit under "Standalone". Group is optional metadata; it never changes evaluation or safety behavior.
- **Fast navigation:** `Cmd+K` command palette jumps to any property/case/loop; recent cases strip above the queue; `J/K` move through rows, `Enter` opens the case, `1–4` switch panes. Switching preserves in-progress wording edits per case.

#### Case canvas

- Address, tenancy, tenant/owner context and case status.
- Rent/levy/job facts with observation time and source.
- Structured safeguards: hardship, dispute, payment arrangement, do-not-contact and preferred channel.
- Proposed wording/next step, editable before Allow.
- One decision bar before approval: Allow wording, Edit, Deny. Copy and any context-specific bounded preparation appear only after approval.
- Decision history and “Done in PMS” recording never imply RealBud sent.

#### Evidence/browser rail

- Evidence timeline and evaluation explanation while idle.
- Case-scoped Bud prompts.
- Browser modes: side-by-side default; inspector takeover; separate RealBud window.
- Session header always shows case, origin, allowed actions, expiry and who must Submit.
- States: preparing, live, Bud prefilling, waiting for PM, verified, human-confirmed, effect unknown, expired, failed.

Presentation is not authorization. Side-by-side, inspector takeover and popout reuse one existing browser session and one immutable authorization; changing view cannot alter origin, recipe, tool list, expiry or operation.

`HandoffAuthorization` binds a closed operation, Case ID, Proposal ID + revision/hash, Property/Tenancy IDs, binding, immutable recipe/version, exact origins, recipe-step actions and expiry. URL checks compare exact `URL.origin`, never string prefixes. Submit/Send/Pay controls remain forbidden even if a recipe names them. A routine cannot mint or launch authorization.

#### Book mode

Book configuration is a secondary Desk mode, not another navigation place. It manages property/tenancy/contacts/policies and source matching without mixing configuration cards into the active queue. It also manages `PropertyGroup`s: create/rename/archive a group, bulk-assign properties, and set per-group defaults (courtesy window, channel) that new member properties inherit unless overridden.

### Ask

- Ask is the universal PM intent surface. The PM may describe any safe outcome in normal language; Bud reasons across the whole job and uses RealBud's server-owned current capability status to choose an answer, evidence check, single review card, bounded handoff or exact setup step. A closed action catalog limits execution authority, not what the PM is allowed to ask.
- Always shows current scope: portfolio, property, tenancy or case.
- Empty Ask offers PM starters: “What needs me?”, “Explain this hold”, “Draft an owner update”, “What changed since yesterday?”
- Courtesy targeting uses a searchable combobox over address, tenant name and property id, with keyboard navigation, explicit empty/no-match states and a bounded-height list; it must stay usable with hundreds of properties.
- The composer has a native file/image picker as well as paste/drop. Spreadsheets, PDFs, documents, screenshots and photos stay in their existing format and become structured, server-validated ACP resources; prompt text cannot grant a path. Bud may use document/vision tools on those selections but may not scan the device or silently widen scope. A collapsed deterministic quick-paste path remains available without a model; its completion state separately names staged, skipped and needs-attention rows and offers an explicit Review on Desk action without applying anything.
- When chat setup is incomplete, Ask replaces the dead composer/transcript state with the exact next worker/model/hands-test step and a guided handoff to You → Worker. Quick paste and Desk proposals remain usable, the draft is retained, and You provides a return to Ask. A reconnecting ready chat stays visible and announces connection recovery rather than silently swallowing interaction.
- Responses cite evidence and observed time.
- Assistant prose uses a single Warm Ledger document block with short-paragraph Markdown hierarchy, a visible Bud/time/copy footer and a light code treatment. Default activity rows use a closed PM-language presentation map; raw provider identifiers remain diagnostic-only.
- Rich connection/setup cards read status from a RealBud-owned adapter. Model text may request or explain a connection but can never render `Connected`, `Added`, tool count or account identity as truth.
- The sidebar remains the four-place action label **Ask**; the screen heading is **Ask Bud** and the composer names Bud. Explicit PM-owned requests to connect WhatsApp Business, Telegram or Pocket take a narrow code-owned path to the existing reviewable `open-setup` card without requiring a model call. This path is navigation only, declines external/tenant-facing wording, and rejects credential-shaped sends/edits before persistence or worker dispatch.
- Pocket uses that same rule: You owns the verified Telegram state; one private PM chat projects messages into canonical Ask and may render only the same server-authored manual action decision. It is never a separate session, mobile-only state owner or generic remote-control channel.
- A code-derived `Suggested next` row projects at most three recovery, failed-run, held-work, pending-draft or live-book actions from current Desk/Schedule state. It only navigates to the authoritative surface or starts an ordinary Ask turn; it cannot Allow, mutate, send or create a clock.
- Proposed external wording or case changes land on Desk for one approval.
- Default surface removes reactions, branching, regeneration, bot settings, agent mentions and raw tool/code activity.
- Advanced diagnostics discloses technical traces/provider health only; no extra capability appears there. It also shows exact version/build/runtime labels and keeps source, installed and named-office evidence separate. A PM-initiated support download contains categorical health, recovery states and counts only—never portfolio content, messages, source bodies, accounts, credentials or host paths.

### Schedule

- A Monday-first month calendar previews occurrences for built typed routines and exposes previous/next/Today navigation. Selecting an occurrence or legend item scrolls and focuses the existing routine editor. Paused/timezone-held states are named in text, not conveyed by colour alone.
- The calendar is a projection only. Date cells cannot create exceptions, arbitrary jobs, statutory clocks or new routine kinds; the existing time/weekdays/enabled PATCH remains the sole GUI mutation boundary.

- Named loops only.
- Each routine names the exact product dependencies it uses. Schedule derives Ready, Practice, Held, Recovery and Pilot-gated state from current Desk truth; it never renders model prose as connection truth.
- Each run shows its actual date/time and links to cases/proposals produced.
- New runs expand into a PM-language phase receipt. Receipt text is bounded and secret-redacted; old runs retain their final result and are labelled as legacy rather than receiving invented phases.
- Failure/missed/interrupted rows expose a recovery action.
- Planned loops can show their intended schedule but cannot run/enable.
- Successful schedule changes announce confirmation and revision conflict recovery in PM language.

### You

- Agency name, PM profile, timezone and jurisdictions.
- A sticky four-item in-page navigator reports General, Worker, Connections and Recovery state and moves only You's owned scroll pane. It is navigation, not another product surface, and keeps keyboard focus plus content visible at the 900 × 600 minimum window. General retains Agency/Profile and adds a compact General / Usage & costs / Updates control centre instead of creating a fifth product surface.
- The control centre projects authoritative owners rather than offering generic agent permissions. The book timezone and device mismatch come from Desk/Schedule truth; **Manual Allow · locked** has no switch, natural-language auto-approval rule or always-allow state; local computer work routes to the existing case-scoped Connection owner.
- Usage & costs is a private rolling seven-day observability ledger. It deduplicates retried/out-of-order turn events, stores hashed turn identity plus bounded counts/time/provider/model only, retains at most 90 days/2,000 turns and recovers a corrupt file without blocking Bud. It never stores prompts, messages, files, property data or credentials; never estimates missing tokens, dollars or provider limits; and labels the provider account/invoice as authoritative.
- The same panel names the commercial boundary without pretending billing exists: BYOK model spend stays with the provider, local RealBud work has no product meter in the current build, and optional cloud/browser acceleration is not connected or charged. A later commercial plan uses a simple base unit the PM recognises plus explicitly capped acceleration measured from durable completed-work receipts, never raw tokens. Exact prices wait for named-pilot willingness-to-pay and measured unit economics.
- Updates keeps the signed RealBud app and pinned private Bud runtime as separate owners. A source build truthfully exposes no release-feed action; the worker route opens the existing transactional A/B updater and never probes or changes personal Hermes.
- Source readiness, freshness and last import.
- Source connections use one read-only RealBud projection. Structured PMS export is the active money authority. Selected spreadsheets/PDFs/documents/screenshots/photos and paste/manual entry are active proposal-only intake methods, not competing sources of live balance truth. A separate read-only bank-activity method is visible as pilot-gated until digest-bound observations actually reach Desk; even then it is corroborating evidence only and can suppress questionable wording, not replace the PMS or perform trust reconciliation. The future direct API, private PMS browser recipe, restricted one-account Composio session and approved one-server MCP route sit under collapsed Advanced details as pilot-gated/not-built. The projection contains no raw URL, credential, tool catalog, connect action or execution grant.
- Property onboarding is a ranked source decision, not a file-extension quiz: current PMS export/report → selected evidence → paste/manual → named read-only API/connector → private browser/CUA fallback. Ask exposes these choices in place, Desk Book gives the current PMS CSV a prominent owner, and You exposes the same app-owned status. Working buttons only navigate to or invoke existing owners. Research and counter-evidence are recorded in `docs/research/PROPERTY-INTAKE-CUA-UX-AND-PRICING-2026-08-28.md`.
- The approved-capability hub searches and filters exactly seven code-owned entries across Portfolio, Inbox & calendar, This Mac and Pocket. The seventh is a collapsed Advanced work-methods status projection over code-owned adapter manifests and fresh runtime attestations; it is not a marketplace or setup owner. Search is bounded presentation only: no result can mint authority or infer connection truth. Empty search has a local reset; `Open Desk` and reminder controls call their existing owners; pilot-gated rows expose no fake Add button.
- Recovery reason, quarantined item count and guided next action.
- Browser profile status and retention policy in plain language.
- Advanced diagnostics contains Hermes version/profile/pack/model details.
- Computer use is one verified local connection row. A packaged macOS build reports the RealBud-bundled runtime as Included before permissions, Ready only after its embedded setup host starts, and names permission or repair recovery without inspecting a personal CUA installation. The setup host admits only permission checks. Each admitted work host requires a new exact-origin, isolated-profile, time-bounded version-2 policy; the server verifies the exact packaged executable, private regular descriptor/policy files, policy bytes and digest before exposing only the seven typed browser operations. Redirected/symlinked binaries, ambient window enumeration, generic desktop/input, clipboard, file and raw MCP tools stay unavailable. Descriptor authority is revoked before host transition. Setup never grants a case action.
- When Computer use is not ready, that row expands in place rather than opening a wizard. A numbered checklist distinguishes the included private runtime from the only two required macOS grants: Accessibility and Screen & System Audio Recording. Each missing grant has a fixed System Settings action, text and icon status, then one Check again action; repeated setup calls serialize at Electron. The copy tells the PM to choose RealBud, explicitly excludes App Management and separate personal automation helpers, and keeps Desk/Ask/Schedule usable after denial or failure. Microphone and notifications remain separate just-in-time capabilities.
- Desktop reminders appears as a verified local connection row. It can be turned on/off and emits generic OS copy only for failed/missed/interrupted runs or linked held work; tenant/property/balance/model text never leaves the window notification boundary.
- Pocket always appears as an app-owned connection row. Before the named-PM gate it explains `pilot-gated` and offers a real **View requirements** disclosure for the selected channel: named agency/PM, privacy approval and channel-specific infrastructure. The disclosure is accessible, performs no network work and contains no credential or fake Connect control. After the gate it shows provider, bot identity, allowlisted numeric PM id, off/connecting/ready/attention state and recovery guidance. Its token remains write-only and encrypted.

## Core flows

### Morning money

```text
source observed → match/validate → cases created/updated → safeguards checked
→ held / licensee / wording proposed → PM decides → optional bounded handoff
→ verified or PM-confirmed completion
```

### Friday owner update

```text
routine run → factual evidence gathered → owner-update case + proposal
→ Notes colour wording → PM edits/allows → Copy or bounded handoff → completion record
```

### Interrupt

```text
PM scopes Ask to property/case → Bud classifies using book + evidence
→ answer in Ask OR propose case/work on Desk → PM decides
```

### Recovery

```text
load/migration/source failure → writes + schedules pause → preserved data named
→ guided repair/re-import/re-apply → integrity check → PM resumes explicitly
```

## Onboarding and setup experience

Principles: the canonical first launch is name → three permanent rules → one focused setup decision at a time. The name and optional office email use one narrow session-gated profile endpoint with exact-field validation; settings show save failure instead of swallowing it, and the broad provider/credential writer cannot mutate the profile. The rules step previews what comes next without installing, connecting or requesting a permission itself. Its primary action opens a compact window-owning journey in the PM's working order: **Prepare Bud → connect a model securely → bring in the portfolio**. The normal navigation and You control centre are not mounted behind an active journey. Each screen has one primary action, one short reassurance and a restrained three-segment progress line—never the connection catalog, route preferences, agency discovery, pilot workflows or diagnostic summary. **Use the practice desk first** exits safely and You can reopen the same journey. Prepare Bud is one deliberate action that owns the private pinned install/update and idempotent code-owned safety-pack repair; the secure provider/model/key form is the only credential pause and Save & test performs the live check. A setup failure stays in place with plain retry copy; repair internals remain in the normal You owner. The current screen is recomputed from server-owned worker, book and recovery truth after reload; local storage remembers only whether the guide is pending and cannot grant readiness. Book or local-state recovery replaces the setup header/progress and presents only protected-state details plus the exact recovery-key action when applicable; leaving it opens the protected Desk read-only rather than exposing unrelated setup controls. The portfolio step returns to Ask's ranked PMS export, selected file/image, paste/manual and later named read-only connection routes. Live book and verified Bud are still the two essential outcomes; agency details, private computer use, recovery-key reveal, reminders and pilot connections remain truthful non-blocking follow-ons in You. Merely viewing the guide is network- and permission-silent. Onboarding completion, guide preference, recovery-key acknowledgement and hands-test fingerprints are UI guidance only and never grant execution authority.

### Journey states

1. **Appliance (first launch):** collect the PM name, state the three permanent rules (Bud prepares / exact Allow / regulated work stays human), then open the focused setup journey. Its primary action prepares Bud; its secondary action opens Desk on the labelled practice book. The first-run state is isolated, labelled and keyboard-safe; a failed profile save stays recoverable in place, keyboard focus stays inside the open dialog and an interrupted setup resumes from authoritative readiness.
2. **Go live:**
   - *Bring in the book:* attach or drop selected spreadsheets, PDFs, documents, screenshots or photos in Ask and tell Bud to stage the properties; every extracted property still needs Allow. This agentic intake is not money authority. To verify current balances and flip Demo → Live, drop one current structured PMS export anywhere on Desk, choose it from the checklist, or use Book → Import. Selecting the CSV now changes nothing: the server parses it against the current Desk revision and returns a privacy-bounded review containing detected column names plus aggregate matched, link-needed, conflict and missing counts. The PM explicitly chooses **Import**; commit must use the reviewed revision, observation time and exact byte digest, so a changed file or Desk must be reviewed again. Known aliases auto-map, matched rows flip Demo → Live, and unmatched/ambiguous rows land as held Import issues.
   - *Prepare Bud:* auto-detect the pinned private install, safety pack and masked provider/model state. Missing runtime or pack = Ask names the one PM-facing step and hands off to You, where the focused journey opens and one explicit **Prepare Bud** action resumes or installs the pinned private runtime and applies/repairs the code-owned pack. The flow then stops at the secure model form; Save & test writes the candidate transactionally and accepts it only after the live check. The normal You card shows only the current status/action; install, pack and diagnostic controls remain under Technical details and repair. Green requires the exact private-install + worker pin + provider + model fingerprint that passed the local hands test; reinstalling or changing any of them invalidates the guidance state. A partial install, interrupted repair or busy worker remains visible and resumes from the authoritative next state. Ask drafts survive the round trip and setup never grants execution authority.
   - *Name your agency:* optional and revision-bound in the encrypted local book. Timezone defaults from the system, currency is AUD, and courtesy windows keep shop defaults; real-office jurisdiction/dialect inference remains pilot-gated.
   - *See the rest before it is needed:* a compact follow-on strip names agency details, the RealBud-owned computer runtime, recovery-key acknowledgement, desktop reminders, and mail/calendar/Pocket pilot state. Status is derived from the existing owners; buttons navigate only. You → General offers the optional remembered work-method choice after this handoff; it is not another first-launch step. A missing optional item or unchosen work method cannot block Desk, import, Ask intake or Schedule.
3. **Live:** the Desk guide disappears when the two required rows (live source + verified worker) are green. You keeps its compact section navigator, current Bud status and recovery owner instead of repeating the full first-run map. Morning and Friday loops are already armed; no activation step exists. Three coach marks maximum, ever: Recheck, Allow→Copy, Schedule exists.

### Smart defaults and detection

- A personal Hermes installation is never detected or reused. RealBud checks only its absolute launcher under `~/.realbud/worker/runtime`; a fresh RealBud runtime therefore uses the in-app pinned install even when `hermes` exists on PATH.
- Install/update receives a private HOME, XDG/cache tree, Node and Python runtime. Host package-manager commands and personal SSH credentials are unavailable to the upstream installer. Hermes' generic browser and CUA bootstrap are deliberately skipped. macOS RealBud instead ships its exact pinned driver + native SDK in the app resources, resolves only that bundled executable in production and updates it only with a verified RealBud build; its bounded, case-scoped adapter remains the sole computer-use authority and human Submit remains mandatory.
- Provider/model auth already present on the worker profile is detected without echoing the key.
- Timezone comes from the system and cadence is weekly. Jurisdiction inference waits for a named pilot dialect rather than guessing from an address string.
- Demo data stays available for practice ("Replay sample morning") after going live.
- The macOS Accessibility/Screen Recording request is deferred until the PM explicitly chooses Computer use → Set up (or the first future approved Prepare portal action). That opt-in is remembered; an idle restart may start only the setup policy, never a workflow grant. A work policy is minted separately for the exact admitted recipe and destroyed on teardown. Denial leaves computer use unavailable with an in-app System Settings recovery path and never blocks the rest of the desk.
- The recovery path names both current macOS locations, asks the PM to enable **RealBud** rather than a standalone helper, and returns to the same row for Check again. If macOS keeps a stale Screen Recording result, the row asks for one quit/reopen; it never reports Ready from the user's toggle alone.

### Step budget

Preconfigured machine → live-ready guidance: **2 deliberate actions** (Save & test the model, then review/import a current structured PMS export). Common files/screenshots can stage the book earlier but do not prove balances. A fresh machine adds one **Prepare Bud** action; private install/update and safety-pack repair are not separate PM chores. No step requires a terminal on a normal office machine; the exact fresh-machine timing and recovery paths remain installer QA metrics rather than a promise.

### Partner walkthrough (doubles as the 90-second demo script)

Open on demo Desk → Recheck → open the Oak case → Allow wording → Copy → drop a real CSV → chip flips Live → Schedule already armed. No clicks outside the four places.

## State coverage

| Surface | Required states |
|---|---|
| Desk | loading, empty, ready, partial, held, recovery, stale, mutation conflict, success |
| Queue | no cases, filtered empty, loading, stale source, selected, keyboard focus |
| Case | proposed, approved, denied, superseded, cancelled, failed, effect unknown, complete |
| Import | selecting, preview, mapping, invalid rows, ambiguous rows, partial accept, complete |
| Ask | checking setup, setup required, connecting/reconnecting, empty scoped, streaming, approval waiting, failed, retriable, advanced |
| Schedule | loading, unavailable, on, paused, running, missed, interrupted, failed, changed |
| Handoff | preparing, live, prefilling, human-submit, verified, human-confirmed, unknown, expired |
| You | loading, ready, degraded source, recovery, diagnostics closed/open, save success/failure |

All save/copy/import/schedule actions announce success. Silent mutation is rejected.

## Emotional arc

1. **Orientation:** “This is today’s book, and these sources are current.”
2. **Confidence:** each case explains why it is here and which safeguards were checked.
3. **Control:** one visible human decision controls wording and handoff.
4. **Supervision:** browser work is watchable, bounded and case-linked.
5. **Closure:** work ends as verified, human-confirmed, held, licensee-required or explicitly unknown.
6. **Recovery:** failure names what was preserved and the next safe action.

## Responsive and accessibility plan

- ≥1280px: four-pane split view.
- 960–1279px: queue drawer + case + inspector.
- <960px: case-first; queue/inspector drawers.
- Full keyboard pane switching and queue navigation.
- Real modal semantics, focus trap, Escape and focus restoration.
- `aria-current`, live-region confirmations and `aria-busy` for long work.
- Visible focus; 40–44px controls; 14px minimum operational text.
- Reduced motion covers all custom and utility animations.
- No status relies only on colour.

### Worker card spec v2 (exact settings surface)

Rows (top to bottom): Engine (version · pinned / pin mismatch) · Property pack (installed · approvals manual) · Model (provider · model · `key stored securely` / `key required`, never a credential fingerprint) · Last hands test (answered/failed · time).

Actions: Install/Update worker (in-app, streamed; hidden when pinned+matching) · Apply property pack · Attach/Change model · Test hands · Check again.

Attach sheet fields: Provider (ten high-contrast card buttons backed by one shared server/renderer catalog: Anthropic, OpenAI, Google, xAI, OpenRouter, DeepSeek, Kimi, Z.AI, MiniMax, Ollama Cloud) · API key (**optional when the same provider already has a credential** — the sheet says the current key is stored securely and to leave the field blank to keep it; required when switching providers) · Model (selectable current compatible choices carried by RealBud, merged with bounded worker-cache discoveries from `/api/hermes/models?provider=…`, plus an explicit Other model ID fallback) · Base URL behind an advanced toggle (empty = provider default; server accepts only credential-free HTTP(S) URLs). Provider changes preselect a sensible compatible model instead of requiring memorised text. Save & test runs a real ping and records the result + timestamp. Key/model inputs reject line/control injection; legacy provider env aliases are recognised and migrated to the pinned worker's canonical name on save.

Locked (shown read-only inside Advanced diagnostics, managed by RealBud, never editable): `approvals: manual` · `cron: deny` · the three SOUL rules. Connectivity truth lives in the status detail + Last hands test row; source freshness lives in the Sources card.

## Ask as actor (action proposals)

Ask is not only conversation: Bud proposes actions on the system, the PM allows them. The proposal union is closed — anything outside it is refused by the worker contract and by the API.

| Proposal | Card shows | Allow runs |
|---|---|---|
| `run-routine` | routine name + one-run outcome | existing `runNow` with a durable action id |
| `change-routine` | old → new On/time/weekdays | existing clock PATCH (revision + no-backfill rules) |
| `add-property` | address/tenancy/rent fields | existing revision-bound Book proposal Allow |
| `configure-property` | exact bounded shop-option diff | existing property command after target-field revalidation |
| `set-agency-name` | old → new agency label | existing revision-bound agency command |
| `open-setup` | Worker, Desktop reminders, or Connections handoff | navigation to the exact human-owned section in You; never connection success |
| `prepare-handoff` | property + approved work + practice/pilot boundary + human Submit | consumes the exact one-use case authorization, then calls the existing bounded preparation owner; never Submit |

**Shipped 2026-08-26:** the model may return one exact `realbud.propose-action.v1` envelope. The server rejects unknown fields, resolves canonical property/routine/handoff ids, captures revisions and the one-use handoff authorization, generates the action id/title/detail and persists the proposal as an Ask message. The same pending card is projected on Desk. Allow/Deny calls the existing Desk/Schedule/You owner; retries are idempotent, unrelated Desk revisions are revalidated field-by-field, and competing edits make the card stale. Raw JSON is hidden behind “Preparing a change” while streaming. Each turn also receives a bounded, server-authored capability projection (ready / practice-only / setup-required / pilot-gated / unavailable) and at most twenty currently preparable handoffs; it contains no Notes, credentials, arbitrary paths or URLs.

Rules: Allow is the only execute path; send/trust/statutory/raw-browser/arbitrary-command actions are unreachable from the union; chat text can never mutate the clock or book directly. Setup proposals only navigate: credentials remain write-only in You and a model response can never assert that a service is connected. `prepare-handoff` is reachable only for an already-approved Draft whose exact capability, proposal hash, work item and Desk revision are still current. The Demo contract labels it practice-only. Its authorization is durably consumed before external work; a restart or uncertain acknowledgement becomes `effect-unknown`, never an automatic retry. The catalog intentionally does not include tenancy fact edits, source-of-truth balance changes, generic connectors, free-form routine creation, dependent multi-step plans or raw host CLI.

The action card now uses a one-time approval receipt pattern across Ask, its compact Desk projection and Pocket's bounded native message. Before Allow it presents Why / Permission / Stops at, the exact diff, request suffix, prepared time, authoritative revision check and any admitted execution route; Pocket carries the same action-specific permission and boundary within its provider payload limit. The latest five action requests/receipts remain visible in Ask even while missing worker/model setup pauses new chat, so Desk's View conversation cannot strand an approval behind the setup gate. The primary label is action-specific but always begins with Allow once; duplicate clicks lock while the owner runs. A successful owner response becomes **Bud completed the allowed step**, Deny becomes **Nothing ran**, and stale/revision failure becomes **Bud stopped safely** with the sanitized reason. Desk's wording bar says **Allow wording once**. Existing review memory still collapses familiar exact matches, but the UI explicitly says future work needs another Allow; there is no Always approve control or authority-learning store.

Property intake is the shipped first closed action: `intake-properties` reads only the selected common files/images and returns `realbud.stage-properties.v1`; strict parsing bounds every property and unreadable line, retries deduplicate through the existing proposal store, and the bridge creates open Desk cards only. Missing/unreadable/oversized selections fail before the worker runs. Malformed or unmarked JSON remains ordinary chat text and cannot touch Desk. Screenshot/OCR extraction never becomes live rent or trust truth: current balances require the structured PMS-export path.

The same field contract is enforced again at the authoritative Desk boundary, including direct and bulk adds: bounded address/name/phone/rent values, no control or escaped-newline injection, within-batch normalized duplicate checks and all-or-nothing mutation. Intake proposals separately deduplicate against the current book. A mixed quick-paste batch may stage valid rows while listing malformed rows for attention, but Allow cannot persist a row that fails those checks.

Bud's SOUL is personalised to the local PM, agency, book and property Notes for tone/workflow only. Its reasoning contract separates verified fact, inference and missing evidence; checks names/addresses/dates/amounts across selected evidence; and stops at statutory, tribunal, notice, trust and licensing boundaries. “Law-aware” means risk recognition and licensed-person escalation using only an explicitly supplied official source — never legal advice, a law crawler, model-memory law, a statutory draft or an invented clock.

## Pocket transport hub (source-built, live enrollment gated)

Pocket reuses the action broker instead of exposing the worker's general messaging gateway:

```text
named PM Telegram DM        named PM WhatsApp Business DM
        ↓ long poll                 ↓ signed Meta webhook
 Telegram adapter             WhatsApp Cloud adapter
        └──────────────┬───────────────┘
                       ↓
              RealBud PocketHub
             bounded one-PM queue
                       ↓
        canonical Ask thread → one Bud
                       ↓
           server-authored action card
                    ↓ manual Allow once / Not now
          existing Desk / Schedule / You owner
```

This takes the useful topology from the pinned worker's gateway—platform adapters around a shared session owner—without launching that gateway. Its general messaging path carries broad worker tools, cron, model/update commands and background-agent behavior that conflict with RealBud's closed capability broker. RealBud adapters receive only three handlers: canonical text, canonical action decision and sanitized local status.

**Alternatives rejected:** launching the upstream gateway would create another session/command surface with broader authority; forwarding every provider through a generic integration vendor would add a second credential/tenant trust boundary before a pilot proves the need; personal WhatsApp QR/Baileys automation is unofficial and exposes the wrong account boundary. **Rollback:** either channel can be disabled and its credentials removed independently without deleting Ask history or the other adapter. The Telegram v1 ledger path is preserved, so reverting the hub cannot make an old update new again.

Telegram text uses outbound-only long polling and needs no public webhook or inbound port. You stores one dedicated bot token in the encrypted secret store and one exact numeric PM allowlist. Setup validates the bot before storage; groups, other identities, non-text attachments, credential-shaped text and model/update/terminal/gateway commands are rejected. The existing Telegram ledger path is preserved across the hub migration so an application update cannot forget and replay an already-claimed update.

WhatsApp uses Meta's official Business Cloud API only—never personal-account QR/Baileys automation. You stores a permanent access token, App Secret and Verify Token encrypted, alongside the numeric Phone Number ID, exact PM number and local port. The webhook binds to `127.0.0.1`, bounds the raw body and concurrent connections, verifies `X-Hub-Signature-256` before parsing, validates the exact business-number route and PM identity, and does not report connected until Meta completes the Verify Token handshake for the current number/signing binding. Each provider message is durably claimed before the fast webhook acknowledgement; work continues on the hub's bounded serial queue. A real office still needs an agency-approved public HTTPS tunnel/reverse proxy, a dedicated business number and Meta business/privacy approval. Free-form replies remain subject to Meta's 24-hour customer-service window; template/proactive delivery is not claimed.

There is one transcript and one authority path. A mobile request calls the same `startTurn` used by Ask, waits for the canonical persisted completion, and returns that reply. Cross-channel turns and manual decisions share one serial queue; turns and decisions have separate bounded admission so a question burst cannot consume all decision capacity. Reconfiguration advances a generation and cancels old-channel work that has not started, while work already visible in canonical Ask cannot reply through newly saved channel credentials. A pending `realbud.propose-action.v1` is rendered with native manual buttons on either platform, but every callback invokes the same `decideCanonicalAskAction` function as the desktop UI. Existing revision, one-use authorization, stale-state, idempotency, human-Submit, send-403 and no-trust/no-statutory gates therefore remain authoritative. Pocket never receives a toolset or raw shell and cannot configure models, install/update the worker or broaden browser scope.

Transport effects are at-most-once by design. Telegram advances its update offset and WhatsApp stores a SHA-256 provider-message digest before any model or Desk work. WhatsApp keeps a bounded 5,000-message inbound replay window and a smaller outbound receipt window; both contain metadata only. A crash or reconfiguration after claim marks the request interrupted and never silently replays it or delivers through changed credentials. Each outbound chunk is marked `sending` before the network call and becomes `delivered` only after acknowledgement; a lost acknowledgement becomes `effect-unknown` and is not resent, while a known provider rejection is recorded separately. Ledgers retain bounded ids/digests, states and timestamps only—never tokens, messages, tenant data or model text. Corrupt state fails closed before contacting the channel. Token rejection stops the affected channel; Telegram transient failures use cancellable bounded backoff.

The checked-in Demo contract makes `pocketPilotReady` false, so normal product startup is network-silent for both adapters even if stale settings exist. Enabling or introducing credentials requires a non-Demo agency and named PM in `docs/PILOT-CONTRACT.md`; full release still requires the stricter eight-field contract. Telegram bot chats are not end-to-end encrypted, and WhatsApp needs Meta business/privacy approval plus public HTTPS infrastructure. Live named-PM enrollment/delivery proof, a stable production tunnel, mobile photo/file/voice intake, proactive mobile alerts, offline desktop service and additional platforms remain explicitly unshipped.

## Worker bridge control plane (Hands 2.0)

You owns the bridge end-to-end so a non-technical graduate never opens a terminal. First run and Ask handoffs use the focused setup journey; the default You card shows only the current status and one action. Raw runtime/pack/test controls remain collapsed under Technical details and repair:

- **Prepare and attach in-app**: one explicit Prepare Bud action resumes or installs the pinned private runtime and automatically applies/repairs the code-owned safety pack. The next step opens a clean card picker for the ten supported single-key adapters; key entry is written only to the `property` profile inside RealBud's dedicated worker home, with provider-specific compatible model cards plus worker-discovered/custom fallback. Save & test performs the live check, so there is no extra normal setup chore. The bridge authoritatively supplies the worker home, private process `HOME`, private install directory and absolute launcher to every probe, install and spawned instance; persisted config cannot redirect Bud into a PATH executable or personal `~/.hermes` profile, and cannot turn on ACP bypass permissions.
- **Worker update on pin bump**: You shows "Worker update available (app expects v0.20.x)" with a single Update button that runs the pinned installer, then re-runs the hands test. Never automatic, never tracks main, profile auth survives.
- **Health surface (read-only)**: pin/pack/approvals/model status, last Hermes call result, log location.

RealBud is the single control plane around the worker:

```text
Desk / Ask / Schedule / You        Telegram / WhatsApp Pocket
              \                         /
               RealBud identity + capability broker
               approval + state owners + receipts
                            |
                 pinned private Bud runtime
                            |
        selected files / bounded CUA / approved adapters
```

The GUI and Pocket therefore expose full PM outcome coverage through RealBud-owned capabilities, not raw engine commands. Bud may reason broadly and propose work, while only the owning RealBud reducer can change the book or clock and only the existing post-Allow handoff can touch a bounded browser. The same boundary prevents a channel from gaining model/update, terminal, credential or generic gateway authority.

Worker updates use a two-phase private-runtime transaction. Because the pinned upstream installer embeds absolute interpreter and checkout paths, RealBud installs into the inactive one of two stable private A/B slots rather than renaming a built directory. It verifies the exact version and checkout commit there, writes a fresh opaque install fingerprint, records activation pending, atomically switches the stable `worker/runtime` link and probes that active path again. One prior slot (or the pre-A/B legacy directory during migration) is retained. Failed verification leaves the active runtime untouched; failed post-activation health switches back and isolates the rejected slot. Boot recovery handles each crash point deterministically: restore the prior runtime if activation was pending, discard an uncommitted candidate when the active runtime is intact, and isolate an unverified first install. A single synchronous server lease serializes every worker-using or worker-reconfiguring path: Ask/Pocket, live Desk Recheck, scheduled hands, Test hands, model attach, pack repair and update preflight. It is acquired before the first await (and before Ask persists a message), released on success/failure/stall/reload, and conflicts return a visible hold without duplicate work or partial mutation. The property profile, encrypted model key and Desk data sit outside the replaceable runtime and survive update/rollback.

**Alternatives rejected:** exposing upstream self-update or its general messaging gateway would create an unpinned authority path; replacing the live runtime in place cannot classify partial failure; silently auto-downloading a repair would violate deliberate pin bumps and surprise office networks. Bundling every worker binary inside the app would make first-run more deterministic but materially increases signed artifact size and platform release work. Revisit bundling when Windows support or ten real office installs show that the private network installer is the dominant onboarding failure. **Rollback:** disable the new transaction and keep the last active private runtime; no Desk/profile migration is involved.

Model keys live only in RealBud's encrypted worker secret store and are injected into the selected provider child at spawn. They never enter the replaceable runtime, profile dotenv, `desk.json`, snapshots or logs.

Selected evidence is separate from computer use. The native OS picker/drop is human-initiated and limited to ten regular files of at most 50 MB each. The server ignores renderer-supplied names, MIME types and sizes, resolves the real path, and sends native ACP `resource_link` blocks. A portal remains a case-scoped, post-Allow bounded handoff with human Submit; Ask does not gain a generic browser or whole-device search.

Isolated Electron QA on 2026-08-25 used 36 properties and proved address/tenant/property-id search, keyboard Enter selection, Escape close, the explicit no-match state, all eleven provider cards, provider-specific model hints and a selected SVG image attachment chip. The run found and fixed cross-field false matches where a numeric tenant query could accidentally match digits in an opaque UUID; ordinary terms now stay within address/tenant details, while an id is matched only as the explicit query phrase. No credential or turn was sent.

A follow-up isolated Electron run on 2026-08-25 proved the previously hidden live Bud reply was already persisted, then verified the renderer fix end to end: provider-specific model cards changed without saving; an empty worker profile showed the exact Ask setup step, retained quick paste, focused You → Worker and returned to Ask; a killed local server produced a visible Reconnecting state, refreshed its rotated session after restart, rehydrated the transcript and preserved the unsent draft without a window reload. No additional model call was made.

An isolated browser + native Electron pass on 2026-08-26 reproduced and fixed four gaps: a configured non-default UI port was rejected by the session-origin gate; an escaped oversized quick-paste field could reach the encrypted book; provider/model cards lacked native arrow-key radio behaviour; and Schedule edits had ambiguous one-letter weekday names with no visible completion notice. The after-fix run proved mixed-row intake holds only the malformed row, native macOS image selection/removal preserves the existing unsent draft, fake-worker chat replies render, restart recovery preserves both Ask drafts, and Desk/Ask/You have no horizontal overflow at 1440, 1000 or 700 px. Paid-model image understanding remains a separate live gate.

A real-runtime recovery pass on 2026-08-26 found the prior Electron window still connected to the deliberately configured QA ACP stub, which made its fixture reply look like Bud. The stub was stopped and a clean backend was restarted with the default `hermesAgent` driver and a new isolated worker home. Ask then showed the exact model-setup handoff instead of a fabricated reply. The live hands probe now fails before spawning when provider/model/key state is incomplete, and provider failures redact credentials and translate engine/terminal setup hints back to You. The earlier chat-posted key appeared in the temporary profile during the pass and two fixed one-word probes ran before cleanup (worker telemetry: two API calls, estimated USD 0.0024239); that credential and its model block were removed, and the hands check returned to a zero-spawn setup failure. The key must be rotated and its replacement entered directly in RealBud before live conversation or image-intake QA.

A follow-up on 2026-08-26 traced two apparently ignored Ask messages to an ACP `session/load` that encoded a missing saved session as an empty success, followed by `stopReason: refusal`. RealBud now treats that exact pinned-worker response as a missing cursor, starts fresh and replays the bounded active transcript; all other unsuccessful ACP stops emit a visible error before the turn settles. Protocol tests cover recovery and the failure fallback. The same pass closed executable isolation: the installer receives a private `HOME`, `HERMES_HOME`, cache, Node, Python and install directory; verification addresses only the absolute private launcher and exact private checkout commit; the bootstrap script comes from that same immutable commit; host package-manager and personal-SSH access are blocked; persisted config cannot select PATH Hermes or full-auto permissions; and a fake-install regression proves separate personal launcher/credential sentinels remain byte-for-byte unchanged. A clean isolated live install then completed from the in-app path: its launcher, Node and Python all resolved inside the RealBud runtime, while the static personal Hermes launcher/profile/credential set and Homebrew formula set stayed byte-identical. Upstream generic browser/CUA setup is intentionally omitted because RealBud's bounded driver is the sole authority. Native Electron inspection verified the accessible month calendar, calendar-to-routine focus path and the post-reinstall Ask setup handoff without changing any schedule or execution authority. During accessibility automation, one Space key-up propagated into newly focused worker controls and caused one hands probe plus one two-call ACP reply (3 provider calls; estimated USD 0.00336503). The chat-posted credential was immediately removed, its verification invalidated and the Attach a model gate restored; rotate it before further conversational/image QA.

A later 2026-08-26 update-hardening pass accounted for the pinned installer's absolute launcher/venv paths by introducing stable private A/B runtime slots behind the unchanged RealBud launcher path. Deterministic tests cover legacy migration, failed staging, link-switch races, corrupt receipts, first-install isolation, rollback and exclusive-operation lease conflicts including idempotent/stale release. A clean network-backed run installed the real immutable pin into slot A and then installed it again into slot B; both active-path probes passed, the stable link changed targets, and slot A remained available as rollback. Another isolated live run kept sentinel personal launcher/profile files byte-identical. This closes source/live worker-transaction proof only; Node 24 packaged, notarized and installed-update proof remains on the release ladder.

A browser Stage-0 follow-up on 2026-08-26 corrected an overstated proof boundary. The fake portal had previously been an HTTP JSON double, so its green walkthrough did not prove that an agent could find and operate a changing DOM. It now serves an accessible visible task and a repeatable Agent Browser QA walk proves semantic fill/save on normal, reordered and delayed layouts, revocation before handoff, disabled plus server-refused Bud Submit, exact PM read-back and one human Submit. The execution owner now checks exact credential-free origin including port, recipe/version/body bounds, manual redirects and per-step timeouts before or during I/O; an unconfigured runtime fails visibly instead of marking an untouched portal ready. The pinned CUA 0.19.3 binary was separately inspected and does expose session, browser prepare/state/navigate/type/click/verify/end primitives. Its default MCP surface is much broader than RealBud's four typed actions, so it must not be passed raw to Bud. Wiring a CUA-native approved bounded session remains behind the named vendor-test account; the QA CLI is not product authority or live-CUA evidence.

The same review separated three CUA evidence layers. Fresh window/browser state is what adapts each live step; explicit trajectory recording is detailed QA material; Computer History is an opt-in encrypted metadata receipt for CUA-mediated actions. The current stable 0.19.3 pin exposes neither `history_status` nor `history_query`; the official feature remains a nightly preview and is not an MVP blocker. Do not move the PM runtime to nightly for it. After a stable history-capable pin and a named PM reconstruction failure exist, RealBud may query only the recorded session/case/time window, project a code-owned recovery receipt and preserve gaps as unknown. It must never feed Notes/evaluation, widen authorization, auto-replay an action or observe unrelated PM activity.

## Resolved V3 bulk-persist bottleneck (2026-08-25)

Bulk book approval now sends the exact visible proposal IDs plus the Desk revision to one `allowBookProposals` command. The command validates every proposal, field, normalized-address duplicate and the 200-property boundary before mutation, then adds the full set, evaluates once and performs one encrypted commit. Single-proposal Allow reuses the same path. A stale revision, missing/duplicate ID, invalid field or over-capacity batch adds nothing.

The 200-property scale test now allows all 194 non-fixture proposals through one commit under the default test timeout; the former 30-second exception is gone. Focused recovery coverage proves both write outcomes: a failure before atomic replacement restores working data, open proposals, new property Notes and the intake audit file; if the complete replacement reached disk but final durability confirmation failed, RealBud keeps that full batch visible, pauses further writes/schedules/browser work and requires a restart before more work. The queue snapshot contract remains under 2 MB.

## Operational hardening follow-up (2026-08-26)

### Routine and source-connection decision

The built morning clock now chooses the admitted structured PMS-export adapter instead of invoking the model for facts already on Desk. This reduces cost, removes model availability from a deterministic morning re-evaluation and keeps evidence authority in `MoneyPosition`; it does not discover a newer file or claim a PMS refresh. Stale, missing or conflicting evidence still produces held Desk work. Manual Desk Recheck retains the explicit worker path for PM-requested collection.

The connection UI is a read-only product projection, not a reopened generic integration registry. Its marketplace-like convenience stops at search, category filtering and compact truthful state over the seven approved capabilities; it has no install action, remote discovery or generic provider status. The Advanced work-methods row may say only Foundation built, Ready now, Needs recovery, Check expired, Revoked or Stable runtime unavailable from the app-owned adapter registry. Alternatives rejected for the Demo contract: the dormant generic Composio marketplace (broad discovery/meta-tools and a second credential boundary), user-entered MCP URLs (unreviewed server/tool authority), arbitrary custom APIs (unbounded endpoints/scopes) and scheduled CUA (layout/SSO/MFA ambiguity without the PM present). The permitted future order is direct read API → restricted Composio session → reviewed MCP adapter → bounded case-scoped CUA only where the earlier path cannot do the named job.

The source-built `realbud.execution-adapter.v1` foundation now gives all of those methods one closed admission vocabulary: exact code-owned transport/operation/route, hard concurrency ceiling, named-account and opt-in requirements, fifteen-minute runtime attestations, configuration-generation fencing, expiry/revocation and sanitized status. Cloud attestations additionally require region, retention, deletion, encryption, spend and complete local fallback. This does not connect a provider or create a sandbox by declaration; each real adapter still needs its implementation, failure matrix, installed proof and named-office shadow run. See ADR 0003.

Rollout is backward-compatible: receipt fields are optional in `loops.json` v3, legacy scheduled runs receive only their deterministic occurrence key, and legacy rows keep an honest no-phase-receipt presentation. Rollback may hide the new projection/receipt UI and return the clock to its prior executor without migrating Desk authority; persisted occurrence keys remain inert safety metadata. Revisit a live adapter only when the named-office contract identifies its PMS/account and a real workflow needs it. Revisit multi-step resumable plans only when two live workflows need resume, one has at least three dependent cross-system steps and repeated runs show single-action reconstruction failing.

Current source evidence: the isolated Node 24 verifier passes 136 test files / 946 tests with 8 skipped, both typechecks, Electron syntax, production build, the 36-check Desk/API walkthrough, the normal/reordered/delayed portal walkthrough, the read-only fake-bank browser walk, the native bounded-CUA denial walk and the isolated bank/CUA topology walk; the latest complete working-tree run was 39.4 seconds on 2026-08-28. A focused first-run follow-up completed the name and three-rule path, opened the single-decision setup journey, verified compact You re-entry, reload resume, Escape recovery and document width equal to the 900 px viewport without starting install, model, permission or portfolio side effects. A fresh isolated 900 × 600 browser pass selected a non-default work method, observed truthful resource fallback, reloaded into the persisted choice, restored Automatic, measured document width equal to the viewport and found no browser warning/error. A fresh isolated browser pass completed first-run profile setup through the session-gated boundary, opened Desk, persisted a You-profile edit across reload and downloaded the privacy-safe support report at 900 × 600 with no horizontal overflow or browser error. The import-review follow-up selected a mixed fixture export at 900 × 600, verified detected-column and exact matched/link-needed/conflict/missing counts, proved Cancel leaves Demo unchanged, then explicitly imported the reviewed bytes, observed CSV Live and one held unmatched row, confirmed initial focus and Escape recovery, and measured document width equal to the 900 px viewport. The intake/cost follow-up then exercised the ranked four-route chooser, staged one no-model property proposal, verified active versus pilot-gated source methods after a coherent backend restart, confirmed the non-billing cost boundary, opened the prominent Desk Book import owner and found zero horizontal overflow or browser warnings at 900 × 600. Isolated browser QA also covered all four surfaces at 900 × 600 plus Desk at 1440 × 900, then restarted against a deliberately truncated routine file and proved automatic You → Recovery ownership, exact routine-clock wording, preserved bytes, paused clocks, disabled Resume/time/day mutations, normal book-recovery key semantics and a clean fresh-window console. This remains source/simulated evidence. Earlier browser QA completed first run, executed morning money, expanded its four phase receipts, then exercised the You section navigator, capability search/category/empty recovery, implementation-method reveal and real Open Desk route. A later isolated Electron Desk pass exercised the familiar-review summary, active-safeguard fallback, queue counts/search/empty recovery, exact-wording disclosure, evidence drawer and fixed decision bar at 1440 × 920, the 960–1279 transition and the app's 900 × 600 minimum. It found no horizontal overflow, alert or console error and fixed a double sidebar offset in the narrow queue drawer. The earlier You nested-scroll correction still keeps section jumps inside You's content pane, and the calendar's minimum table width keeps Monday through Sunday visible at the supported minimum. A 2026-08-27 CUA-driven browser walkthrough exercised all four surfaces, changed/saved/reverted a routine clock, ran morning money, staged mixed valid/incomplete intake and explored connection/model states. It then proved Schedule survives an in-window reload, intake offers Review on Desk without applying, Desk empty Evidence uses PM language, and the stored-model summary exposes no key fingerprint. The Pocket follow-up proved the navigation remains four places with an Ask Bud thread heading, the WhatsApp requirements disclosure is keyboard-readable, locked channels expose no credential or cosmetic Connect control, the 900 px layout has no horizontal overflow, and credential-shaped Ask input is refused without transcript persistence. The You-controls follow-up exercised General, Usage & costs and Updates at 900 × 600, verified the honest empty meter and source-build update state, routed local work to Connections and worker repair to Worker with focus, and found no horizontal overflow or console error. The permission-onboarding follow-up verified the private-runtime/Accessibility/Screen & System Audio Recording checklist, fixed-pane recovery and exact focused owner at 900 × 600, and fixed an ESM packaged-entry path defect before the final verifier. The digest-only fake broker and durable 131-item mixed-lane simulation additionally prove crash, retry, fencing, cancellation, same-account serialization and unknown-effect behavior with zero missing/duplicate outcomes while every live capability stays gated. The fake-bank proofs add exact-code weekly/fortnightly matching, duplicate and discrepancy holds, broker-to-Desk crash recovery, raw-reference non-persistence, server-refused transfer/payee routes, a disposable browser profile, exact CUA PID/endpoint validation and native denial of ambient windows, generic desktop capture and off-origin navigation. Selected-file tests additionally prove private copies, source preservation, symlink/changed-file and aggregate-bound rejection, exact startup cleanup, system-denied tool requests, and partial-result discard on time/output ceilings. A fresh Node 24 arm64 directory build is locally Developer-ID signed and passed required property-pack/CUA resources, pinned-CUA version/architecture, hardened signature and entitlement verification. Its strengthened two-launch isolated mock-Keychain smoke applied and verified the safety pack and manual approvals before checking encrypted renderer/Desk/model persistence, personal-Hermes/CUA isolation and shutdown. A separate packaged GUI pass installed the exact private worker in about 57 seconds, staged and manually allowed a fixture property, ran and paused/resumed morning money, exercised Connections/Usage/Updates and responsive Desk search at 900 × 600, proved authenticated send remains 403, and preserved the seven-property book plus routine receipt across restart. The worker currently occupies about 1.6 GB, so installed footprint and representative 100-property resource/latency proof remain open. The artifact came from the dirty shared working tree, was not notarized or installed as a release, and is not an immutable candidate, real-Keychain/TCC, funded-model, live-account, production recipe bridge, update-feed or distribution proof. No replacement funded key, provider-reported cost, external account or live source was used.

Latest verification delta (2026-08-29): after the window-owning first-run and focused-recovery correction, the full Node 24 source owner passed 136 files / 951 tests / 8 skipped and every browser/CUA walkthrough in 39.7 seconds. A separate fresh 900 × 600 browser pass completed name and three rules, proved the active setup owns the window with no operational navigation or You controls, resumed the authoritative worker step across reload, exited safely to the practice Desk, re-entered from You, and replaced a simulated locked book with the focused recovery-key owner. Both normal and recovery states had zero horizontal overflow or browser warnings/errors; no worker install, model save, permission request, portfolio mutation or external account occurred. The previously rebuilt Developer-ID-signed arm64 directory app still passed its historical package verification and isolated two-launch smoke, but it predates this source UI delta and is not installed proof for it. Its bundled production probe held the current 1.6 GB-free machine before staging because Bud requires 3.0 GB free. Real installed first launch, Keychain/TCC, immutable-package rerun and named-office proof remain open.

### Local-first work routing (2026-08-27)

ADR 0001 (`docs/adr/0001-realbud-owned-work-routing.md`) fixes the ownership split before adding concurrency. RealBud owns workload shape, route selection, resource gates, account serialization, profile isolation, receipts, cancellation, reconciliation and Desk projection. Hermes remains an external immutable pin behind the existing bridge; RealBud does not vendor, modify or expose its subagent/browser/terminal surfaces. A stateless analysis context is an implementation lane, not a second Bud.

The first source slice is shipped as `realbud.work-routing.v1` and `/api/work-routing`. It projects the current Desk property count as one deterministic local batch, makes cloud optional, caps future independent private browsers at two and visible CUA at one, and falls back to Local standard before launch when a requested route or CPU/memory budget is unavailable. Opaque account concurrency keys are used only inside the planner and are never returned. The response contains no source content, credential, cookie, raw tool or personal path. You → General renders this app-owned truth and keeps Connections as the existing setup owner.

The same panel now offers four outcome-language preferences: Automatic, Steady on this Mac, Faster on this Mac and Cloud when connected. A narrow session-gated PATCH accepts only that closed enum plus the expected previous value and monotonic revision, persists atomically in RealBud config and rejects stale or ABA competing editors. A failed save restores the last confirmed UI value and refreshes authoritative state. The planner records whether the PM explicitly chose a value, but readiness and fallback always override it. Selecting cloud while it is unavailable therefore saves the future preference and truthfully selects Local standard; it never fabricates a connector or price. This deliberately borrows the understandable router pattern without exposing provider internals or widening the first-launch modal. Hermes' newer managed copy of an existing Chrome profile is not adopted: RealBud continues to require a separate RealBud-owned browser profile and never copies personal cookies, saved logins or passwords.

Admitted morning-money proposals now carry that same server-derived structured-batch plan into Ask. The action card shows the selected mode, lane, record and batch counts, bounded concurrency, measured-or-unavailable timing, cloud requirement and fallback reason before Allow. The decision boundary revalidates the plan against current routing state; stale or malformed plans fail closed, idempotent retries never rerun the owner, and gated or unknown routes are not projected as available work.

The read-only `realbud.work-routing.v1` projection is no longer mistaken for execution authority. Every newly admitted structured import, selected-file analysis, fake-bank read and fake-portal prefill is now backed by an immutable `realbud.work-plan.v1`. The plan binds exact input/data-class/account digests, recipe/origins, the ordered route chain, adapter version/configuration/freshness proof and the PM request, scheduled occurrence or one-time Allow that authorized it. Possible-effect and remote work require the one-time Allow class; scheduled authority is restricted to local read/draft routes; a local primary cannot silently add cloud. A retryable read-only cloud failure may move only to a later fresh local route disclosed in the same plan, requires and increments the exact current broker fence, and cannot be moved backwards or rerouted after expiry. Legacy broker v1 rows remain readable but receive no inferred adapter or fallback authority. The Ask route card now clearly distinguishes on-device execution, visible-computer work and an admitted cloud lane instead of displaying the same generic cloud line for all three.

The planner intentionally marks a requested analysis/browser/CUA lane gated until its typed adapter is ready. Duration is returned only when every selected route has measured lower/upper bounds; otherwise the UI says timing is unavailable. This prevents a hypothetical “100 properties in 8–12 minutes” from becoming product truth before a real workflow produces benchmark receipts.

The first real reconciliation seam is now shipped. `/api/desk/import-preview` runs the production parser and resolver without changing Desk and returns only detected column names, aggregate impact, the Desk revision, observation time and selected-byte digest. The renderer keeps the selected bytes only until Cancel or explicit Import. `/api/desk/import` rejects a supplied digest that no longer matches, then admits the structured PMS aggregate through the durable broker, binds it to the exact Desk revision and output digest, and commits a digest-bound source marker with the encrypted evidence before settling the receipt. A failure before Desk commit is retryable; a crash after Desk commit but before broker settlement reopens as `evidence-ready`, detects the marker and settles without reimporting or minting duplicate drafts/holds. A broker recovery error pauses only these imports and returns a sanitized recovery state rather than bypassing the owner. A local Node 24 microbenchmark over a complete 200-property matched export measured the read-only preview at 0.672 ms median and 0.782 ms p95 on the current development machine; this measures parsing and resolution only, not encrypted commit or installed-office latency.

### Read-only bank observation foundation (2026-08-27)

The first bank slice is a typed, read-only evidence adapter and local visible fixture, not a live bank integration. The PM sign-in/MFA boundary is explicit. The scripted browser may read only a bounded recent-credit list from one exact origin; transfer and payee controls are disabled in the DOM and refused server-side. A hybrid fixture also proves the intended isolation seam: one disposable browser process/profile, exact PID and DevTools-endpoint validation by pinned CUA, and a native version-2 policy that denies ambient window enumeration, generic desktop access and off-origin navigation. The broker persists only opaque digests, route/recipe/origin metadata and receipt state. Desk persists deterministic transaction markers and derived evidence, never credentials, account numbers or raw payment references.

Matching is deliberately narrower than trust reconciliation: exact configured property code plus exactly one or two weeks of configured rent. Unknown, ambiguous, amount-mismatched and multiple-credit cases land as redacted holds. A later bank observation that says paid while fresh PMS evidence says unpaid changes the position to conflicted and stales any warning wording. Bank absence never proves non-payment, bank evidence never creates wording by itself, the PMS remains the money/legal authority, and all transfer, payee, payment, allocation, disbursement and trust-reconciliation operations remain unreachable. The named bank, read-only test account, simultaneous-session behaviour, MFA/auth expiry/rate limit/revocation, packaged private browser, production recipe-to-Electron bridge, installed permissions and PM pilot are still open evidence gates.

The Demo-only `realbud.work-broker.v1` now persists digest-only receipts through atomic batch admission, bounded leases, fencing, cancellation generations, expiry, retry limits and restart reconciliation. Each new row includes its content-free work-plan and fresh adapter binding; legacy rows remain recovery-readable. A persisted possible-effect boundary becomes `effect-unknown` after interruption and cannot be leased again. The offline simulator drives structured, local-analysis, isolated-browser and desktop-shaped jobs through that broker without network, model, browser, desktop or worker access. Its durable mixed run accounts for 131 items with zero missing/duplicates and preserves settled/unknown/cancelled states across reopen. Production capability flags remain gated, so this proof cannot make a connector look ready.

The broker-to-Desk aggregate, serial brokered selected-file analysis, fake-bank read-only slice, native bounded-policy/hybrid topology and deterministic fake-portal broker source proofs are complete. The fake-portal broker admits one exact loopback origin/port and recipe/version, persists only digests/receipt metadata, marks the possible-effect boundary immediately before prefill and prevents replay after an ambiguous acknowledgement; it never calls Submit or exposes a browser CLI, raw CUA or terminal. Remaining implementation order is the R2–R6 list in `TODOS.md`: enforce and measure the analysis resource boundary before considering a second lane; bundle the private Chromium/profile pool; connect an admitted recipe to Electron's bounded-session owner; prove one named bank and one named vendor operation on an installed build; add an optional cloud adapter only if needed; collect measured PM workflow/release proof. The morning schedule must not collect bank data until that named adapter proves PM login/MFA, expiry, rate limiting, revocation and same-account session behaviour. Same-account parallel login is rejected until vendor testing proves session safety. Rollback disables the adapter and replans unfinished work locally; any possible external effect stays `effect-unknown`.

The serial R2 analysis boundary is now active on ordinary Ask attachment turns. RealBud re-resolves the PM's explicit selections, applies per-file and aggregate bounds and copies only those bytes into a private per-turn workspace. It admits a digest-only read-only receipt, creates a fresh worker profile containing only the code-owned property pack and sanitized provider/model/endpoint fields, denies every requested tool permission and enforces time/output ceilings. Strict `realbud.selected-file-analysis.v1` output is encrypted under the Desk key before the receipt becomes evidence-ready; a crash can replay that authenticated artifact without another model turn, and the receipt reconciles only after the Desk projection lands. Ask sees only the validated PM-facing projection. Tool requests, malformed output, stale fences, cancellation, storage uncertainty and concurrent-lane contention fail or hold explicitly. Final workspace cleanup completes before Bud becomes idle; startup recovery removes exact abandoned RealBud turn directories and source files remain untouched. The adapter changes only RealBud's wrapper around the immutable pinned worker. OS-level CPU/memory/network isolation, an optional measured second lane and the representative 100-property benchmark remain required to complete R2.

The local data path now has one process owner. `realbud.lock` records the server PID, only a dead PID can be recovered as stale, and a second live server fails before it can open the encrypted book. All ordinary Desk commits use the transaction semantics above, including exact reducer-state rollback and restart projection tests for archived properties, statutory escalation explanations and ambiguous import candidates.

Packaged Electron now obtains the Desk and application-secret wrapping keys from OS credential storage. Plaintext legacy key files are migrated only after the encrypted record is written, read back and decrypted successfully. A direct source server refuses a directory containing the desktop's OS-protected key record before vault or Desk startup, so it cannot generate development keys and quarantine valid encrypted state; source QA must use an isolated `REALBUD_DATA_DIR`. Provider, integration and worker credentials are encrypted at rest, never returned by status APIs, injected only into the selected worker process and removed from the packaged server's inherited environment. Retention runs on open and commit, preserves Evidence referenced by live authority records, removes expired unreferenced Evidence/positions and bounds encrypted backups. A retention failure fails closed instead of silently growing or deleting state.

Release production is now separate from ordinary QA packaging. Release commands require Node 24, all eight real pilot fields, an explicit review acknowledgement, a clean checkout and platform signing credentials; macOS also requires notarization credentials. Verification scripts inspect bundled resources/native architecture, signatures, hardened entitlements, Gatekeeper/stapling in release mode, Windows Authenticode and updater metadata. macOS verification also requires the exact pinned CUA executable version/architecture and SDK resources; installed smoke proves packaged resolution ignores an ambient `CUA_DRIVER_PATH` sentinel while leaving real permission consent to manual first-launch evidence. The current macOS arm64 QA directory app is signed and passes a two-launch isolated smoke with a test-only mock Keychain; it is deliberately not notarized and does not prove a real-Keychain first launch, macOS x64, Windows, paid-model image intake or a live office. The exact proof ladder is in `docs/RELEASE-EVIDENCE-CHECKLIST.md`.

Source-candidate closure now has one fail-fast Node 24 owner: `scripts/verify-source.mjs` runs the full test suite, both typechecks, every Electron entrypoint syntax check, the production UI build, the 36-check Desk/API walkthrough, visible portal and bank browser walks, the native bounded-CUA denial walk and the isolated bank/CUA topology walk sequentially. It names the first failed gate and never upgrades source proof into packaging, installation, CUA-permission, model, pilot or distribution evidence. The QA-only browser driver is an exact `agent-browser@0.27.0` dev-lockfile dependency; the walkthrough prefers that local entrypoint and retains the same exact-version fallback for isolated ad-hoc runs.

## Blind-spot register (2026-08-25 sweep)

Systematic "fresh graduate machine" + data-safety hunt. Fixed immediately: worker probes now address the absolute RealBud-owned executable (Finder PATH and personal installs are irrelevant); recovery/migration no longer hardcodes Australia/Sydney; Electron takes the single-instance lock (a second launch now focuses the window instead of silently forking a second harness over one book).

Mapped to work:

| # | Sev | Blind spot | Lands in |
|---|---|---|---|
| 1 | P1 | Windows build ships but the pinned worker cannot be installed from the app (`installCommand` null on win32) | T11 — bundle worker or explicit "CSV-only on Windows" copy before NSIS ships |
| 2 | P1 | ~~Three-rules onboarding implemented but mounted nowhere — first launch skips the safety framing~~ | **Fixed 2026-08-25:** isolated first-run name/rules state + persistent completion; truthful Desk/You live-readiness checklist |
| 3 | P1 | ~~`desk.key` loss = permanent lockout~~ | **Fixed:** recovery key reveal/copy plus quarantined-book unlock; packaged wrapping keys now use OS credential storage. |
| 4 | P2 | ~~Failure/stale signals are passive-only: missed runs and held sources surface only if the PM opens the app; zero OS notifications; You sources lack last-checked times~~ | **Partly fixed 2026-08-26:** optional privacy-safe desktop reminders for failed/missed/interrupted and linked-held runs, with durable dedupe + click-through. Source last-checked timestamps remain T14. |
| 5 | P2 | ~~`retentionDays` was unenforced and backups accumulated~~ | **Fixed 2026-08-26:** referenced Evidence is protected, unreferenced expired data is swept, backups are bounded and cleanup failure is read-only. |
| 6 | P2 | ~~Desk/provider wrapping keys were plaintext beside app data~~ | **Fixed 2026-08-26:** packaged OS credential wrapping, verified legacy migration and encrypted application/worker secret stores. |
| 7 | P2 | ~~Legacy generic setup could reach a Terminal/local-computer path hidden from the RealBud UI~~ | **Fixed 2026-08-26:** product mode denies generic engine setup and every local-computer playground route; Electron's terminal IPC also refuses outside the explicit non-product test fleet. Bud install/model setup remains in You. |
| 8 | P2 | Packaging trust gates: notarized universal coverage and signed Windows remain unproved | **Partly closed 2026-08-26:** gated release preflight, arm64/x64 build paths, entitlement/signature/notary verifiers and isolated installed smoke exist. Real notarization, x64 artifact and signed Windows proof remain external release gates. |
| 9 | P2 | ~~Installer is `curl \| bash` with no preflight, result verification or executable isolation~~ | **Fixed 2026-08-26:** in-app preflight + pin verification; private HOME/install tree; absolute RealBud launcher; personal-install sentinel regression |

Checked and fine: port-collision fallback chain, Ask retry/failure UX (including missing-session refusal recovery), demo seeding, atomic write durability, analytics fully off, loop bookkeeping caps, and Windows CLI shim resolution. Windows still has no supported pinned worker installer and remains separately gated in row 1.

### Operational-readiness delta (2026-08-26)

This pass closed the highest-risk money path: complete-coverage PMS evidence, duplicate/conflict holds, newest-snapshot projection, stale-proposal lifecycle, server-side Allow revalidation, worker-output non-authority, revision-required import, async Recheck race refusal, and optimistic concurrency for Schedule. The HTTP walkthrough now deliberately reacquires current PMS evidence after an unavailable Recheck before it allows portal wording.

It does **not** make the demo appliance office-ready by itself. Ordinary-mutation rollback/unknown outcomes, the process lock, retention and OS-backed secret wrapping are now closed locally. The remaining release gates are evidence or pilot dependent: all eight named-office fields and the real export dialect; a live-office run; manual first launch with the real OS credential store and permissions; notarized/stapled macOS arm64+x64 proof; signed Windows proof plus an honest Windows worker/CSV-only decision; and a rotated funded provider key proving conversation and image intake. Direct-V3 commands remain bounded architecture debt behind the validated transactional bridge, not a reason to widen the MVP before the real workflow requires it.



| Screen | Direction | Artifact |
|---|---|---|
| PM case/evidence Desk | A — Warm operational ledger | `~/.gstack/projects/EzAuto399-PropertyMe/designs/realbud-pm-case-spine-20260824/concept-board.html` |

## V3 module boundaries

- `shared/desk-v3.ts`: record contracts and closed unions only.
- `server/desk-v3-decode.ts`: strict V1/V2/V3 decoders and referential-integrity validation.
- `server/desk-v3-migrate.ts`: pure deterministic V1→V2→V3 transforms; no filesystem access.
- `server/desk-v3-project.ts`: V3→compatibility DeskSnapshot and bounded queue/case DTOs.
- `server/desk-store.ts`: encryption, backup, fsync, atomic commit and recovery orchestration only.
- `server/evidence-projector.ts`: immutable Evidence ingestion and current projections.
- `server/case-evaluator.ts`: structured DTO evaluation; no Notes/filesystem access.
- `server/handoff-auth.ts`: immutable handoff authorization and exact-origin enforcement.

Avoid a generic repository/service layer. Each module owns one trust boundary and remains file-backed until the 200-property benchmark proves otherwise.

## Engineering test matrix

| Area | Required coverage |
|---|---|
| Version chain | Plain V1→V2→V3, encrypted V2→V3, existing V3 reload |
| Identity | Stable Property/Work/Draft/Capability IDs; deterministic tenancy/contact IDs; Notes path unchanged |
| References | Duplicate IDs, orphan proposals/handoffs, missing source/recipe/binding/property |
| Evidence | Source-observed vs ingested time, legacy-unverified, conflicts, stale/partial/reversed/zero-match |
| Cases | Every WorkState, held without proposal, licensee escalation, ImportIssue separation |
| Decisions | Pending/allowed/denied, missing actor/time, immutable revisions, no invented history |
| Capabilities | Used/unused/expired/invalidated, migration invalidation, no expiry extension/resurrection |
| Atomicity | Failure before/during backup, candidate write/fsync/read-back/rename/directory fsync |
| Recovery | Original V2 byte-identical, Desk read-only, schedules/browser stopped, retry after repair |
| Hard gates | Send 403, no trust/statutory path, code-owned never rules, Notes cannot affect evaluation |
| Browser | Exact origin, prefix lookalike denied, recipe-step actions, all views share one authorization |
| Routines | runId origin link, recovery pause, no CUA mint/launch from clock |
| Groups | assign/unassign/archive PropertyGroup, per-group counts, inherited defaults, migration of ungrouped books |
| Scale | 200 properties, 18k–36k Evidence rows, <2 MB queue snapshot, bounded evaluate latency |

## Implementation Tasks

- [ ] **T1 (P1, human: ~1 day / CC: ~30 min)** — Design system — Implement `DESIGN.md` tokens/primitives and remove Grok palette/mascot-first shell.  
  Surfaced by: passes 4–5. Files: `src/styles.css`, shared UI primitives. Verify: token audit + visual regression.
- [ ] **T2 (P1, human: ~10–15 days / CC: ~3–5 days)** — Domain/data — Define full V3 contracts, strict decoders, immutable evidence/projections, atomic V2→V3 migration and compatibility snapshot.  
  Surfaced by: design pass 7 + V3 eng review. Files: V3 modules above, current Desk/evaluators. Verify: complete migration matrix + all hard-gate tests.
- [ ] **T3 (P1, human: ~4 days / CC: ~1 day)** — Desk shell — Build adaptive queue/case/evidence split view and Book secondary mode, including PropertyGroup grouping, command-palette/keyboard fast navigation, CSV drop-target, and the Go-live checklist card.  
  Surfaced by: pass 1 + onboarding section. Files: `DeskPage.tsx` split into focused components. Verify: keyboard/responsive/state tests.
- [ ] **T4 (P1, human: ~6–8 days / CC: ~2–3 days)** — Case/evidence breadth — Surface current/historic tenancies, owner/tenant/tradie contacts, safeguards, maintenance/lease/inspection cases, evidence and immutable decision history.  
  Surfaced by: passes 1–3 + full-breadth decision. Verify: every Case type/state and ImportIssue renders.
- [ ] **T5 (P1, human: ~4 days / CC: ~1 day)** — Bounded browser workspace — Add side-by-side default plus inspector/popout modes; implement full handoff lifecycle and completion semantics.  
  Surfaced by: passes 1–2. Reuse: existing CUA lease/recipe/capability. Verify: origin/expiry/human-Submit/effect-unknown E2E.
- [ ] **T6 (P2, human: ~3 days / CC: ~1 day)** — Ask — Create case-scoped PM default and Advanced diagnostics; remove generic-agent affordances from default.  
  Surfaced by: pass 4. Verify: no bots/models/tools appear in default product mode.
- [ ] **T7 (P2, human: ~2 days / CC: ~4 h)** — Schedule — Link runs to produced cases/proposals and add complete loading/error/recovery states.  
  Surfaced by: passes 2–3.
- [ ] **T8 (P2, human: ~2 days / CC: ~4 h)** — You — Make agency/source/recovery primary; move Hermes internals under Advanced; mirror the Go-live checklist with worker/provider auto-detection.  
  Surfaced by: passes 3–4 + onboarding section.
- [ ] **T9 (P1, human: ~3 days / CC: ~1 day)** — Accessibility/state pass — dialogs, focus, keyboard, confirmations, reduced motion and narrow-window behaviour.  
  Surfaced by: passes 2 and 6. Verify: WCAG-oriented manual checklist + automated smoke tests.
- [ ] **T10 (P1, human: ~2 days / CC: ~4 h)** — Live QA — Run the full source→case→decision→handoff journey on demo/fake portal before pilot data.  
  Verify: `/qa`, before/after screenshots, zero send/pay paths.
- [x] **T11 (P1, source complete / installed proof gated)** — Worker bridge control plane (Hands 2.0, zero-terminal) — The user never sees Terminal or the hermes CLI. One explicit **Prepare Bud** action resumes or installs the pinned private runtime, streams progress, runs dependency plus 3.0 GB capacity preflight and automatically applies/repairs the code-owned safety pack. Capacity is checked again before staging so a low-space change after preflight still creates no partial runtime. The secure provider/model/key form is the only credential pause; Save & test performs the live check. The normal card shows one current action while reinstall/update, pack repair, diagnostics and an explicit repeat check stay under Technical details and repair. Updates remain manual and transactional, profile auth survives, and PM-facing vocabulary says Bud; "Hermes" remains inside Advanced diagnostics only.
  Remaining proof: a clean installed/notarized Mac must complete install → model attach → portfolio intake with Terminal never opening, recover from interrupted install/pack/model failure, preserve profile auth across update/rollback and prove no personal Hermes executable/profile/credentials changed. Keys must never enter logs, `desk.json` or Ask.
- [x] **T12 (P1)** — Ask as actor — Shipped universal PM intent over a closed action broker for run/retune, property add/options, agency label, exact setup handoffs and an already-approved bounded portal preparation. Current capability truth is server-owned; diff cards render in Ask and mirror on Desk; Allow applies through existing owners; Deny discards; retries, interrupted/unknown effects and stale/competing writes are tested.
  Remaining only when evidence requires it: more code-owned routine/property capabilities and a named read-only source adapter. No chat path executes without Allow; send/trust/statutory/browser/generic tools remain unreachable.
- [x] **T13 (P1, source complete / live gated)** — PM Pocket adapter hub — Telegram long polling and official WhatsApp Business Cloud text/native decisions may both project one exact PM identity into canonical Ask. The RealBud-owned adapters use encrypted write-only credentials, exact identity/business-number routing, signed and bounded webhook input, durable pre-work claims, a bounded cross-channel turn queue, restart interruption recovery, known-rejection versus effect-unknown outbound receipts and the identical action owner as desktop Allow. The checked-in Demo contract remains network-off. Remaining: named-PM enrollment/privacy approval, live provider delivery QA, an agency-owned stable HTTPS tunnel, mobile attachments/voice, proactive mobile alerts and offline background service.
- [x] **T14 (P1, planner + offline broker source proof complete; adapters gated)** — Local-first work routing — Versioned RealBud-owned plan and You projection batch the complete property book, remember one closed non-authoritative PM preference, enforce one same-account browser lane, cap independent private browsers at two and visible CUA at one, keep cloud optional, fail back to local standard and expose timing only from measured runs. The digest-only fake broker and offline mixed-lane simulator prove lifecycle/recovery without contacting a worker, browser, desktop or cloud. No personal browser/profile or Hermes source is touched. Remaining R1 Desk reconciliation and R2–R6 adapters/evidence are tracked in `TODOS.md`; no parallel analysis, multi-browser or cloud execution is claimed by this checkbox.

Implementation order: `T1 → T2 contracts/decoder/migration → compatibility snapshot → T3/T4 → T5 → T6/T7/T8 → T9 → T10`. T3/T4 may proceed in parallel only after V3 contracts and projection DTOs settle; all browser work depends on the Case/ProposalRevision/HandoffAuthorization model.

## Review completion

| Dimension | Initial | Planned |
|---|---:|---:|
| Information architecture | 6 | 10 |
| Interaction-state coverage | 5 | 10 |
| Journey/emotional arc | 4 | 9 |
| AI-slop risk | 8 risk | 2 risk |
| Design-system alignment | 5 | 10 |
| Responsive/accessibility | 4 | 9 |
| Unresolved decisions | 8 unresolved | 0 unresolved |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | HOLD SCOPE baseline and hard topology retained |
| Eng Review | `/plan-eng-review` | Architecture & tests | 2 | CLEAR (PLAN) | V3 migration, evidence projection, history, ImportIssue and handoff boundaries resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN) | Seven passes resolved; Warm Ledger approved |
| Codex Review | `/codex review` | Independent second opinion | 1 | BLOCKED | Missing `/Users/yoda/.local/bin/codex-code-mode-host`; no findings fabricated |
| DX Review | `/plan-devex-review` | Developer experience | 0 | NOT APPLICABLE | PM desktop product |

**CODEX:** Blocked by missing local read-only bridge; internal eng review completed with file/line evidence and resolved 11 findings.

**VERDICT:** CEO + DESIGN + ENG CLEARED — full native PM concept and Desk V3 architecture approved. Implementation may start with T1, then T2 contracts/decoder/migration behind the compatibility snapshot.

## 2026-08-27 beta convergence review

The cross-cutting architecture, integration, PM-workflow, onboarding and release audit is now captured in `docs/BETA-CONVERGENCE-PLAN.md`. It supersedes any older implication in this plan that a fixture-complete feature is automatically beta-ready. The build order is C0 appliance/readiness → C1 durable intent/config recovery → C2 bounded Desk lifecycle → C3 typed PM workflows → C4 bounded executors → C5 onboarding/mobile/release proof. A later phase cannot advertise capability because its planner or fixture is green.

Resolved product decisions: four surfaces, one PM/one Bud, local-first with optional cloud acceleration, Ask agentic at intent and deterministic at effect, manual Allow for consequential objects, human Submit, and immutable external Hermes behind a RealBud-owned bridge. Open items are implementation and named-office proof gates, not permission to broaden those boundaries.

NO UNRESOLVED PRODUCT-BOUNDARY DECISIONS
