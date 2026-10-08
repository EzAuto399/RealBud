# RealBud website and intelligent UX review

**Design proposal — 8 October 2026.** This document does not establish product approval, a production UI change, backend implementation, deployment, live service access or customer acceptance. Evidence is repository source inspection and six user-supplied screenshots. A companion interaction prototype uses fictional organizations and simulated states; it illustrates this proposal and does not operate customer systems. No runtime tests are claimed by this document.

**Latest review:** [End-to-end workflow verification](PORTAL-E2E-REVIEW-2026-10-08.md) records the source checks, isolated tests, readiness corrections and remaining production connections. A successful prototype interaction does not establish the website-to-desktop lifecycle.

**Confirmed role model:** [FDE console and customer workspace](decisions/2026-10-08-fde-console-and-customer-workspace.md). The RealBud FDE team owns workflow engineering and managed configuration; customers receive a separate work-focused UI. Managed access should cover routine adjustments without repeated customer prompts. The read-only customer preview does not imply that real customer sessions are read-only.

## Recommendation

Evolve the existing `/admin` into the RealBud team's organization console. Give operators a searchable organization list, a clear organization workspace, and a guided route from a setup problem to a verified outcome. Keep the customer portal focused on the customer's next action, work, computers, billing and help. Reuse the current operator authentication, provisioning and billing foundations instead of constructing another admin application.

**Confirmed priority: admin first, with a simpler customer view.** Complete the operator organization flow first. The customer owner preview demonstrates the reduced experience; it does not set a requirement to expose all administration to staff.

The central design problem is context and task flow. The screenshots present a billing account, computer pairing, workspace permissions, company identity and workflow distribution as adjacent account pages. The operator needs to understand **which organization, which computer or workspace, what authority, and what outcome** before acting. A persistent context header and a short list of actionable tasks should answer those questions before explanatory prose.

Preserve RealBud's forest-green identity and restrained lime accent. Use clearer surface contrast, compact lists, stronger labels and one primary action per task. Intelligence should help select the next step and prepare a reviewable change. It must use the same permissions and mutation paths as the explicit controls.

### Product surfaces

| Surface | Primary user and job | Boundary |
| --- | --- | --- |
| Public website | Prospective customer learning about RealBud or downloading it | Explain the product and enter sign-in/setup; no customer administration |
| Operator console, `/admin` | RealBud team provisioning, supporting and maintaining organizations | Operator identity is always visible; organization selection does not create customer membership |
| Organization support workspace | RealBud operator working within one customer's approved support scope | Typed operations and host-validated grants; no silent impersonation |
| Customer portal, `/account` | Customer reviewing their work, computer readiness, bills and help | Account, membership, workspace and execution permissions remain distinct |
| RealBud desktop | Staff doing work and reviewing local sources, plans and actions | Authoritative local/company checks, private data and consequential approvals remain here unless explicitly projected |

## Five issues visible in the screenshots

These are observations of the supplied images, not measured usability or accessibility test results.

| Priority | Screenshot evidence | Effect on the user | Proposed correction |
| --- | --- | --- | --- |
| 1 | All six images show `Account`; none shows an organization switcher or operator mode | The RealBud team cannot tell where organization administration belongs or whether a change affects their account or a customer's environment | Add an operator entry for eligible users, a global organization list, and a persistent organization + support-scope header |
| 2 | Workspace access and Company identity each open with a separate code flow and several paragraphs | Users must understand the identity system before knowing what to do; related setup is fragmented | Put pairing, identity verification and access inside one resumable setup journey. Keep each underlying permission check separate; reveal the relevant explanation at its step |
| 3 | Computers occupy large cards with worker versions and check-in timestamps; `Bud ready` appears with a note that successful AI work remains unverified | Operational detail competes with the next action, and a broad green state overstates what has been demonstrated | Show compact computer rows with separate Connection, Setup and Verification states. Move versions and raw diagnostics into details |
| 4 | Billing spans multiple large nested panels; the screenshots mix A$0 customer charges, covered AI consumption and a failed commercial-terms section with repeated retry controls | A user has to reconcile different monetary concepts and distinguish a partial failure from total unavailability | Lead with amount payable and budget consumption as separately labelled figures; group invoices in a tab/section; keep a failed source local to its section with one retry action |
| 5 | Support is a long text page with oversized headings; most pages use similar green surfaces, large empty margins and repeated headings | Important tasks such as fixing setup or getting help are hard to scan, while rare technical details remain prominent | Use task choices and concise issue cards. Keep supporting explanations in expandable details, normalize the heading scale, and reserve visual emphasis for status and the next action |

## Information architecture

Use at most five primary destinations per context. The following routes are proposals, not implemented endpoints. Existing deep links must continue to resolve during migration.

### Operator global navigation

This table is the future global design. The companion prototype implements only Organizations as its global entry; it does not demonstrate the other four global destinations.

| Destination | Main content | Existing surface to reuse |
| --- | --- | --- |
| Overview | Organizations needing attention, setup waiting on someone, service incidents | `/admin` Desk and onboarding pipeline |
| Organizations | Searchable directory, setup stage, last contact, owner and outstanding actions | `/admin/offices` and its provisioning flow |
| Workflow library | Approved pack versions, compatibility, release notes, publish history | Existing signed-pack contracts; global catalog UI is new |
| Billing | Office plans, invoices, collections and internal margin | `/admin/billing` and `/admin/margin`, with Margin as an internal tab |
| Service health | Shared platform connections, dependencies and actionable diagnostics | `/admin/connection` |

### Selected organization navigation

| Destination | Main content | Primary action |
| --- | --- | --- |
| Overview | Setup progress, current blockers, recent outcomes, service/billing summary | Continue setup or fix the highest-priority issue |
| Workflow packs | Published and installed versions, office overrides, verification, schedules and change history | Review a pack or prepare a configuration change |
| People & computers | Owner/contact, roles, independently verified memberships, computer readiness, source connections and support scope | Open the person or computer blocking setup |
| Activity | Setup receipts, operator changes, pack events, failures and support history | Inspect an outcome or resume a held operation |
| Settings & billing | Organization details, service settings, AI budget, billing summary and relevant access controls | Change a permitted setting or inspect the organization's billing |

Settings & billing provides the selected organization's settings and billing entry point. It can link to the existing billing application with a server-validated organization filter. The future global Billing destination remains the cross-organization collection and reporting surface; avoid duplicating those reporting tools inside every organization.

### Customer navigation

| Destination | Main content | Existing routes to retain or redirect |
| --- | --- | --- |
| Home | One next business action, useful results and setup/service notices | `/account` |
| Work | The person's work requests, assigned reviews and permitted outcomes | `/account/remote-work`; any broader result projection requires host authority |
| Workflows | Understandable workflow state and permitted preferences or change requests | `/account/packs`; engineering controls move only when the FDE replacement works |
| Computer & help | Their computer, required connections, setup help and support | `/account/installations`, `/account/remote-approvers`, `/account/support`, `/start`, `/download` |
| Account | Personal settings; owner-only team, billing, usage and budget controls | `/account/company-portal`, `/account/ai-billing`, existing invoice anchors; team projection requires host authority |

This is the customer **owner** preview. Staff receive a reduced view: their work, their permitted activity, their computer and help. Hide owner-only team management, organization settings and billing controls unless the person's independent grants admit them. A billing reader does not gain workspace access because Workflows appears in the shell. Preserve a usable permission explanation and a route back when a bookmarked page is no longer allowed.

### Organization context and switching

1. Open Organizations and choose a customer by name; show a stable secondary identifier when names collide. Search and filters should not require a page of provisioning forms first.
2. Enter the organization's overview with its name, environment, operator identity and support scope visible. Keep these visible on workflow previews and confirmation cards.
3. Select a computer or workspace only when the task needs one. Offer a suggested target with its reason; require an explicit choice when several targets are plausible.
4. Switch organizations through the same control. Clear scoped queries, assistant context, selection and pending previews; preserve a draft only under its original organization with a clear return link.
5. Leave support mode through a visible exit action. A customer-view preview stays labelled as preview and never changes the operator into the customer's identity.

## Role and authority model

This matrix describes the intended experience. Existing permissions remain authoritative until a separately reviewed implementation adds a capability. Support grants and a fine-grained operator role model are proposed backend work, not current features.

| Identity/context | May see | May change | Must remain separately authorized |
| --- | --- | --- | --- |
| RealBud operator, global | Organization service metadata and internal billing/platform information | Existing provisioning, AI-access and billing operations admitted by operator routes | Customer private work, company membership, workspace execution and local settings |
| RealBud operator, scoped support | Diagnostics/configuration explicitly allowed by an active support grant | Allowlisted configuration or pack operations within that grant | Broader access, private content, payments, sending, notices and other consequential actions |
| Customer billing owner | Their account, billing, computers and published pack metadata | Current billing-owner actions, including signed-pack upload/removal | Company ownership, workspace access, remote review and execution grants |
| Customer billing reader | Account information allowed by billing-reader routes | Only actions specifically admitted for that role | Owner mutations and all independent work permissions |
| Company owner | Company membership and scopes admitted by the company host | Membership, department configuration and template publication admitted by the host | Other people's private work and device/service administration |
| Company member | Assigned company/department/workspace scope | Work and settings their current grants permit | Owner-only operations and unrelated scopes |
| Local service administrator | Admitted service diagnostics and bootstrap metadata | Local privileged service settings | Owner impersonation, personal membership and private business data |
| Bud/assistant | Data projected for the current authenticated actor and scope | Typed proposals and host-admitted operations | Creating authority, changing organization implicitly, widening permissions or approving its own proposal |

### Scope enforcement requirements

1. A customer request derives organization and actor from the server's current account/person gate. A URL, browser body, assistant tool argument or client filter is not authority.
2. An operator may select an organization in a dedicated operator route, but the server must validate operator capability, target organization and any support grant on every read/mutation. Do not call customer routes with a substituted company ID.
3. Model the website organization ID, company-host ID, installation ID and workspace ID as distinct identities with verified bindings. Current website and company-host authority are separate; do not assume matching labels or IDs establish a relationship.
4. A support grant records operator, organization, target, allowed operations, approval provenance, issue/expiry time and revocation state. Establish the needed scope once for the support task; do not add repetitive approval prompts to routine operations already covered. The host still validates that scope at execution.
5. Recheck authority after asynchronous boundaries and before commit. Use expected revisions, idempotency keys and durable receipts; an expired grant, switched organization or changed revision must stop the pending change with a recoverable explanation.

## Five-stage organization setup

Show one stage in progress, completed stages with their evidence, and who owns the next action. The count is progress through these stages, not a percentage of all possible technical checks. A person can leave and resume without losing accepted facts.

| Stage | Operator/customer task | Completion evidence | Common held state |
| --- | --- | --- | --- |
| 1. Organization details | Operator creates invite; owner verifies identity, supplies organization details and accepts terms | Accepted invite and authoritative account/service provisioning receipts | Waiting on owner, expired invite, provisioning incomplete |
| 2. People & roles | Relevant owner identifies people and grants the membership, workspace and support permissions needed for setup | Independently verified role/scope grants and an identified responsible person | Owner action needed, identity not verified, scope missing |
| 3. Computers & sources | Customer installs/pairs RealBud and signs into required sources; operator checks the intended computer/account | Active installation binding, fresh check-in and scoped source checks | Waiting for computer, stale report, wrong account, source unavailable |
| 4. Workflows | Operator selects a signed version, tunes allowed defaults and sends it for the applicable local review | Published version plus installation/configuration receipt for the target | Awaiting review, incompatible version, local changes conflict |
| 5. Verify & recurring work | Authorized person runs a bounded preparation test, reviews evidence and separately decides whether to enable recurring work | Test outcome, reviewer acceptance and explicit activation receipt | Test failed, result needs review, ready but paused |

Do not mark the entire office Ready when only billing and AI provisioning complete. Use `Account ready`, `Computer connected`, `Workflow installed`, `Test verified` and `Active` only for the evidence each label describes.

## Workflow pack lifecycle and tuning

Website publication, desktop installation, verification and activation are different transitions. The existing website offers pack bytes; it does not prove a target installed or ran them. A future operator release view should show each target independently, with an aggregate such as `2 of 3 computers installed` only when receipts support it.

| State | Meaning | Visible action and authority |
| --- | --- | --- |
| Draft configuration | Desired version/settings are being prepared for one organization/target | Edit allowed fields; show inherited default versus local override |
| Ready to publish | Signed version, compatible format and reviewed configuration are selected | Review target, version, change summary, prerequisites and affected schedules |
| Published | Exact pack bytes are offered to the organization | `View publication`; do not say Installed or Active |
| Awaiting computer/review | Target has not received or accepted the proposal | Show last contact, responsible person and the review step; avoid repeated delivery on refresh |
| Installed, paused | Host verified signature and committed a reviewed version with an installation receipt | `Run verification`; local overrides/conflicts are visible and schedules remain off |
| Verification pending/failed | A permitted bounded test has no accepted successful result | Review evidence, fix the specific failure or retry safely |
| Verified, paused | Agreed test passed and was accepted for this version/configuration | `Review activation` with target, schedule, sources and limits |
| Active | An authorized activation committed against the reviewed configuration | View last successful run, next run and pause control |
| Change held/recovery required | Revision conflict, partial application or uncertain delivery prevents a safe transition | Reconcile receipt or refresh a preview; keep existing work and evidence |
| Superseded/rolled back | A later reviewed change replaced the version | Inspect history; rollback is a new scoped change, not removal of history |

### Pack detail layout

1. **Summary:** purpose, organization, target, published/installed version, verification and activity state. Offer one action appropriate to the current state.
2. **Rules:** plain-language form for allowlisted settings with defaults, office overrides and validation. Technical recipes/instructions are an advanced view, not the first task.
3. **Changes:** before/after diff, affected plans, schedule effects, conflicts and required approvals. Updating instructions can invalidate a previously reviewed plan; show that effect before commit.
4. **Verification:** exact test, source scope, expected result, observed result and reviewer. Synthetic tests and live customer evidence are labelled separately.
5. **History:** who changed what, publication/install/activation receipts, current revision and available rollback. Show restoration only where the backend actually retains history.

Keep publish/upload removal wording precise: removing a pack from the website stops offering it; it does not uninstall existing copies or cancel running work. Bulk publication can be added after single-organization flows are reliable; bulk activation needs independent target authority and explicit partial-result handling.

## Intelligent interaction design

Make the assistant a context-aware helper within the organization workspace. It should explain the current blocker and prepare actions available in the visible UI. Global chat may help find an organization, but must not execute an ambiguous cross-organization request.

### Proposal → review → receipt

1. **Understand:** show the active organization and target; read only authorized state. If the request is ambiguous, ask one bounded question such as which computer or workflow.
2. **Prepare:** create a typed proposal containing target bindings, current revision, desired values, reason and expected effects. A draft is visibly labelled and changes no customer state.
3. **Review:** show the before/after values and operational effect in plain words. Reuse the same review component as manual editing; explain only the approval needed for this change.
4. **Apply:** submit through the same server-validated command path as the form. Show Queued, Awaiting computer or Applying as reported; double clicks and reconnection must not duplicate the change.
5. **Confirm:** display the authoritative receipt, resulting state and any next action. A tool timeout produces `Outcome not confirmed — checking receipt`, never a success sentence or an automatic repeat.

Example: “Move the inspection review to Monday at 9 am” becomes a card naming the organization and computer, the current and proposed schedule, timezone, affected workflow and whether it remains paused. An accepted schedule change does not itself enable the workflow. If another operator changes the schedule before commit, refresh the proposal and request review of the changed facts.

Start with deterministic next-action rules based on observed states: expired invite, stale computer, missing source authorization, pending review or failed verification. Show the evidence/time behind the recommendation. Add model-generated explanations only after the relevant projections exist; text should never imply an unseen live check.

Keep manual controls available, preserve existing conversation in its original context, and let users dismiss nonessential suggestions. Essential approval, recovery and stopping controls cannot be hidden by personalization. Assistant-generated instructions are data, not authorization.

## Visual and interaction system

| Area | Proposed behavior |
| --- | --- |
| Page shell | Full-height working shell with compact navigation, an organization header and a readable content column; use available width for real tables rather than oversized empty margins |
| Typography | One page heading, short section headings, clear body text and subdued metadata; remove repeated marketing-style headings inside operational tasks |
| Color | Forest green for identity/navigation, visibly distinct content surfaces, green for primary actions and muted lime for selected navigation, and explicit text/icons for status; validate actual token contrast before shipping |
| Lists | Compact organization/computer rows with name, status, next action and last checked; open details for versions, IDs and logs |
| Task composition | One dominant action per stage; secondary actions in a consistent location, destructive actions in a labelled menu with a consequence-specific confirmation |

### Responsive and accessibility acceptance targets

1. At 390 CSS pixels wide, every destination and essential action remains reachable. Navigation becomes a labelled menu; multi-column tables become labelled row summaries, and drawers become full-screen panels. Do not hide the organization or support scope.
2. At 200% zoom and narrow reflow, forms and reviews remain usable without clipped controls or horizontal page scrolling. Permit scoped horizontal scrolling only for genuinely two-dimensional detail.
3. Keyboard users can operate search, switcher, lists, tabs, dialogs and review actions. Preserve logical order, visible focus, Escape dismissal where appropriate and focus return after closing overlays.
4. Provide semantic headings, labels, field-level errors and an error summary. Announce meaningful asynchronous state changes without reading every polling refresh; reduced-motion preferences disable nonessential animation.
5. Target WCAG 2.2 AA in implementation, with normal text contrast of at least 4.5:1, visible non-text control contrast and comfortably sized touch controls. These are proposed acceptance criteria, not an assertion that the current or prototype UI has passed an audit.

### Required states

| State | User sees | System behavior |
| --- | --- | --- |
| Loading | Stable skeleton and section label | Preserve layout; do not flash an empty list |
| Empty | Specific reason and one relevant starting action | Distinguish no organizations, no computers and no permission |
| Partial data unavailable | Affected section with last-known timestamp and retry | Keep independently loaded sections usable; never turn missing counts into zero |
| Offline/stale | Last contact and which actions wait for the computer | Hold typed requests with expiry; never claim remote completion |
| Permission absent/revoked/expired | Needed scope and the actor who can supply it | Deny on the server and stop pending mutations; do not loop sign-in |
| Validation/conflict | Field-level correction or changed-revision explanation | Retain draft under its original scope; require a fresh preview when relevant facts change |
| Applying/unknown outcome | Operation state and receipt reference | Disable duplicate submission and reconcile the original intent |
| Success | What changed, where, who did it and when | Show committed state from receipt, not optimistic local state |
| Recovery | Preserved state, affected operation and one recovery action | Do not silently discard history or replay uncertain actions |

## Backend capability gaps

The following are implementation prerequisites, not permission to weaken existing boundaries.

| Capability | Current source evidence | Required addition |
| --- | --- | --- |
| Organization support overview | Existing office directory exposes billing ID and label only | Canonical authorized projection combining organization, installation and independently bound host/workspace references; pagination and freshness |
| Operator-targeted pack publication | Customer route derives company from billing account; owner uploads exact signed bytes | Dedicated operator route and publication audit; atomic revision/conditional writes; server validation of selected organization |
| Remote configuration/support | Existing remote work operations are preparation-only | Typed support/configuration protocol, explicit grants, host-side capability checks, revision fencing, durable delivery and receipts |
| Installation and activation visibility | Desktop owns pack installation/history; website lists offered packs | Minimal authorized reports for received/reviewed/installed/verified/active state, with provenance and version binding |
| Multi-context UI and assistance | Customer person/session binds one account/company; operator identity is separate | Scoped queries/caches/drafts, clear operator support context, lifecycle cleanup on switching, and backend-enforced assistant tools |

A UI switcher must not be implemented by rewriting a customer cookie, changing a client-side company variable or granting an operator a member token. Existing service-administrator sessions are local and are not a web support grant. Private work stays private unless a specific independently authorized projection is designed.

## Staged implementation and acceptance

Each stage should produce a complete, reviewable operator flow first, with a simpler customer owner/staff view following from it. Carry existing URLs and business behavior forward; do not require a full authority redesign to improve the current shell.

| Stage | Bounded implementation | Acceptance criteria |
| --- | --- | --- |
| 1. Shell and clarity | Reuse `/admin` first; clarify operator context, compact navigation, status semantics and local error states; define the reduced customer shell for `/account` | Existing authorized routes remain reachable; operator/customer contexts are visible; keyboard and 390 px checks pass; no new backend capability is implied |
| 2. Organization workspace | Searchable list and organization overview backed by existing permitted metadata; setup journey and links to current controls | Direct URLs are server-gated; duplicate names are distinguishable; stale/unavailable data is explicit; switching never shows the previous organization's rows or draft |
| 3. Pack operations | Add dedicated scoped operator publication and target receipts; reuse local signature, preview, install and rollback contracts | Upload/publish is never labelled installed; stale revisions conflict; concurrent publication cannot overwrite silently; partial target outcomes are inspectable; schedules remain paused until separately activated |
| 4. Support configuration | Implement bounded support grants and typed remote configuration with host validation | Expired/revoked/wrong-target requests fail at the boundary; duplicate delivery is idempotent; offline/restart/timeout reconcile correctly; audit identifies operator and organization without impersonation |
| 5. Intelligent assistance and verification | Add next-action rules, assistant proposals, shared review cards and receipt-based confirmation | Assistant and form have identical authority; prompt text cannot change target or widen scope; conflict prevents stale application; a real test and activation are separately evidenced |

Measure flow quality with a small task set: locate an organization needing help, identify its next blocker, publish one pack version, resolve a permitted setup issue, and verify a workflow without accidental activation. Record completion, wrong-context errors, backtracking and help needed. Set numerical targets after a baseline session; do not invent customer performance evidence from the prototype.

### Prototype coverage and limits

The companion prototype covers the Organizations entry, the selected organization's five destinations, the five-stage setup sequence and a simpler customer owner preview. It uses fictional organizations and simulated changes. The global navigation beyond Organizations is a future proposal.

Scoped support access, per-computer installation/verification receipts and structured operator tuning are proposed capabilities shown for design review. They are **not connected to production backends**. Prototype state changes do not prove that a pack was published, installed, tested or activated on any computer. This document makes no claim about exact prototype test results; those belong in the parent task's verification evidence.

## Source references

Paths are repository-relative. Line references identify the inspected source on 8 October 2026 and can move as implementation evolves. Comments and local tests describe intent/evidence at the source tier only.

| Reference | Source | Supports |
| --- | --- | --- |
| S1 | `website/app/admin/admin-shell.tsx:6` | Existing five-section operator shell |
| S2 | `website/lib/portal-auth.ts:79`; `website/lib/operator.ts:1` | Operator authentication and email allowlist |
| S3 | `website/app/admin/offices/page.tsx:58`; `website/app/admin/page.tsx:70` | Existing invites, provisioning, AI access, apps projects and operator pipeline |
| S4 | `website/app/admin/offices/directory.ts:4` | Billing-backed directory, limited fields and 1,000-row bound |
| S5 | `website/lib/portal-person.ts:3`; `website/lib/portal-person.ts:64` | Billing-only person context and fresh server identity checks |
| S6 | `website/app/account/account-shell.tsx:10` | Current customer grouping and route inventory |
| S7 | `website/app/api/account/packs/route.ts:13`; `website/app/api/account/packs/route.ts:48` | Account-scoped pack route, owner gate and current non-atomic upload |
| S8 | `website/lib/office-packs.ts:4`; `website/app/api/installations/packs/route.ts:7` | Exact-byte storage and installation-scoped download |
| S9 | `shared/customer-packs.ts:12`; `shared/customer-packs.ts:31`; `shared/customer-packs.ts:50` | Paused arrival, local review, preview, change/history contracts |
| S10 | `server/customer-packs.ts:205`; `server/customer-packs.ts:214` | Signature admission and carefully limited per-client export |
| S11 | `server/office-link.ts:264`; `website/app/account/packs/panel.tsx:80` | Desktop pull; website removal only stops offering a pack |
| S12 | `shared/service-admin.ts:1`; `server/index.ts:3255` | Independent local service-administrator authority |
| S13 | `server/company/index.ts:88`; `server/company/index.ts:130`; `server/company/index.ts:237` | Company authentication, scope authorization and no owner impersonation through service administration |
| S14 | `server/company/index.ts:266`; `server/company/workflow-template.ts:25` | Owner-gated template publication and normalized schedule-free template |
| S15 | `shared/website-commands.ts:1`; `server/website-work-adapters.ts:110` | Preparation-only remote protocol and local reviewed execution binding |
| S16 | `server/workflow-settings-broker.ts:155`; `server/workflow-settings-broker.ts:421`; `server/workflow-settings-broker.ts:450` | Existing local settings read/propose/review pattern, revision checks and authority checks |
| S17 | `.claude/rules/website.md`; `.claude/rules/server.md` | Website/company separation, identity rechecks, mutation guards and server conventions |

## Next design validation

Open the companion prototype and complete one fictional task: choose an organization, identify its blocked computer, and review the proposed workflow change. The review should make the organization, target, authority and remaining verification step clear before any action is confirmed.
