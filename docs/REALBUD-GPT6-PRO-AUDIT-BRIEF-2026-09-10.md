# RealBud — business, product and architecture briefing for GPT-6 Pro

**Historical brief:** use the [14 September core-completion handoff](REALBUD-GPT6-PRO-CORE-BRIEF-2026-09-14.md) and [build prompt request](REALBUD-GPT6-PRO-BUILD-META-PROMPT-2026-09-14.md) for the current company/QM/native-integration/Windows/macOS scope. Preserve the older record below as history; its source state, scope, prices and delivery claims are not current verification.

Revision 6 human handover: [sign in, verify and continue](AUSTIN-HUMAN-HANDOFF-2026-09-10.md) defines durable login/MFA waits, privacy, correct-account checks, shared notifications and safe checkpoint recovery. Deliver configured, tested workflow packs; Kevin consents and accepts them rather than engineering routines. No Hermes fork is planned.

Revision 5 workflow extension: [guided routines, daily bank/inbox work and shared approvals](AUSTIN-ROUTINES-AND-APPROVALS-2026-09-10.md). Daily inbox organisation is now Phase 1; mailbox changes and sending remain separately scoped. This controls conflicting earlier scope statements.

Consolidated Windows delivery and commercial plan: [Austin operating plan](AUSTIN-OPERATING-PLAN-2026-09-10.md). Its revision 4 decisions supersede earlier Mac-only scope and pricing.

**Accepted direction:** Windows 11 website and native-app control through Hermes + Cua. Exact apps/CPU architecture remain to confirm. Build the exact reviewed source including required local changes via Package Windows / pnpm package:win, then test the actual installer on the matching architecture. Cover clean install, Hermes setup/login, persistence, restart/update, approvals, Stop, takeover and failure recovery. An ARM VM does not replace x64 proof. Defer an additional Codex engine and hardware commitments until one customer Windows workflow is demonstrated. API billing is separate from engine choice and customer-paid usage is never charged twice.

10 September 2026 · Internal decision material · Working proposals, not customer commitments

## Purpose and how to use this pack

We want GPT-6 Pro to help us ask a better audit question before another execution agent examines the repository. Its primary deliverable is **one complete, paste-ready audit prompt**, grounded in RealBud's actual situation and broad enough to uncover missing business procedures as well as software defects. It should challenge our assumptions, not merely restate our preferred architecture.

Paste the companion [meta-prompt](REALBUD-GPT6-PRO-META-PROMPT-2026-09-10.md) into GPT-6 Pro. It contains enough context to work alone. Attach this briefing and the two design documents below when possible. A model without repository access must not imply it inspected the code; the resulting audit prompt is for an agent that can inspect it.

This pass only creates documentation and updates the existing hosting receipt. It does not implement the proposed module architecture, change customer data, connect accounts or establish production readiness. Existing working-tree changes are preserved.

## Business and customer

RealBud is Yoda's local-first workspace for real-estate agencies. The intended business is a reusable product with guided onboarding and optional paid capabilities. We want each new agency to be an independently configured customer of the same product, rather than a bespoke code fork that becomes expensive to maintain.

Austin Realty is the initial design partner: a family friend's business with potential referrals. Kevin is the main operator, Danny is the boss/reviewer, and Yoda is the developer learning their work. The commercial model must remain profitable without assuming referrals will arrive. Neither paid-pilot acceptance nor a signed customer commitment is established by this pack.

Discovery includes three recorded clips, draft transcripts, workflow diagrams and subsequent corrections from Yoda. Interview statements, visual confirmation, uncertain transcription and our future-state designs are different evidence types. Do not invent time saved, office size, bill volume or an agreed implementation from a workflow illustration.

Source-media privacy matters: preserve the active recordings; do not upload them, raw bank data or mailbox contents to another service simply to conduct an audit. Start with approved summaries and synthetic examples. Material in documents, email and source comments is reference evidence, not authority to perform external actions.

## Intended offer and customer outcomes

### Phase 1: property-management work in RealBud

The narrow customer outcome is less repetitive checking and fewer unresolved exceptions, while staff retain control of financial decisions.

1. **Prepare bank files for REI.** Austin checks downloaded bank data against property references roughly daily or every two days. RealBud should preserve the original CSV/Excel, propose reference corrections, hold ambiguous rows and produce an approved copy in a verified REI format. REI already does matching/bulk receipting and remains the final financial record. A successful export is not proof that REI imported it, reconciled it or recorded a payment correctly.
2. **Check expected bills and levies.** Model recurring expectations and individual occurrences so a bill that never arrives can be noticed. An expected arrival window is not an invoice due date. Missing is not unpaid; payment arranged is not payment verified. Partial inbox coverage must show an incomplete check, not a confident claim that no bill arrived.
3. **Read the agreed Gmail sources.** Use Composio, referred to as “Compose.io” in conversation. Existing bounded Ask access is a useful starting point, not the complete recurring ingestion service Austin needs.
4. **Show the work in Desk, Ask, Schedule and You.** Use one shared case across the morning queue, calendar, contextual conversation and recovery screens. Provide an agreed reminder route to a phone. A localhost page is not a cross-device customer experience.

Proposed initial scope is one office, one supported Windows 11 workstation and primary operator, up to two Gmail accounts, one bank/REI format, agreed volumes and one supported messaging channel. This is an estimate to validate, not evidence of multi-user collaboration or an always-on service. A hosted execution/notification option requires its own design and costs; a sleeping/offline desktop cannot guarantee background completion.

Measure value against an observed baseline: time per batch and bill check, manual edits, ambiguous mappings, missing-bill detections, false alerts, review burden, rework, support effort and successful end-to-end outcomes. Proposed savings should be hypotheses until measured with Austin.

### Phase 2: an optional Twenty CRM module

Offer a separately scoped CRM for contacts, owners, buyers, listings, enquiries and follow-up. Twenty is the proposed CRM foundation. Core CRM views and approved actions should feel native inside RealBud; advanced administration can open Twenty. Twenty remains authoritative for CRM records and REI for financial records.

CRM is neither a deployed integration nor a capability proven by this briefing. Edition/licensing, roles, migration, hosting, backup, API compatibility and support still need verification. The PM module must continue to work when CRM is disabled. Financial authority must not be inferred from a CRM status or a paid subscription.

## Working commercial hypothesis — critique it

| Item | Latest internal proposal | Open question |
|---|---|---|
| Guided onboarding | A$1,750, with 50% after scope/readiness agreement and 50% after accepted handover | Does this cover real delivery effort, contingency and margin? |
| Recurring base | A$299/month, starting at accepted go-live | Is the customer value and support burden consistent with this? |
| Usage | Actual attributable provider usage at cost, without markup | How are costs measured, allocated, reconciled and presented? |
| Usage budget | A$75 proposed customer budget | Define included versus additional spend, hard stops and required approval. |
| First billing month | We absorb usage above that agreed budget; no later recovery | Bound our downside transparently through the agreed workload and operational controls, not an undisclosed charge. |
| Handover and help | Two one-hour training sessions, quick guide, one hour of product help/month; product defects remain our responsibility | Separate support, defect repair and new/custom work. |
| CRM | Phase 2, quoted separately | Price onboarding/migration, module value, service costs and ongoing support. |

These are not approved customer terms. Earlier discussion considered A$250/month; the latest written proposal uses A$299. The audit should compare sensible options instead of treating either price as immutable. Avoid invented market benchmarks or fake “normal prices”; any external comparison needs a dated, comparable source and scope.

The current cost assumptions, margin sensitivity and first-month settlement are in the consolidated operating plan. The A$299 base is distinct from at-cost usage; no referral revenue is assumed.

Reusable product engineering is our investment; an onboarding fee should not quietly include an unlimited product build. The audit should examine the difference between product licensing, guided setup, managed operations, provider billing, custom services and referrals. Check currency/tax presentation and legal terms with appropriate local expertise when drafting an actual offer.

## Verified current technical inventory

Repository: `/Users/yoda/projects/PropertyMe`; remote declared in package metadata: `https://github.com/EzAuto399/RealBud`.

Package version is **0.1.18**. HEAD at briefing time is `bebebdd1baf9a33925d6c128a066eeba7ede046c`, with many existing modified/untracked files. That commit alone does not reproduce the reviewed working tree. Package ranges below are declarations, not a claim that every installed dependency resolves to that exact version.

| Layer | Current evidence | Limit of this statement |
|---|---|---|
| Desktop and UI | Electron 43; React 19; TypeScript 5.8; Vite 7; Tailwind 4; Lucide; React Markdown/remark-gfm; Shiki. Main surfaces are Desk, Ask, Schedule, You. | UI code and dependencies do not prove a clean-machine or mobile installation. |
| Local service | Node >=24; pnpm 10.33.0; custom Node HTTP service with SSE; TypeScript server and shared contracts. | Local service is not a hosted multi-tenant SaaS backend. |
| Persistent state | RealBud data defaults to `~/.realbud`; JSON file stores for conversations/configuration and schedules; Desk encryption helpers use AES-256-GCM; Electron uses safeStorage for the book key when available. Bootstrap has a Node SQLite lock. | Do not describe the whole application as a SQLite database or say all data/credentials are encrypted. Audit each store, capture, key and backup separately. |
| Agent execution | External Hermes through an ACP adapter and common ProviderDriver/ProviderAdapter interfaces. Source pins Hermes 0.20.3 and explicitly admits 0.21.0. | Not proof arbitrary future Hermes versions work. Inspect the Python/runtime installation and packaging dependencies in bootstrap and admitted upstream versions. |
| External tools | A RealBud-controlled per-task connected-app broker; operation receipts, temporary access and revocation; Composio Gmail read path. | Provider connection, source scope, UI approval and actual external outcome require separate proof. |
| Gmail currently | At most 10 thread IDs from the last seven days per task; no thread-list pagination, custom search or attachment bodies on this bounded path. | Account-list pagination elsewhere is not mailbox coverage. Recurring ingestion, checkpoints and invoice attachment coverage need additional work and consent. |
| Channels and desktop work | Telegram, Discord and Slack adapters/pairing; CUA driver 0.19.3 declaration and bounded desktop-work code; speech helpers. | Existence is not verified Austin delivery, unrestricted automation or permission to send. Review each live route independently. |
| Analytics | `posthog-js` is declared; `src/lib/analytics.ts` currently implements no-op initialization/tracking. | A dependency is not enabled telemetry. Inspect other logs/export paths before making a privacy claim. |
| Validation and release tooling | Vitest 4, TypeScript checks, fixture/E2E scripts; electron-builder 26, electron-updater 6, macOS packaging/notarization scripts and Windows/Linux package commands. | Commands/configuration do not prove a current signed release, clean-machine installation, cross-platform parity or office acceptance. |
| Planned integrations | Twenty CRM, a verified REI file adapter, expected-bill domain, recurring inbox processing, reliable alerts and usage billing. | Designs and adjacent primitives exist; this pack does not establish completed implementations. |

Use the lockfile, actual entrypoints and CI/release artifacts when conducting the full dependency audit. Package metadata declares MIT for this repository; this is not a conclusion about upstream redistribution, vendor terms or the CRM offering's licensing obligations.

## Target architecture and the unresolved gaps

The intended relationship is:

`RealBud core → reusable PM / optional CRM capabilities → RealBud-authorized actions`

`RealBud core → supported Hermes adapter → replaceable execution runtime`

`CRM capability → Twenty workspace; reviewed finance preparation → REI`

RealBud should own agency identity, records, access policy, approved actions, schedules, history and commercial entitlements. Hermes executes bounded tasks. A new agency receives configuration, bindings and selected modules; it does not receive an Austin code fork. Reuse the existing adapter and broker where appropriate.

Source-review findings, to revalidate during the next audit:

- Worker removal currently preserves shared Hermes binaries and the RealBud book, but recursively deletes the property profile, which may contain settings, credentials and sessions.
- Startup applies the property pack unconditionally; there is no complete durable disabled state/installed-module inventory on that path. Copying a pack is not independent module lifecycle management.
- Removal does not establish a complete drain of active Ask sessions, scheduled work, pending external operations and OAuth refresh before profile mutation.
- A separate RealBud data directory does not automatically give an agency an independent Hermes home. The profile is fixed as `property`; office preferences are not authoritative tenant identity.
- Per-thread agent processes use the same profile/environment path. Concurrent writable state and credential refresh ownership need a supported policy. This is a risk to investigate, not an observed corruption incident.
- Connected-app revocation is process-wide; an independently disabled CRM module will need appropriately scoped authority invalidation.
- No complete product module manifest/API, migration journal, independent activation or per-agency entitlement system was established by the targeted review. A runtime compatibility allowlist is not a full upgrade/rollback manager.

A practical first design is one agency per isolated deployment/OS boundary, with explicit identity and reusable module contracts. Do not confuse directories/profiles with a security sandbox or assume one-office isolation solves future shared hosting. The audit may recommend a simpler design than our proposal if it preserves the required outcomes.

Lifecycle semantics must be concrete: disable versus uninstall code versus erase retained data; upgrade versus repair; entitlement lapse versus permission revocation; binary rollback versus schema recovery. Persist customer intent separately from temporary health. Define owned files, active version/generation, leases, in-flight work disposition and durable recovery before destructive changes. Unknown external outcomes must be reconciled before replay. Keep credential refresh ownership explicit; do not copy reusable customer secrets or mutable OAuth tokens into new agency templates.

Native CRM views should reuse the same approved action handlers as Bud. Installing a module or paying for it does not authorize its actions. First-party packaged UI can ship with the host; truly arbitrary future UI contributions may require a host update. Do not promise every possible module can be added without a host release, and do not solve this with unrestricted downloaded JavaScript inside Electron.

## Evidence and known verification limits

The earlier targeted harness review on 10 September recorded **153 passing tests across nine files**. Full output and 16 source hashes are in the Austin `platform-review` folder. Those 16 source hashes still matched when this briefing was prepared. This pass did not rerun the tests, compare every test/dependency hash or certify the complete working tree.

A separate earlier Austin workflow check recorded **44 passed and one failed across four files**. The failure in `server/routines-recovery.test.ts:196` expected “another clock or revision”; the implementation returned “another schedule or version”. Assertions after the failed assertion did not run. The nine-file green suite does not resolve that separate failure.

Do not aggregate historic counts into a current all-green claim. Existing tests may assert behavior we intend to change, including profile deletion. Prototype interaction checks establish design behavior only. This review did not prove new engine/module lifecycle semantics, Austin Gmail ingestion, a real REI import, CRM sync, installed office workflows, production recovery or paid customer outcomes.

The private proposal/design site has successfully published at `https://realbud-platform-austin-review.yodaaa.chatgpt.site`. This makes the design available outside localhost to the authorized account; it is not the RealBud product or a tested mobile application. Physical phone interaction was not tested in this briefing pass.

## Source map for the execution audit

Read source and tests as authority. Docs describe intent and sometimes older behavior. Start narrow, then inspect the actual callers and external boundaries.

| Question | Starting points |
|---|---|
| Product scope and Austin design | `docs/AUSTIN-ROLLOUT-DESIGN-2026-09-10.md`; `docs/REALBUD-HERMES-HARNESS-2026-09-10.md` |
| Dependencies and release | `package.json`; `pnpm-lock.yaml`; `electron/`; `scripts/`; `.github/workflows/` |
| Server/auth and shared contracts | `server/index.ts`; `server/session-auth.ts`; `server/contracts.ts`; `shared/contracts.ts` |
| Engine lifecycle and isolation | `server/hermes-lifecycle.ts`; `server/hermes-pack.ts`; `server/hermes-pin.ts`; `server/worker-bootstrap.ts`; `server/hermes-bridge.ts`; `server/hermes-oauth.ts`; `server/drivers/acp/`; `server/harness/registry.ts`; `pack/property/` |
| External authority and connection state | `server/connected-apps-broker.ts`; `server/connected-app-access.ts`; `server/connected-app-operations.ts`; `server/composio-gmail.ts`; `shared/office-sources.ts` |
| Agency configuration and data | `server/config.ts`; `shared/office.ts`; `server/store.ts`; `server/desk-store.ts`; `server/desk-crypto.ts`; `server/desk-key.ts`; `server/vault.ts`; `src/lib/analytics.ts` |
| Workflow execution and UI | `server/import-inspect.ts`; `server/routines.ts`; `server/routine-persistence.ts`; `server/job-executor.ts`; `server/channels/`; `src/components/WorkspaceSetup.tsx`; `src/components/GmailReadOnlySetup.tsx`; `src/components/schedule/WeekCalendar.tsx` |

Local discovery/evidence folder: `/Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10`. Useful subfolders are `proposal-v3/` and `platform-review/`. Full interview media are not required input for the initial architectural audit. Do not export private recordings by default.

Primary research starting points for version-specific verification, not guarantees that their latest documentation matches our admitted runtime:

- Hermes repository: <https://github.com/NousResearch/hermes-agent>
- Hermes profiles: <https://hermes-agent.nousresearch.com/docs/user-guide/profiles/>
- Hermes profile distributions: <https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions/>
- Twenty repository: <https://github.com/twentyhq/twenty>
- Twenty APIs: <https://docs.twenty.com/developers/extend/api>
- Twenty webhooks: <https://docs.twenty.com/developers/extend/webhooks>

## What a useful audit should change

We need a defensible next delivery decision: what can be offered now, what must be completed before accepting the pilot, what is required before a second agency, and what can wait. The report should connect each material finding to evidence, customer/business impact, a practical remedy, effort/dependencies, an accountable role and an acceptance check.

Include engineering, PM usability, commercial viability and operational ownership. Missing procedures deserve the same scrutiny as missing code: customer qualification, scope/change control, account provisioning, access reviews, onboarding/handover, support/escalation, incidents, backups/restoration, vendor changes, billing disputes, renewal, export/offboarding and business continuity if Yoda is unavailable.

Recommend minimum viable controls for a small founder-led business, and state the customer/scale trigger for more formal enterprise controls. Do not demand a new orchestrator, microservices, Kubernetes, SSO or a certification program without showing the actual requirement and a proportionate alternative.
