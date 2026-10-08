# FDE console and customer workspace

**Owner decision — 8 October 2026.** This records the requested product and authority model. It does not establish deployed UI, new remote administration capabilities, installed-device verification or customer acceptance. The current code already has separate operator and customer routes; the richer managed-workflow controls remain implementation work.

## Decision

RealBud is delivered and maintained by the RealBud FDE team. Give that team a dedicated administration console with more capabilities than the customer workspace. The FDE prepares, configures, tests, deploys and maintains the customer's workflows. Customers use the resulting workflows and handle their own work, preferences and permitted decisions.

Use three unambiguous role names: **RealBud FDE**, **Customer owner**, and **Customer member**. A customer owner is an administrator of their own organization, not a RealBud platform administrator. A person who holds both roles enters separately authorized surfaces; a UI role picker never changes identity or authority.

## Different interfaces

| Surface | Main destinations | Primary interaction |
| --- | --- | --- |
| FDE console, `/admin` | Organizations, workflow library, operational activity, billing, service health | Select a customer; inspect the problem; configure and compare a change; test, deploy and verify it |
| Selected customer in the FDE console | Overview, workflow packs, people & computers, activity, settings & billing | Tune the specific organization and computer under its managed scope; keep draft, published and applied revisions distinct |
| Customer owner workspace, `/account` | Home, Work, Workflows, Computer & help, Account | Use prepared work, review permitted decisions, see what is working, request a change, and manage their own team/account |
| Customer member workspace | Same simple work destinations; Account contains only personal settings/help | Access their permitted work and computer; owner billing/team controls are absent unless independently granted |

Keep the visual brand shared, but make the page composition and navigation reflect the job. FDE pages expose configuration, diagnostics and deployment evidence. Customer pages lead with work/results and understandable next actions. Do not show pack internals, rule editors, model/provider setup, internal margins, other customers or operator-only support history in normal customer views.

The operator's **Preview customer view** is read-only because it is a preview. Actual customer sessions are interactive: customers can submit permitted work, make assigned decisions, change allowed preferences and request help. Do not accidentally turn the product into a read-only customer portal merely because the design preview is read-only.

## Who controls what

This is the target capability model, not a claim that all operations exist today.

| Capability | RealBud FDE | Customer owner | Customer member |
| --- | --- | --- | --- |
| Organization and service | Provision and maintain authorized customers; configure service, AI access, commercial settings and operational support | Manage their own organization/team and allowed budget settings | Personal profile and assigned workspace |
| Workflow engineering | Create and tune packs, instructions, mappings, reviewer assignments and approved schedules; test and publish revisions | Describe requirements, request changes and adjust explicitly exposed preferences | Use assigned workflows and request help/changes |
| Deployment and operation | Install/update through authorized delivery, verify target reports, diagnose issues, retry, pause/resume and restore an eligible previous configuration | See current service state, control their own permitted work and make decisions required by policy | See their own results, act on assigned decisions and stop their own allowed work |
| Sources and private work | Configure supported integrations and inspect only diagnostics/content covered by a specific grant | Connect their own source accounts and grant/revoke the scopes they are authorized to control | Connect permitted personal sources; other people's private work remains separately scoped |
| Intelligent UI | Bud helps diagnose, prepare configuration changes, explain diffs and verify deployment results | Bud helps with work, results, requests and approved preferences | Bud helps with assigned work and results; it cannot expose FDE tools or widen authority |

## Managed authority without repetitive prompts

Establish **managed configuration access** during customer setup. It should explicitly identify the RealBud operator/service role, customer, targets, allowed configuration/deployment operations and validity/revocation policy. Routine FDE changes inside that granted scope do not need a new customer approval at every click. The server still validates the grant at execution and records who changed what.

Use a separate temporary support grant when work needs additional scope. On reload, revalidate existing server authority and resume valid access. The current offline prototype uses a 30-minute simulated support grant and reapproval after reload only because it has no authority server; that is not the intended everyday FDE onboarding policy.

Keep consequential execution separate from configuration. An organization may explicitly delegate deployment or recurring activation under its workflow policy; otherwise obtain the required authorized decision. Publishing, installing, passing a trial, enabling a schedule and observing its result remain separate recorded transitions even when some are automated under an existing grant. Sending, payments and other business actions continue through their own applicable permissions and decision rules.

The customer connects their own source identity where required. FDE access does not mean signing in as the customer, taking over their private workspace, exposing provider master keys or approving a business action merely because the operator can configure a workflow.

## Implementation status and transition

The existing `/admin` layout, pages and API handlers use the server operator gate. `/account` uses customer account/person gates and separate ownership rules. Existing FDE powers include office invitations/provisioning, AI access and caps, apps-project recovery, billing/margin and service diagnostics. This review found no current customer direct-link path that bypasses the operator gate; exact local test evidence is under `outputs/fde-role-review-2026-10-08/`.

The local source shells now visibly say **FDE console** and **Customer portal**, including page context at narrow widths where header subtitles are hidden. This is role clarity, not the implementation of new remote controls. The updated fictional preview gives customers a separate rendering path and simpler work-focused content.

Three production connections from the [E2E review](../PORTAL-E2E-REVIEW-2026-10-08.md) remain required: organization-scoped managed/support authority; atomic operator-targeted workflow publication; and revision-bound installation, trial, activation and scheduled-result reports. The client UI must never claim that an FDE change applied before the corresponding target confirms it.

Do not remove the existing customer-owner pack distribution path before an equivalent FDE publication path works. The simplified target UI is not permission to break the only implemented delivery route. Move engineering controls into the FDE console as each replacement operation becomes available, retaining useful customer status and existing deep links.

### Local verification

Website role/contract tests: **88 passed / 0 failed / 0 skipped**, including the real local gateway token verifier after correcting its test fixture lookup. Production authorization code is unchanged. Website TypeScript validation exits 0. The source review found separate layout/page/API gates; these are local checks with fictional identities and mocked transports, not live deployment acceptance. Evidence: `outputs/fde-role-review-2026-10-08/website-role-review.json` and `website-role-tests.log`.

Final prototype role checks: **11 passed / 0 failed / 0 skipped**, with no browser errors. The customer keeps its applied work while an FDE update is pending; a newly installed replacement remains in setup until its own trial passes. Desktop and 390 px dark customer views were visually inspected. This prototype shows the customer-owner example; member-specific permissions remain a target requirement.

The copied legacy suite passed **18 / 0 / 0** before the final narrow customer-readiness correction. The broader adverse rerun recorded **17 passed / 1 timeout / 0 skipped**; an isolated retry passed at a taller viewport with settled scrolling. This is not a fresh full passing adverse run. Exact source timing, harness limits and final hash are in `outputs/fde-role-review-2026-10-08/role-ui-review-notes.md`. Prototype results are fictional and do not verify the new backend capabilities.

## Acceptance

1. Customer owner/member sessions cannot open admin data or execute admin APIs through direct URLs or altered requests; shared UI code does not substitute for these server checks.
2. FDE changes are scoped to the selected customer and target. Switching customers cannot carry drafts, pending actions, assistant context or cached private data into another organization.
3. A routine change covered by managed configuration access completes without repeated customer prompts; expired, revoked or insufficient grants block the exact operation and preserve the draft.
4. The customer's current workflow/result changes only after the target reports the applied revision. Failure, rejection, pause and offline states remain visible with a useful next step.
5. Customer owner and member views expose their permitted work/actions while hiding FDE configuration and internal activity. Bud follows the same role and operation boundaries as manual controls.
