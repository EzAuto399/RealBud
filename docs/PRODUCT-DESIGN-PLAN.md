# RealBud Native PM Product Design Plan

Date: 2026-08-24 (status refreshed 2026-08-29)  
Status: V3 + native Desk shipped on main (`750f7ae`). Remaining pickup is `docs/NEXT-WAVE.md`. T1–T13 boxes below are historical; do not rebuild them.  
Canonical constraints: `docs/GOAL-PROMPT.md` wins conflicts  
Approved concept: Warm Operational Ledger (`~/.gstack/projects/EzAuto399-PropertyMe/designs/realbud-pm-case-spine-20260824/`)

## Outcome

RealBud becomes a native, vertical property-management desktop app rather than an upstream agent shell with PM labels.

The product spine is:

```text
portfolio queue → property / tenancy / case → evidence → human decision → bounded handoff
```

Desk, Ask, Schedule and You remain the only navigation places. One PM uses one Bud. No Send, Pay, statutory drafting, bot roster, general computer playground or Hermes Desktop surface is introduced.

## Approved decisions

1. All three design spines ship as one system: PM case/evidence Desk, PM-native Ask and source-to-handoff trust journey.
2. Visual direction: **Warm Operational Ledger**.
3. Browser presentation supports all three per-session modes; default is side-by-side. Idle space is evidence/context, not arbitrary browsing.
4. Handoff completion is verified by read-back when possible, otherwise human-confirmed; unknown remains unknown.
5. Ask is PM-first with technical activity under Advanced diagnostics.
6. Layout is adaptive desktop split view; Pocket remains a later channel.
7. Full PM object/data migration is part of this implementation, not deferred.
8. V3 first cut includes the full model breadth: historic tenancies, owner/tradie contacts, maintenance intake and all browser presentations.
9. Migration is one atomic V3 cutover behind an in-memory V2 compatibility snapshot; there is no dual-write authority.
10. Evaluation reads an immutable-evidence-backed current projection, never history or Notes.
11. Unmatched/ambiguous source rows become `ImportIssue` records, not fake Properties or unresolved Cases.
12. Proposal edits append immutable revisions; Decisions reference one exact revision.
13. Portal binding, immutable recipe, one-use authorization and Handoff remain distinct security objects.
14. Properties archive; tenancies close; Decisions, Evidence and Handoffs are never cascade-deleted.
15. Routine outputs link by `runId`; `loops.json` remains the run store and is not duplicated into Desk.

## What already exists

- Four-place navigation and Desk-first startup.
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
- Mobile-responsive desktop UI; Pocket is a later dedicated channel.
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

Evaluators receive a DTO containing Property, current Tenancy, applicable policy and one MoneyPosition. They never scan history and never receive Notes. Owner-update proposal enrichment may read one property Note after factual evaluation, treating it as untrusted editable wording and recording only note path/hash provenance.

### Proposal, decision and lifecycle rules

- At most one current Tenancy per active Property; historic tenancies are retained.
- Proposal edits append ProposalRevision; they do not overwrite prior wording.
- Allow/Deny/Copy/Done are Decisions that reference one exact ProposalRevision.
- Edit is a revision event, not authorization.
- Unknown migrated actors remain `legacy-unknown`.
- Property deletion becomes archive. Archived properties leave routine/source matching by default but retain tenancies, Cases, Evidence, Decisions, Handoffs and Notes.
- Closing a tenancy preserves its records and creates no replacement until real data exists.

### Routine output linkage

LoopRun remains in `loops.json`. The executor passes `runId` and `loopId` into Desk; created/updated Cases and Proposals store `origin: { kind: "routine", runId, loopId }`. Schedule derives outputs by indexed lookup. No cross-file dual-write of the run object is introduced.

### Calendar, retention and scale

- Agency timezone controls shop-calendar calculations. Source dates remain calendar dates where available. Migration does not infer a lease due rule from `daysSinceDue`.
- Retention never removes Evidence referenced by open Cases, Decisions or Handoffs.
- Full evidence/decision timelines are paginated; queue snapshots exclude Notes and history bodies.
- Build in-memory maps by primary/foreign key and indexes for normalized address/property code.
- Evaluation remains O(current tenancies), not O(evidence history).
- Benchmark 200 active properties and 18k–36k Evidence rows before choosing SQLite or a journal. Keep the queue snapshot under 2 MB.

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

- **Wave 1 — the interrupt layer.** Build `inbound-triage`: read-only mail integration (IMAP or Graph OAuth; SMS webhook later) → classify into property/tenancy/case → reply drafts on Desk. Add maintenance job detail to Cases (issue, tradie, quote status, access window) and the `maintenance-followup` reminder shape. This is the week-destroyer the PMS assistants never touch.
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
- One decision bar: Allow wording, Edit, Deny, Copy; context-specific bounded preparation after approval.
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

- Always shows current scope: portfolio, property, tenancy or case.
- Empty Ask offers PM starters: “What needs me?”, “Explain this hold”, “Draft an owner update”, “What changed since yesterday?”
- Responses cite evidence and observed time.
- Proposed external wording or case changes land on Desk for one approval.
- Default surface removes reactions, branching, regeneration, bot settings, agent mentions and raw tool/code activity.
- Advanced diagnostics discloses technical traces/provider health only; no extra capability appears there.

### Schedule

- Named loops only.
- Each run shows its actual date/time and links to cases/proposals produced.
- Failure/missed/interrupted rows expose a recovery action.
- Planned loops can show their intended schedule but cannot run/enable.
- Successful schedule changes announce confirmation and revision conflict recovery in PM language.

### You

- Agency name, PM profile, timezone and jurisdictions.
- Source readiness, freshness and last import.
- Recovery reason, quarantined item count and guided next action.
- Browser profile status and retention policy in plain language.
- Advanced diagnostics contains Hermes version/profile/pack/model details.

### You

- Agency name, PM profile, timezone and jurisdictions.
- Source readiness, freshness and last import.
- Recovery reason, quarantined item count and guided next action.
- Browser profile status and retention policy in plain language.
- Advanced diagnostics contains Hermes version/profile/pack/model details.

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

Principles: the product works before setup exists; setup is one progressive checklist, never a wizard modal; smart defaults everywhere; permissions are requested at the moment of use.

### Journey states

1. **Appliance (first launch):** Desk opens on the demo book immediately. One dismissible card states the three rules (draft only / no notices no trust / no invented legal clock). A **Go-live checklist** card shows three rows with done/ready/action states.
2. **Go live:**
   - *Connect your export:* drop a CSV anywhere on Desk or use Book → Import. Columns auto-map from known aliases; preview reports matched/unmatched before commit; unmatched rows land in Import issues. One user action.
   - *Attach your worker:* auto-detect the pinned Hermes install and provider auth. Ready = green with zero steps. Missing = one-click installer, then Apply pack, then guided model attach. Test hands is the only verification the PM sees.
   - *Name your agency:* optional. Timezone defaults from the system, jurisdiction is inferred from matched addresses and editable, currency AUD, courtesy windows default to shop norms.
3. **Live:** the checklist disappears when all three are green. Demo → Live chip flips. Morning and Friday loops are already armed — no activation step exists. Three coach marks maximum, ever: Recheck, Allow→Copy, Schedule exists.

### Smart defaults and detection

- Existing `~/.hermes` install at the pinned version skips install entirely.
- Provider auth already on the machine is detected before asking for a model.
- Jurisdiction inferred from matched address suffixes; timezone from the system; cadence weekly.
- Demo data stays available for practice ("Replay sample morning") after going live.
- The macOS Accessibility/TCC prompt is deferred to the first "Prepare portal" action, preceded by a plain-language explanation of what Bud will do in the visible session.

### Step budget

Download → live book: **2 user actions** with Hermes present (drop CSV, confirm attach), **3** without (installer). No step requires a terminal on a normal office machine.

### Partner walkthrough (doubles as the 90-second demo script)

Open on demo Desk → Recheck → open the Oak case → Allow wording → Copy → drop a real CSV → chip flips Live → Schedule already armed. No clicks outside the four places.

## State coverage

| Surface | Required states |
|---|---|
| Desk | loading, empty, ready, partial, held, recovery, stale, mutation conflict, success |
| Queue | no cases, filtered empty, loading, stale source, selected, keyboard focus |
| Case | proposed, approved, denied, superseded, cancelled, failed, effect unknown, complete |
| Import | selecting, preview, mapping, invalid rows, ambiguous rows, partial accept, complete |
| Ask | connecting, empty scoped, streaming, approval waiting, failed, retriable, advanced |
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

Rows (top to bottom): Engine (version · pinned / pin mismatch) · Property pack (installed · approvals manual) · Model (model · provider · masked key hint, e.g. `XAI_API_KEY sk-a…9f2`) · Last hands test (answered/failed · time).

Actions: Install/Update worker (in-app, streamed; hidden when pinned+matching) · Apply property pack · Attach/Change model · Test hands · Check again.

Attach sheet fields: Provider (curated five) · API key (**optional when the same provider already has a credential** — hint shows the masked current key; required when switching providers) · Model (suggestions from the worker's own cache via `/api/hermes/models?provider=…`, free-text fallback) · Base URL behind an advanced toggle (empty = provider default). Save & test runs a real ping and records the result + timestamp.

Locked (shown read-only inside Advanced diagnostics, managed by RealBud, never editable): `approvals: manual` · `cron: deny` · the three SOUL rules. Connectivity truth lives in the status detail + Last hands test row; source freshness lives in the Sources card.

## Ask as actor (action proposals)

Ask is not only conversation: Bud proposes actions on the system, the PM allows them. The proposal union is closed — anything outside it is refused by the skill and by the API.

| Proposal | Card shows | Allow runs |
|---|---|---|
| `run-loop` | loop name + what the run produces | loop runNow |
| `retune-clock` | old → new time/weekdays | clock PATCH (revision + no-backfill rules) |
| `add-property` / `edit-property` | full field diff | Book command |
| `draft-owner-update` | proposed wording | existing proposeFromAsk |

Rules: proposals carry `origin {kind:"ask"}`; Allow is the only execute path and is recorded as a Decision; the `desk-actions` pack skill returns structured JSON in a closed union (no free-form commands, no tool calls); send/trust/statutory/browser-launch are unreachable from proposals; chat text can never mutate the clock or book directly.

## Worker bridge control plane (Hands 2.0)

You owns the bridge end-to-end so a non-technical graduate never opens a terminal:

- **Attach model in-app**: provider picker (OpenAI/Anthropic/xAI/OpenRouter/Ollama), key entry written to the Hermes profile auth only, model select, one-click Test hands.
- **Worker update on pin bump**: You shows "Worker update available (app expects v0.20.x)" with a single Update button that runs the pinned installer, then re-runs the hands test. Never automatic, never tracks main, profile auth survives.
- **Health surface (read-only)**: pin/pack/approvals/model status, last Hermes call result, log location.

Keys live only in the profile auth files. They never enter desk.json, snapshots, or logs.

## Known V3 perf bottleneck

`addProperty` runs the full encrypted commit protocol per call (~38ms: serialize + encrypt + fsync + backup rotation), so bulk adds (194-property onboarding, CSV-backed imports) are linear-slow. The 200-property test now carries a 30s budget and a tracked fix: **batch persists for bulk operations** (single commit at the end of a bulk add/import transaction) before the pilot office loads a real book. Snapshot read path is unaffected (58ms / 182KB at 200 properties). Tracked under T2 follow-up.

## Blind-spot register (2026-08-25 sweep)

Systematic "fresh graduate machine" + data-safety hunt. Fixed immediately: Hermes probes now use the augmented login PATH (Finder-launched apps previously could not find the worker that Ask could — Desk held while the worker was installed); recovery/migration no longer hardcodes Australia/Sydney; Electron takes the single-instance lock (a second launch now focuses the window instead of silently forking a second harness over one book).

Mapped to work:

| # | Sev | Blind spot | Lands in |
|---|---|---|---|
| 1 | P1 | Windows build ships but the pinned worker cannot be installed from the app (`installCommand` null on win32) | T11 — bundle worker or explicit "CSV-only on Windows" copy before NSIS ships |
| 2 | P1 | Three-rules onboarding implemented but mounted nowhere — first launch skips the safety framing | T3 onboarding checklist card (mount + first-run flag) |
| 3 | P1 | `desk.key` loss = permanent lockout: silent key replacement quarantines the book into unrecoverable recovery; no escrow, no unlock flow | **T13 (new, P1): key escrow phrase at first run + in-app unlock-quarantined-book flow** |
| 4 | P2 | Failure/stale signals are passive-only: missed runs and held sources surface only if the PM opens the app; zero OS notifications; You sources lack last-checked times | **T14 (new, P2): OS notification on failed/held runs + last-checked timestamps on You sources** |
| 5 | P2 | `retentionDays` enforced nowhere; evidence append-only and `purged-*` backups never deleted — disk growth + privacy posture gap | **T15 (new, P2): retention sweep honoring open-case references** |
| 6 | P2 | safeStorage is a comment: `desk.key` sits plaintext next to the book; provider keys plaintext in config.json | **T16 (new, P2, pre-package): wrap desk.key with safeStorage; encrypt config secrets** |
| 7 | P2 | "Allow" can report success when Terminal never opened (spawn ≠ osascript success); TCC denial invisible | T11 — capture exit/stderr, clipboard fallback made loud |
| 8 | P2 | Packaging trust gates: notarize off, arm64-only mac, unsigned Windows — install #1 fails for exactly the target audience | **T17 (new, gated on release): CI notarize+staple, x64 mac artifact, signed Windows** |
| 9 | P2 | Installer is `curl \| bash` with no preflight and no result verification | T11 — preflight deps in-app, verify `hermes --version` matches pin before declaring success |

Checked and fine: port-collision fallback chain, Ask retry/failure UX, demo seeding, atomic write durability, analytics fully off, loop bookkeeping caps, Windows CLI shim resolution (the gap is only that Hermes paths bypass it — fixed above).



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

- [x] **T1** — Design system (Warm Ledger tokens/primitives). Residual: leftover OpenMausBot chrome still in tree, hidden by product mode.
- [x] **T2** — Desk V3 contracts, decoders, migration, compatibility snapshot. Follow-up: batch persist (`docs/NEXT-WAVE.md` W3).
- [x] **T3** — Queue/case/evidence split + Book mode + CSV drop. **Not done:** PropertyGroup grouping, Cmd+K, go-live checklist (`NEXT-WAVE` W1).
- [x] **T4** — Demo-breadth cases render (maintenance/lease/inspection/inbound as held fixtures). Full historic tenancy/contact editing is not a next-wave item.
- [x] **T5** — Fake-portal handoff, human Submit, effect-unknown. Live vendor portal waits on the pilot contract.
- [x] **T6** — Product Ask (no reactions/models/computer in the default thread).
- [x] **T7** — Schedule clock GUI + run history. Run-to-case index is good enough; do not rebuild Schedule.
- [x] **T8** — You: agency, sources, recovery, worker card, Advanced diagnostics. **Not done:** go-live mirror, last-checked times (`NEXT-WAVE` W1, W5).
- [x] **T9** — Arrow-key queue, live-region confirmations, split-view drawers. Residual a11y is not a new project.
- [x] **T10** — `scripts/e2e-walkthrough.mjs` 26 checks green at HEAD.
- [x] **T11** — In-app worker install, model attach, Test hands. **Not done:** user chrome still says Hermes (`NEXT-WAVE` W2); Windows install stays CSV-only.
- [~] **T12** — Intake + "Put courtesy on Desk" shipped. Closed Ask-as-actor catalog (`run-loop`, `retune-clock`) is ROUTINES PR C and stays deferred. Do not "finish T12" by building PR C.

Historical implementation order is done. Next sessions pick `docs/NEXT-WAVE.md` W1 then W2. Do not start T1 again.

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

NO UNRESOLVED DECISIONS
