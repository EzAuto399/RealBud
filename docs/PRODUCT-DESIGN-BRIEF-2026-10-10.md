# RealBud: reusable shell and client workflow packs

Date: 10 October 2026, Australia/Brisbane.

Status: proposed project brief and design contract. This document specifies the target; it does not make the proposed capabilities operational. It preserves the existing application and upstream Hermes runtime.

## 1. Paste into the project fields

### Goal

```text
Build RealBud as a reusable, professionally designed real estate work platform powered by Bud and an unmodified Hermes runtime. Deliver a coherent, accessible GUI whose task flows, information architecture, layouts and interactions adapt through versioned client workflow packs and scoped department workspaces. Preserve existing working behaviour while reducing manual effort, making approvals clear and completing workflows reliably. Qualify relevant Hermes capabilities through real workflow outcomes, with clear evidence and recovery.
```

### Context

```text
RealBud is the reusable product foundation. Client workflow packs supply specialised real estate operations. Preserve the existing visual language, navigation, data, working flows and safety controls while extending them incrementally.

1. Design the work before the screens.
For each workflow, map its intended outcome, actors, triggers, source accounts, inputs, decisions, states, handoffs, outputs and completion evidence. Specify permitted automation, human review, exception handling, cancellation and recovery. Build the interface around users' next useful actions and responsibilities. Departments define scope and ownership; navigation should make the daily work easy to find.

2. Separate the stable shell from configurable packs.
RealBud owns identity, tenant and member boundaries, authoritative records, navigation, permissions, approvals, scheduling, execution control and recovery. Packs configure supported workflow definitions, terminology, fields, mappings, department defaults, source requirements and view presets. Compose views from a maintained registry of approved components and layouts. Distributable packs contain no credentials or client records and grant no authority. Keep private installation bindings and role-limited personal preferences separate. Preserve old pack formats and use preview, validation, migration and rollback for changes.

3. Engineer a professional interaction system.
Use task analysis, clear information hierarchy, consistent terminology, progressive disclosure and established responsive layouts. Reuse current tokens and components. Choose layouts from the task: queues for triage, tables for comparison, list-detail views for ongoing work, evidence review for decisions, forms for structured input and calendars for time-based work. Preserve selection and drafts when layouts adapt. Keep primary actions clear, chat with Bud discoverable, and approvals and exceptions reachable. Define loading, empty, validation, permission, partial-result, error and recovery states alongside the happy path. Target WCAG 2.2 AA with actual keyboard, focus, screen-reader, contrast, zoom/reflow and reduced-motion checks. Retain the project's 44px control policy. Use motion to explain state changes.

4. Integrate Hermes deeply through supported boundaries.
Bud is the customer-facing identity. Hermes remains an independently managed, unmodified headless runtime. Customise through supported profiles, identity instructions, skills, memory policy and approved tools. Evaluate relevant capabilities against the admitted release; record supported, connected, verified and excluded capabilities with reasons. Department work and delegated tasks remain scoped to approved sources and actions. Persistent learning and consequential actions follow RealBud's review and authority controls. Keep one authoritative business scheduler.

5. Prove portability and preserve behaviour.
Inspect current source and rendered flows before changes. Start with declarative pack-driven presets using existing view types and workflow adapters. Validate two fictional client configurations with different departments and priorities on the same unchanged core. Add new form or layout types only through reviewed reusable contracts. Verify existing workflows, data compatibility, permission isolation, exact approvals, stale edits, duplicate prevention, cancellation, restart and uncertain-effect recovery. Measure task success, manual steps, time and errors against a recorded baseline. Report local, packaged, installed, live and customer proof separately. Live account access, sending, financial actions and deployment require authority for the action.
```

## 2. The flexibility boundary

The design direction is a stable application shell with configurable work definitions and qualified view templates. A client should receive a tailored workspace through a reviewed configuration, with consistent operational meaning across clients.

| Layer | Owns | Variation allowed |
| --- | --- | --- |
| Application shell | Identity, scopes, navigation, work state, authority, scheduling, recovery | Role-appropriate access and supported navigation presets; core controls remain authoritative |
| Component and layout registry | Shared tokens, controls, forms, queues, tables, detail and review patterns | Qualified reusable variants and responsive behaviour |
| Workflow pack | Workflow definitions, instructions, mappings, terminology, department defaults, required capabilities and view presets | Versioned, validated definitions supported by the installed core |
| Private installation bindings | Connected source accounts, granted scopes, responsible members and local configuration | Explicitly authorised tenant/member bindings; never embedded in distributable packs |
| Personal preferences | Saved views, allowed filters, ordering and density | Preferences within current role; never new access or execution authority |

For example, a fictional accounts team could emphasise bills, reconciliation exceptions and deadlines; a fictional maintenance team could emphasise cases, evidence and waiting for suppliers. Both use the same shell, action semantics and review components. This is a portability acceptance scenario, not a claim that these configurations already work.

## 3. Current foundation and the specific gap

Current-source checkpoint: HEAD `0944a9fc` with existing uncommitted work retained. These are source findings; they do not establish installed or live customer behaviour.

1. **Reusable packs already exist.** `CustomerPack` v1 defines workflow groups, recipes, instruction-only skills and dependencies. It does not yet define views, form schemas or layout templates. See [shared/customer-packs.ts](../shared/customer-packs.ts).
2. **Presentation configuration already exists.** Saved views support five registered kinds and bounded filters; Desk sections can be ordered and hidden while Needs you remains visible. These are display preferences, not executable authority. See [shared/workspace-tabs.ts](../shared/workspace-tabs.ts) and [WorkspaceSavedView.tsx](../src/components/WorkspaceSavedView.tsx).
3. **Upgrade/recovery mechanisms are valuable foundations.** Pack changes use previews and digests; saved-view edits check revisions and keep layout history. Preserve these mechanisms when adding configuration. See [customer-pack-upgrades.ts](../server/customer-pack-upgrades.ts) and [workspace-tabs.ts](../server/workspace-tabs.ts).
4. **Client portability remains constrained.** Operational agency bindings currently name `office-core` and `austin-office`, with fixed recipe-role bindings. A valid imported pack does not automatically establish operational compatibility. See [agency-workflow-packs.ts](../shared/agency-workflow-packs.ts).
5. **The current shell should remain the baseline.** Current source renders Desk, Work and Schedule, pinned views and Workspace utilities using existing paper/ink/agency tokens, focus rules and shared controls. Preserve routes and draft/navigation guards; improve discoverability based on rendered evidence. See [Sidebar.tsx](../src/components/Sidebar.tsx), [workspace.css](../src/workspace.css) and [navigation-guard.ts](../src/lib/navigation-guard.ts).

## 4. Incremental implementation and acceptance

1. **Record the baseline.** Capture existing representative tasks and rendered states with fictional data. Record completion, staff actions, time, errors and recovery. Protect working routes, persisted formats, drafts and access boundaries.
2. **Connect existing definitions.** Design a reviewed manifest extension for supported role bindings, department defaults and saved-view presets. Preserve v1 imports; preview compatibility with the installed core. Use existing registered renderers and adapters for the first slice. Define whether each setting is a pack default, customer override or personal preference, and show conflicts explicitly.
3. **Prove two-client portability.** Configure two fictional agencies with different approved workflows and view priorities. Confirm no client-specific application source fork, no credential or record leakage, and unchanged existing workflow behaviour. Test upgrades, conflicting personal edits, unsupported capabilities and rollback. Loading a pack must not start work or grant access.
4. **Extend the registry selectively.** Introduce structured forms or additional layouts only when an agreed workflow demonstrates the need. Specify data schema, validation, accessibility, authority checks, renderer, recovery and compatibility together. Preserve existing business-state models; map shared display states through adapters rather than renaming stored states indiscriminately.
5. **Qualify the complete journey.** Check configure → connect authorised source → acquire work → prepare → review/approve where required → execute within authority → read back evidence → resolve exceptions/handoff → record completion. Review both responsive rendering and operational failure paths. An uncertain external result remains a recovery state until reconciled; it must not become an automatic retry.

### Professional design criteria

Use a measurable standard for the requested design quality:

| Criterion | Evidence required |
| --- | --- |
| Understandable work | Representative users can identify what needs them, why, the responsible person and the next action without interpreting runtime terminology |
| Consistent interaction | The same action and state have the same meaning across workflow packs; rare settings are clearly discoverable without dominating daily work |
| Appropriate layout | Layout follows the task; narrow/zoomed states retain information, controls, selection and drafts |
| Accessible operation | Keyboard/focus, names, status announcements, contrast, reflow and reduced motion checked against WCAG 2.2 AA; a screenshot alone is insufficient |
| Reduced manual effort | Compared with a recorded manual baseline: task success, staff actions, time and errors; no unmeasured time-saving claim |

Progressive disclosure should keep frequently needed options visible and place rarely needed settings behind clearly labelled controls. This applies [NN/G's progressive-disclosure guidance](https://www.nngroup.com/articles/progressive-disclosure/) and [consistency guidance](https://www.nngroup.com/articles/consistency-and-standards/).

List-detail and supporting-pane layouts are useful starting patterns, chosen according to the work rather than copied as a new visual style. See [Google's canonical-layout guidance](https://developer.android.com/develop/ui/compose/layouts/adaptive/canonical-layouts).

For ordinary vertically scrolling content, test reflow at the equivalent of 320 CSS pixels; genuinely two-dimensional content has a scoped exception, and surrounding content must still reflow. Keep necessary table scrolling local where practical. See [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html). Status updates also need an accessible programmatic announcement strategy; see [W3C status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

## 5. Evidence and remaining limits

This brief is based on current source inspection, public primary design guidance and the current Product Design workflow. It changes no application runtime, workflow pack, authority policy or Hermes source. No live customer accounts, sending, financial effects or deployment are part of this work.

The [current-interface baseline report](../outputs/template-ui-audit-2026-10-10/AUDIT.md) contains five freshly captured and inspected screens: onboarding entry, optional account gate, populated Desk, Work readiness and compact Desk. The sampled Desk preserved the selected case at 390 × 844 with measured document/body widths of 390px. The 1280 × 720 Desk queue/detail pattern is a useful foundation; sample-entry friction and Work's compact-height balance need task evaluation, not a blanket redesign.

These are local fictional-data rendering and navigation checks; they do not establish packaged, installed, provider or customer acceptance. No agent request, account linking, external approval or schedule was executed. No application regression suite was run for this documentation-only deliverable. Implementation and client acceptance of the proposed manifest/form/layout extensions remain outstanding.

The temporary fixture was stopped, its listeners closed and its private scratch removed; this cleanup was independently checked after receipt readback. The [verification receipt](../outputs/template-ui-audit-2026-10-10/design-brief-verification.json) also records five accepted screenshot files and successful local-link checks. A bounded independent architecture review found no material corrections to this proposed contract.
