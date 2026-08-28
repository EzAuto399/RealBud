# RealBud beta convergence plan

Date: 2026-08-27  
Authority: `docs/GOAL-PROMPT.md` wins if this plan ever conflicts with it.  
Purpose: one dependency-ordered build and proof plan for a real PM pilot. This is not a feature wish list and a green fixture is not a live-capability claim.

## Outcome

RealBud is ready for a named-office beta only when a PM can give Bud an outcome in Ask or Schedule, leave routine checking to RealBud, and return to a small truthful Desk queue. Every admitted item must survive restart, show who or what it is waiting on, and end in a durable result. RealBud may read, match, classify, diagnose and draft without waiting; the exact consequential wording or bounded handoff still needs one human Allow. It never sends, pays, allocates trust, drafts statutory material or invents a legal clock.

The product path is:

```text
PM intent / named routine / admitted source event
  -> durable request and idempotency receipt
  -> typed route and bounded collector
  -> immutable source observation with coverage and freshness
  -> deterministic evaluation and case lifecycle
  -> Desk exception or draft
  -> PM Allow / Deny / Not now
  -> Copy or case-scoped prefill
  -> licensed human Submit in the PMS
  -> completion, rejected, cancelled or effect-unknown receipt
```

The worker can help interpret intent and prepare bounded output. It does not own admission, identity, scheduling, credentials, source truth, approvals, browser policy, retries, persistence or completion claims. Hermes remains an immutable external dependency behind RealBud's adapter; this repository never edits or vendors Hermes source.

## Repeating gap patterns

These patterns explain most of the current defects and are the review checklist for every new workflow.

1. **Projection mistaken for capability.** A planner, fixture, historical success or configured credential is shown as connected/ready without a fresh runtime receipt.
2. **Optimistic UI without durable admission.** Text, settings or a run disappears from the UI before the authoritative owner confirms it, leaving retries and restart ambiguous.
3. **Missing state mistaken for first run.** Corrupt or unreadable config, routine or transcript storage is treated as empty state and can make setup appear lost.
4. **A card without a lifecycle.** Work is drafted but has no due time, waiting owner, retry rule, closure receipt or safe `effect-unknown` terminal state.
5. **A generic tool where a typed adapter is required.** Raw CLI, browser, CUA, MCP or worker access bypasses case, origin, identity, expiry and result decoding.
6. **Historical observation mistaken for current coverage.** One successful import or bank read is reused after staleness, partial pagination, a zero-result window or connector revocation.
7. **Model prose mistaken for authority.** The worker can introduce legal, recipient, schedule, connection or completion claims not revalidated at the code-owned boundary.
8. **Test escape hatch reaching product mode.** Development fleet flags, personal executables, personal profiles, loopback origins or broad permissions survive into a packaged launch.
9. **Per-property work where a batch or incident is needed.** One source outage becomes 100 cards; one import becomes 100 commits; one page loop makes the model reason from scratch on every row.
10. **Source wiring without installed proof.** Source tests omit Keychain/TCC, process death, sleep, update, uninstall, architecture, notarization, real auth/MFA and provider revocation.

## Authority boundaries

| Boundary | Authoritative owner | Required invariant |
|---|---|---|
| PM intent | RealBud server | Validated size, exact PM/session, request id, durable admission before acknowledgement |
| Worker | RealBud worker bridge | One pinned private Bud runtime/profile; exact pack; no personal Hermes, terminal, cron, memory or channels |
| Source read | Typed adapter | Exact account/origin/scope/window; freshness and complete/incomplete coverage; redacted receipt |
| Evaluation | Deterministic RealBud code | Evidence only; Notes cannot change money/legal evaluation; no absence-as-nonpayment |
| Schedule | RealBud routine owner | Named catalog item, occurrence dedupe, no overlap, no browser/CUA from the clock |
| Approval | Desk command owner | Exact revision and consequential object; manual Allow only; no learned authority |
| Browser/CUA | Electron + work broker | Admitted case, exact recipe/origin/tools/profile/expiry, one-use policy, one visible lane, PM Submit |
| Mobile | Pocket hub | Same named PM and Ask thread, ownership proof, generation/revocation, durable delivery ambiguity |
| Completion | Work receipt owner | Read-back or human attestation; otherwise `effect-unknown`, never automatic replay |

## Dependency-ordered build

### C0 — appliance boundary and truthful readiness

Status: source changes in progress; installed proof remains open.

- Force packaged product mode even when a parent shell carries test-fleet variables.
- Canonicalise persisted fleet state to one Bud and stop generic provider credentials entering its environment.
- Verify the exact safety pack, skill tree, manual approvals, denied cron and disabled toolsets; repair stale owned files without touching personal Hermes.
- Revalidate operational wording on edit, Allow and portal preparation so corrupt/legacy/model-authored text cannot cross into statutory or legal-clock territory.
- Derive PMS/bank state from current observation, freshness and coverage; label demo data practice-only.
- Treat a bounded CUA descriptor as ready only while current; support explicit turn-off, policy removal and shared UI refresh after enable, expiry, focus return or revocation.
- Remaining proof: immutable clean candidate, real signed-app Keychain/TCC, restart/sleep/revoke, x64/arm64, notarization/stapling and personal-Hermes/personal-browser byte sentinels.

### C1 — durable intent, configuration and recovery

Status: source implementation and restart/corruption tests are green. Installed-app crash, storage and OS evidence remains a later proof bucket and is not implied.

- Ask sends carry a persisted request id/digest and explicit `admitted`, `dispatching`, `settled` or `held` state; the composer outbox stays until acknowledgement, retries dedupe, changed-content reuse conflicts and restart resumes only a safe text leaf. Selected-file and partial work holds without scanning or replay.
- Public configuration and encrypted settings use a ciphertext-only transaction journal. Legacy plaintext migration never enters that journal or a previous public generation. Model selection is separately staged and rolls back to the exact prior model/credential unless a live ping commits it.
- Config, encrypted settings, routine and transcript files distinguish absent, corrupt, unreadable and incompatible state. A verified previous generation restores automatically; otherwise original bytes are preserved, affected mutations pause and one exact recovery owner is visible.
- Startup reconciliation, event reconnect and embedded-server waits are bounded. A crashed source server gets one owned recovery attempt; durable Ask/local state rehydrates without an endless spinner or PM-authored retry dependency.
- Diagnostics remain sanitized to ids, state, reason code, generation and timestamps; credentials, prompts, source bodies, raw bank references and host paths stay out.

Exit: source-green on 2026-08-28. Restart, retry, changed-digest, model rollback, config half-commit, corrupt current/previous, transcript hold and routine fail-closed tests prove no lost Ask intent, duplicated replay, reset settings or silent schedule re-enable. Installed evidence remains in C5 and `docs/RELEASE-EVIDENCE-CHECKLIST.md`.

### C2 — bounded Desk and portfolio lifecycle

Status: source implementation complete on 2026-08-28; a named PM's installed 50–200 property usability run remains release evidence.

- Make the bounded queue/detail projection the default Desk API. Notes and full history load only for the selected case and never enter evaluation.
- Add portfolio search, property code, filters, groups, paging or virtualization, keyboard navigation and stable selection for 20/100/200 properties.
- Add explicit import identity resolution: link, reject, remap and retry ambiguous/unmatched rows with a durable decision receipt.
- Collapse a source-wide outage into one source incident plus affected count; do not create one indistinguishable hold per property.
- Give Waiting work a due time, waiting party, next check, overdue sort, reminder suppression, cancellation and closure receipt.
- Show only three PM-facing states: Bud is handling it, Needs you and Waiting on someone. Keep raw worker/tool states in Advanced diagnostics.
- Add load-off metrics from receipts: records checked, systems avoided, drafts prepared, exceptions held, follow-ups recovered and elapsed time. Never report tool calls as value.

Exit: a 200-property snapshot remains bounded and responsive; every accepted input is visible exactly once and every case can be explained and closed.

Source exit evidence: the default queue projection omits Notes, contacts, tenancy history and terminal work; selected case/property detail is fetched separately. The Book search covers address, property code, tenant and phone with 24-row paging; Desk keyboard navigation keeps the selected case stable. Import link/reject decisions, source-wide incidents, Waiting/next-check/snooze/cancel/closure receipts and their restart/idempotency boundaries have focused tests. A 200-property queue stays below 750 KB in the source test, and the API walkthrough exercises bounded first paint, import rejection and Allow → Waiting → closure. Systems avoided and elapsed time remain `null` until runtime receipts measure them.

### C3 — typed PM workflow coverage

Status: fixture foundations exist; named adapters and full lifecycles are open.

1. **Morning money:** fresh complete PMS export plus read-only bank credits; pagination/window completeness; exact property-code and amount matching; one source incident on auth/outage; zero-result receipt; never transfer/payee/payment/allocation/reconciliation.
2. **Inbox and maintenance:** read-only incremental mail cursor; attachment quarantine/decoding; deterministic emergency/maintenance/payment/owner/BDM classification; exact property match; tradie quote/appointment/waiting lifecycle; reply drafts only.
3. **Owner updates:** owner identity, portfolio grouping, cadence, material facts, maintenance and money summaries; one reviewable batch with per-recipient drafts and no note-as-fact leakage.
4. **Tenancy dates, inspections and compliance preparation:** only fields supplied and accepted by the named PMS/pilot; reminders and checklists, not legal conclusions, statutory notices or invented deadlines.
5. **Calendar:** named RealBud routines and accepted follow-ups project to the PM's chosen calendar only after a typed connector contract; external calendar state never becomes the schedule authority.
6. **BDM/admin interrupts:** enquiry classification, information gathering, draft follow-up and Waiting lifecycle; no generic autonomous outreach.

Each workflow ships in shadow mode first and needs: adapter contract, fixtures, failure matrix, deterministic evaluator, Desk projection, manual decision, recovery/closure receipt, installed proof and named-PM comparison.

### C4 — bounded execution lanes

Status: route planner, durable broker and fixtures exist; product executors remain partial.

- The governed extension foundation is now source-built: code-owned manifests cover direct API, restricted Composio, approved MCP, isolated tasks, private browsers, bounded CUA, optional cloud and stable History. A manifest is never readiness; only a fresh exact version/configuration attestation can enable a route, and the Advanced You projection keeps foundation, ready, stale, revoked and runtime-unavailable distinct. Actual provider adapters/runners remain open.
- Persist recoverable broker result metadata, not only a digest; add lease heartbeat, fencing and explicit owner liveness.
- Route every portal path through the broker/Electron owner; no direct Desk runner bypass.
- Bundle a RealBud-owned Chromium runtime and isolated encrypted profiles. One same-account lane by default; at most two independent lanes after resource and simultaneous-session proof.
- Connect an admitted work receipt to the existing native bounded CUA start/end owner. The model never constructs the manifest or receives raw CUA MCP tools.
- Add cancellation, sleep/lid change, PM takeover, auth/MFA wait, redirect/frame/layout drift, rate limit, read-back and unknown-effect recovery.
- Keep cloud optional and behind identical receipts, spend limits, region/retention policy and complete local fallback.
- Keep the Computer History runtime gated until a stable pinned API and a named recovery problem exist. Its admission/status contract is built now; a future adapter may store only opt-in, encrypted, case/time-bounded metadata receipts.

Exit: one named read-only portal workflow completes from case admission to receipt on an installed build, with Submit human-only and no personal browser/CUA state touched.

### C5 — onboarding, mobile and release proof

Status: source UX exists and the 2026-08-28 isolated browser pass completed first-run profile setup, reload persistence and support export at 900×600. Real enrollment and distribution proof are open.

- First Desk shows essentials and precise follow-ons without requesting permission on view. Ask redirects to the exact You owner when Worker/model/source/CUA/Pocket is unavailable and returns to the originating task.
- First-run and You profile edits share one exact-field, session-gated endpoint; invalid/unknown fields and foreign or unauthenticated calls fail closed, and UI save failures remain visible.
- Prove funded model persistence across restart/update, rotated key entry, selected-image intake and deterministic model-unavailable fallback.
- Prove Pocket ownership for the named PM, exact business/bot identity, disable/re-enable, credential rotation, stale buttons, restart and delivery ambiguity. No tenant/group/general Hermes channel.
- Add sanitized support export, version/build/proof labels and a release-evidence screen under Advanced diagnostics. **Source-built:** the downloaded v1 report contains only build labels, categorical health, recovery states and aggregate counts; adversarial tests prove it omits people, properties, messages, Notes, credentials, account identity, raw source material and host paths. It explicitly says source, installed and named-office proof are separate.
- Test loading, empty, partial, error and recovery states; 900x600 and common large windows; keyboard/focus/reduced motion/contrast; offline launch and long content.
- Produce clean immutable artifacts and complete install/update/rollback/uninstall evidence separately for each supported OS/architecture.

Exit: a non-technical PM can install, understand Demo versus live, attach a model once, import the book, configure one routine, recover a failed source, use the same Ask from one approved mobile channel and complete the pilot workflows without Terminal.

## Named-office inputs that code cannot invent

These are external dependencies, not engineering shortcuts:

- agency, PM, jurisdiction and licensed escalation owner;
- exact PMS/export dialect and authoritative property identifier;
- mailbox/provider/account, folders, retention and attachment policy;
- bank and read-only test account, statement window, MFA/session behavior and explicit prohibited paths;
- vendor/portal origin, test account, target workflow, selectors, read-back and Submit owner;
- approved mobile provider, agency-owned identity/number/bot and privacy decision;
- calendar provider and accepted event fields;
- device/OS/architecture, data retention, support owner and rollback window.

Until these are filled in `docs/PILOT-CONTRACT.md`, RealBud may show practice, unavailable or pilot-gated states only. It must not show Connected, Ready or Available now for a fixture or remembered success.

## Beta evidence matrix

| Evidence level | What it proves | What it does not prove |
|---|---|---|
| Fixture/source proved | Contract, validation, state machine and deterministic local tests | Real account, installed permission, provider drift or user value |
| Installed proved | Exact artifact, private runtime, OS storage/permission and restart behavior on one machine | Named-office semantics or production account support |
| Pilot-gated | Code path exists but required agency/account fields are absent | Connection or availability |
| Named-office proved | Exact named account/workflow passed shadow comparison and failure/recovery tests | Every provider, portal, bank or jurisdiction |

“Only testing remains” is true only when C0–C5 source work is complete, all required named-office fields are filled, the exact release candidate is immutable, and the only unchecked cells are installed/named-office executions against those supplied accounts. Until then, the remaining item must be named as source work, external input or release proof.
