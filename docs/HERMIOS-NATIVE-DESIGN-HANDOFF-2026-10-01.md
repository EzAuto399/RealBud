# RealBud × Hermios native design handoff

1 October 2026 · Isolated design prototype; no production edits or deployment.

## Deliverable and implementation boundary

The runnable prototype uses RealBud's current paper/ink/agency palette, four navigation doors, divider-based module rows, an explicit organization/workspace identity strip, configuration previews, and record-attached Bud work. All organizations, identities, dates, access decisions and work receipts are fictional. There are no CRM, account, model, payment or external-message calls in the application.

The implementation contract arrived during the design pass. The prototype now separates two scopes:

| Scope | Entry | What it demonstrates |
| --- | --- | --- |
| **Contract v1 pilot** | Default localhost page | Exact v1 module identities and states; one pilot plus planned entries; organization preferences limited to `displayName`, `industry`, `instructions`; actor permission distinct from access and connection |
| **Next-phase concept** | `?phase=concept`, explicitly labeled | Included/trial/operator-granted/request-access/suspended examples; rich industry terminology/stages/assignment design; native CRM record view; bounded read/draft handoff and retained receipts |

The concept is a visual destination, not a claim that v1 installs industry metadata, creates workflows, connects a workspace, authorizes CRM reads, or executes Bud collaboration. **Included commercial access does not exist in v1.** Its example remains confined to the next-phase concept. V1 uses `grantSource: operator | trial | null`.

## Source and ownership record

- RealBud checkout: `/Users/yo-da/projects/RealBud`; base `e11c0bf79e13a75773b108b4aef0a749f8ce0894`; 140 changed/untracked status entries at this task's initial inspection. This is an active shared checkout. Existing edits were preserved; no clean release baseline is claimed.
- Visual references: `DESIGN.md`, `.claude/rules/ui.md`, current `src/styles.css`, `src/workspace.css`, `src/ask.css`, `Sidebar.tsx`, `YouPage.tsx`, `CompanySetupCard.tsx`, `SettingsPrimitives.tsx`, and the screenshots supplied in this chat.
- Product proposal: read from `/Users/yo-da/Documents/GitHub/salesfren/docs/realbud-hermios-platform-design.md` and `realbud-hermios-build-coordination.md`. The coordinator subsequently reported their relocation to `/Users/yo-da/Documents/Documents - yo-da’s Mac mini/GitHub/salesfren/docs/`; use that current location for follow-up.
- V1 implementation reference: `/Users/yo-da/projects/hermios-realbud-modules/docs/contracts/hermios-modules-v1/README.md`, generated schemas/state fixtures, and `packages/twenty-shared/src/application/hermiosModule.schema.ts`. Coordinator-reported branch `codex/realbud-module-access`, based on `72e3be15b7c06f2a398649c7fae352ba156adb81`; not deployed. This design does not certify the backend or selected release baseline.
- This assignment owns only `outputs/hermios-native-design-2026-10-01/**` and this handoff. It changes no shared RealBud production source. Earlier Ask/composer changes in this chat predate and are outside this assignment.
- The RealBud workflow owner retains the production adapter, routing, state, authentication and execution integration. No commit, merge, installation or deployment was performed by this assignment.

## Run and review

From the RealBud checkout with its existing dependencies and Node 24:

```sh
node outputs/hermios-native-design-2026-10-01/serve.mjs
```

Open the printed localhost URL. `PROTOTYPE_PORT` may select another local port. The review server was opened at `http://127.0.0.1:5173`; that address is only available while this local process is running.

```sh
node outputs/hermios-native-design-2026-10-01/build.mjs
node outputs/hermios-native-design-2026-10-01/qa.mjs
```

The prototype build writes only its own `build/` directory. The QA runner uses the existing bundled Playwright and local Chrome paths recorded in the runner. No repository-wide install is needed. All saved settings and task histories in the prototype are in-memory; reload resets them.

## V1 integration mapping

Consume the coordinator's released schema or immutable generated artifact. The copied fixtures demonstrate a presentation adapter; they are not an independent source of authority.

| Contract fact | Native UI treatment |
| --- | --- |
| `hermios.realbud` | The only pilot module. Explain its access separately from its connection and organization preferences. |
| `hermios.industry.real-estate`, `hermios.industry.accounting` | Planned industry entries. Show Coming soon; no enable/install action. |
| `hermios.bud.collaboration`, `hermios.automation.advanced`, `hermios.private-extension` | Planned entries. Neither grants nor the visual concept make their operations available. |
| `requires_access` | Access required. Explain who can grant it; any prototype request is local and explicitly unsent. Do not create a production request endpoint that the contract does not provide. |
| `disabled` | Access permitted, organization preference off. An authorized member can review configuration/enablement. |
| `enabled` | Organization enabled the pilot with an effective allow. This does not mean Connected or Work completed. |
| `expired` | Access expired; new enablement/configuration changes unavailable. Preserve stored preferences. No invented renewal price or automatic retry. |
| `denied` | Access blocked by current operator decision. Buying access is not a remedy. Preserve stored settings. |
| `coming_soon` | Planned capability. No actionable enablement control. |
| `grantSource: operator` | Operator grant, with authoritative reason/validity if supplied. Not a role or record-access grant. |
| `grantSource: trial` | Trial with the provided expiry. Do not invent billing or trial conversion. |
| `canConfigure` | Editing affordance from current actor permission, independent of access. Member role labels alone must not compute authority. |
| Revocation with stored preferences | Reject changed configuration without access. Allow disabling unchanged preferences if the contract permits it; do not use an unavailable editor to broaden this exception. |

The current configuration request contains the complete three-field configuration, module ID, `expectedProfileId`, `expectedRevision`, and enabled preference. Capture the immutable user-workspace membership and revision at edit start. A conflict or ambiguous mutation keeps the draft; refresh, compare and ask for an intentional retry. Never replay a mutation automatically.

The coordinator's final lifecycle refinement requires a fresh organization opt-in when an allow is renewed after a lapse or revocation; continuous valid renewal retains the existing preference. Trial allows require a future expiry. The fixture selector represents explicit published snapshots, not a grant-renewal implementation. Production must consume the returned effective state and must not restore enablement from a stale local preference. Native conflict handling must preserve the draft's original expected revision until the person reviews a fresh proposal.

`displayName` is at most 80 characters; `instructions` at most 4000; industry is `general`, `real-estate`, or `accounting`. These are stored preferences only. Industry selection does not create objects/stages; instructions do not become system instructions, executable code or permission.

The initial native screen should be read-only until the explicit RealBud company/member ↔ Hermios workspace/profile binding is verified. Do not match by email or reuse the local Office book name as tenant authority. Invalidate old requests on account/organization change. Clear prior records and pending approvals; retain only drafts explicitly keyed to their original authorized organization.

## Component handoff

The isolated code is intentionally not wired into production routes or stores. The presentation sketches in [component-contracts.ts](../outputs/hermios-native-design-2026-10-01/component-contracts.ts) identify the intended adapter boundaries; their `NextPhaseConcept` namespace is not a supported v1 protocol.

| Component | Responsibilities | Integration notes |
| --- | --- | --- |
| Organization identity strip | Active organization, mapped CRM workspace, current member, visible fixture/unavailable provenance | Always remains visible. Organization changes are explicit; previous-account responses cannot update it. |
| Module ledger | Search/filter, module purpose, access source/state, one useful next action | Render allowed actions from validated snapshots. A disabled/unknown action must not route around the gate. |
| Access details dialog | Access, enablement, setup/connection, actor permission and recovery explanation | V1 has no verified connection flag; use a separately validated binding. Never offer payment for permission or operator denial. |
| Organization preference editor | Scoped draft, validation, before/after preview, explicit save | V1 accepts only three fields. Reuse `api()` / host adapter; no direct client fetch or cross-repository import. |
| Future industry setup | Terminology, stages, assignments, guidance, preserved defaults/overrides | Later contract required. Do not submit these fields to v1, which rejects unknown fields. |
| Native record canvas | Record identity, facts, source/freshness, relationships, activity and files | Keep CRM inside Desk. Existing saved-view kinds do not yet admit CRM; the adapter owner must add a reviewed native route/schema. |
| Selected context review | Editable goal, selected records, specialist and accountable owner, exact read/draft limits | Record references do not grant access. Pass versioned references and fetch current authorized fields. |
| Handoff work rail | State, scope, owner, limits, one pending decision, cancellation and receipt | Future contract. Keep collaboration and execution states separate; acceptance is not completion. |
| Result receipt | Draft, selected source labels, gaps, unchanged actions, retained per-record task history | A result requires a persisted receipt. A denied, partial, failed, expired or uncertain operation never becomes a success label. |

Use RealBud's existing `Card`, controls, dialog/focus behavior and split panes when integrating. The isolated duplicate CSS is a review artifact, not a new production design system.

## Workflow and interaction specification

**Organization configuration:** choose a module → inspect effective access and role → edit organization preferences → preview changed values → explicitly save. Unsaved drafts belong to their organization. In the concept, switching prompts when a configuration draft exists and preserves it under its original organization. The target organization starts with its own record selection and context. Per-organization goal drafts and task histories remain separate.

**Record handoff concept:** select record → Prepare handoff → choose evidence → inspect owner/specialist/actions/limits → create a sample task → inspect recorded states → review the receipt. The illustrative bound is three minutes, six turns, analysis/drafting only, no onward delegation. These values are examples within current RealBud preparation limits, not a new grant or promised service tier.

Progress contains queued, running, awaiting-approval, completed, partially-completed, failed, cancelled and expired presentations. A changed-evidence decision shows before/after facts and retains the original scope/limits. Stale or unavailable evidence prevents starting or continuing work. Production cancellation must show a pending state until acknowledged; the prototype's explicit fixture controls show an already-recorded cancellation receipt. Never infer an execution `paused` enum from an operator suspension.

In the concept, each task gets a unique local sample ID, is associated with one record and organization, and remains available in Activity. A new task does not erase an earlier receipt. Source names and counts reflect exactly the selected context, including a single-record brief.

**Keyboard:** route changes focus the screen heading; all actions have accessible names; native dialogs contain Tab/Shift+Tab, close on Escape, and restore the invoking control. Desktop work rails are nonmodal and do not trap focus. Dynamic receipt updates use a polite announcement without moving focus. Icon-only narrow navigation retains accessible labels.

**Responsive:** wide screens show catalog plus organization context, or record queue + record canvas + work inspector. Mid-size screens reduce the shell and inspector widths. Narrow screens retain a compact navigation rail and stack the record and work sections in the screen-owned scroll area. Review and decision dialogs retain independently scrollable content and reachable footer actions. This is responsive review proof, not a release of RealBud Pocket.

## Visual and motion tokens

Current workspace tokens: paper `#f6f5f1`, sheet `#fffefb`, ink `#25231f`, muted `#63695f`, line `#dadfd4`, agency `#3f5f45`, selected `#dde4d2`, hold `#825a22`, danger `#a64632`. Use the existing theme names when integrating. Native system sans; 4px controls, 8px panels; divider-led structure and shadows only for dialogs. State always has text plus an icon/mark.

Motion is limited to a 140ms notice fade/3px translation, 200ms dialog fade/8px translation, and a small opacity/scale activity indicator. It does not delay input, change authority or simulate completion. `prefers-reduced-motion: reduce` removes all animations and transitions; static text and icons retain the meaning. Screenshots settle or disable animations before capture.

## Independent review and verification

- [UX/state review](../outputs/hermios-native-design-2026-10-01/ux-review.md) covers scope/identity, access, selected context, focus and integration hazards.
- [Claude review and model evidence](../outputs/hermios-native-design-2026-10-01/claude-design-review.md): installed Claude Code 2.1.286 successfully used exact `claude-opus-5-5` with `--effort high`, tools disabled and no fallback. The provider reported canonical model `claude-opus-5-5`. This was a design-spec review, not browser or backend validation.
- Isolated Vite build and presentation-type check pass; logs are in the output folder. No production build was needed for these isolated assets.
- Final Chrome/Playwright verification passes **33/33 grouped checks**, distinctly recorded as **v1 pilot 11/11** at the default URL and **next-phase concept 22/22** at `?phase=concept`. Zero renderer errors and zero external/API requests. Both modes were checked at 1440×1000, 1024×800 and 390×844 with reduced motion. There are 32 final screenshots with `pilot-v1-` or `concept-` prefixes.
- [Browser receipt](../outputs/hermios-native-design-2026-10-01/qa-receipt.json) and [QA runner](../outputs/hermios-native-design-2026-10-01/qa.mjs) are the execution record. Screenshots are under the adjacent `screenshots/` folder and explicitly labeled by phase.

Browser findings fixed during the design pass: explicit focus wrap at native-dialog boundaries, selected-record-only source counts/text, accessible narrow CRM navigation, stale/unavailable guards on restart/resume, record-correct notes, organization-specific goal drafts, and retained unique per-record receipts.

## Review images

- [V1 module catalog](../outputs/hermios-native-design-2026-10-01/screenshots/pilot-v1-catalog-1440x1000.png)
- [V1 narrow configuration review](../outputs/hermios-native-design-2026-10-01/screenshots/pilot-v1-configuration-diff-390x844.png)
- [Next-phase module catalog](../outputs/hermios-native-design-2026-10-01/screenshots/concept-catalog-1440x1000.png)
- [Next-phase configuration review](../outputs/hermios-native-design-2026-10-01/screenshots/concept-configuration-diff-1440x1000.png)
- [Next-phase scoped handoff](../outputs/hermios-native-design-2026-10-01/screenshots/concept-handoff-scope-1440x1000.png)
- [Next-phase result receipt](../outputs/hermios-native-design-2026-10-01/screenshots/concept-handoff-result-1440x1000.png)

The unprefixed screenshots and `review-*` captures in the output folder are earlier exploratory review artifacts. Use the prefixed images and final receipt for integration review.

## Remaining production work

The prototype proves presentation and local interaction only. It does not establish tenant isolation, profile authentication, installation readiness, authorization intersection, revocation timing, idempotent delivery, mutation conflict handling, real CRM freshness, model accounting or successful execution. Those remain service/adapter integration acceptance gates.

Do not merge this prototype wholesale into production. First integrate the v1 read-only catalog through the verified profile and company binding; then exact three-field preference editing with revision checks. Native CRM reads and the richer handoff/industry experience require their own admitted contracts. Included/paid packaging, read/export after access loss, industry metadata installation and workflow execution remain future decisions or implementation stages.
