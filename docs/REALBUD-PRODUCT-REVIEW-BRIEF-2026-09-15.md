# RealBud — product and engineering review brief

Prepared 15 September 2026. Intended for an independent product, architecture, security, delivery and usability review. Read this with `REALBUD-PRODUCT-REVIEW-PROMPT-2026-09-15.md`.

**Current position:** RealBud has a substantial existing desktop application, useful local Bud capabilities and a tested company-data foundation. The complete managed two-person, two-device product is unfinished. This brief separates the intended product from recorded implementation evidence. It does not certify an installed release or expand the customer agreement.

## 1. Purpose and intended outcome

RealBud helps a real-estate/property-management agency prepare and follow through on daily administrative work. Its assistant, Bud, should read permitted information, explain priorities and exceptions, prepare useful outputs, work with selected files and applications, and retain unfinished work for human review.

The value is less repeated reading, copying, matching and chasing, with clearer responsibility and reliable recovery. The product should feel like a practical office assistant inside a familiar desktop workspace. Staff should not need to manage model keys, databases, terminal commands or an agent framework.

External systems remain authoritative: the agency's property-management system (PMS), bank, mailbox, calendar and source files. RealBud stores work state, source references, observations, decisions, reviewed outputs and receipts. It should not require a second manually maintained portfolio or rent roll. A property can be linked context; an inbox or file task should also work without maintaining a property catalogue.

The immediate core target is **two working desktops, two private staff profiles, one shared company database, and managed service access**. Both staff must be able to use all three agreed workflows where their permissions and sources allow. Accounts and Property Management are useful test scenarios, not separate product editions or mandatory departments.

The initial platform targets are Windows 11 x64 and Apple-silicon macOS arm64. Minimum OS versions and each supported application/driver combination need explicit release admission; Intel Macs and Windows ARM are not implied by those targets. Additional people and Windows/macOS combinations should use the same architecture. A large autonomous agent organisation, shared business brain or separate memory platform is optional, not a prerequisite for two staff to work successfully.

## 2. The experience we want

One person installs RealBud and selects **Set up company**. Guided setup provisions the admitted company service and PostgreSQL, establishes the owner and host identity, checks prerequisites and explains availability. Another person installs RealBud, selects **Join company**, verifies the intended host, creates their own sign-in and connects their own work accounts. Customers should not exchange database passwords or master API keys.

Each person has Bud available in their own working environment. RealBud shows what Bud will use, which account and computer will act, what approval is needed, and what result was actually obtained. Joining a company does not grant access to a colleague's computer or private folders.

The four existing navigation areas stay:

| Area | Purpose |
| --- | --- |
| **Desk** | Work, reviews, exceptions, selected shared items, responsibility and recovery |
| **Ask** | Private conversation, explanation and preparation using deliberately selected context |
| **Schedule** | Approved routines, run history, coverage, missed/held work and results |
| **You** | Profile, company sign-in, connected apps, device readiness, service status and recovery; technical configuration behind service administration |

Use plain language, clear next actions, keyboard access, readable layout and progressive disclosure. Distinguish loading, empty, unavailable, denied, partial, failed and outcome-unknown states. A working database connection must not make the whole device appear ready: company reachability, member sign-in, source/service access, local computer readiness and permission for the exact job are separate facts.

## 3. The three business workflows

| Workflow | Complete intended journey | Important distinction |
| --- | --- | --- |
| **Morning priorities** | Connect the person's permitted mail/calendar sources → choose the relevant window → retrieve with explicit coverage → identify priorities, waiting items and uncertainty → review → save source-linked work → optionally share selected work → preserve human corrections on later scans | A ten-message sample or partial page is not complete mailbox coverage. A prepared reply is not sent mail. |
| **Expected and missing bills** | Establish reviewed expectations and arrival windows → acquire invoice evidence → distinguish received, duplicate, missing and uncertain items → review and save durable follow-up → request a colleague's missing fact when needed → retain ownership → verify completion from the authoritative system | Missing, unpaid, payment arranged and verified paid are different states. Closing a review does not prove payment. |
| **ANZ bank-reference preparation** | Acquire/select the agreed export on the correct device → confirm account, period and format → preserve the original → propose reference corrections → hold ambiguous matches → review exact rows/revision → export and read back a checked copy → staff checks recognition/totals in the actual REI/PMS preview and performs the final import | Bud prepares a copy; it does not transfer money or automatically post receipts. Preserve row order/count, dates, amounts, leading zeros and untouched fields. |

Existing preparations include inbox triage, invoice intake, bill exceptions and bank-reference candidates. Four preparation procedures support these three outcomes; they do not by themselves establish complete acquisition-to-follow-up pipelines.

The recorded proposal also includes supporting Calendar preparation, Drive/Docs/Sheets lookup, agreed templates, new draft copies, on-demand/weekly summaries and phone continuation. Confirm the exact templates, source counts, format and phone route against the current signed scope before delivery. Calendar changes, if supported and specifically authorised, must not become a route for sending invitations or notifications contrary to product policy.

The recorded initial customer package was narrower than the expanded platform: one Windows workstation and bounded sources/formats. Two-person company architecture is the current engineering target; it does not silently amend price, contracted source counts, delivery dates or service levels.

## 4. Architecture and what each component contributes

```text
Desktop A: staff A, private Bud context, local files/browser/computer tools
        │
        ├── local authenticated connection ──┐
                                            │
Desktop B: staff B, private Bud context      ▼
        └── encrypted connection ──► Company service on desktop A
                                            │
                                            ├── Shared PostgreSQL
                                            └── Managed service gateway
                                                operated outside customer devices
                                                ├── Model access and usage control
                                                └── Composio project and permitted accounts
```

This is an intended responsibility map, not a diagram of a fully implemented deployment. The company host remains a staff workstation. It should own shared data and job coordination through a background service. A separate vendor-operated gateway is needed for credible master-key protection and paid-service enforcement; local company hosting and off-device service access solve different problems.

| Component | Role and current direction |
| --- | --- |
| **RealBud** | Owns the application, identities, job lifecycle, permissions, human decisions, source/effect receipts, recovery and one business clock |
| **Hermes** | Stock headless execution engine behind Bud. Retain useful reasoning, file/code/terminal/browser tools, personal memory and reusable skills through admitted interfaces. Do not fork/patch upstream or ship a second Hermes application/scheduler. Separate profiles alone do not establish OS isolation. |
| **QM** | Source of useful scoped-data, grant-revision and claim/fencing patterns. The recorded D02 decision implements those semantics in RealBud-owned PostgreSQL modules. It does not import QM's CLI, daemon, scheduler, worker pools or a complete second agent platform. “QM integration” currently means this bounded adaptation. |
| **PostgreSQL** | Durable company records, memberships, explicit scopes, revisions, work ownership and receipts through the trusted company service. Staff desktops/workers should not receive reusable database credentials or arbitrary SQL access. |
| **Composio** | Native connection lifecycle for tools/services. One managed project key can support distinct member identities and connected accounts. Bind the authenticated person to exact permitted accounts, resources and operations; the project key is not a user identity. |
| **Cua Driver / companion** | Execute authorised computer actions in the intended local interactive desktop session. Prove device/session binding, permissions, Stop/takeover and native Windows/macOS behaviour. A sandbox computer is not automatically a staff desktop. |
| **Browser and website-to-CLI utilities** | Useful browser/file/session utilities and reviewed generated connectors under the same job authority. Protect cookies and credentials; bind selected browser/tab/account; do not turn recorded sessions or generated code into an uncontrolled execution route. |

The release used by a device is the admitted version in the actual runtime/packaging manifests. “Use the latest” means detect and qualify compatible stable releases, verify exact artifacts, stage safely and activate with recovery/rollback. It does not mean blindly follow upstream main or overwrite profiles whenever a vendor publishes a release. Review current official dependency support before changing versions; historical version notes are not current compatibility proof.

## 5. Private work, shared work and service administration

**Private by default:** conversations, personal preferences, Hermes memory and working files, local Desk preparation, personal connected accounts, browser cookies and desktop sessions.

**Shared deliberately:** reviewed results, requests for review, selected evidence/artifact copies, named handoffs, permitted company/case records, reviewed workflow templates and explicitly granted company app connections. Sharing a result does not share its entire chat, source account, local folder or execution authority.

A shared item needs a named audience, purpose, usable source references, current permissions, revision/history, explicit responsibility and a next action. If a colleague lacks source access, a sender-only filesystem path is not an attachment. Either provide an explicitly selected permitted copy or show that access is missing. Business obligations need reassignment/continuity when a person is absent or removed, without opening that person's private conversations to the company owner.

Keep three separate roles:

| Role | Intended authority |
| --- | --- |
| **Staff member** | Own work and accounts; explicitly permitted shared work; local computer consent |
| **Company owner** | Company membership and permitted operational administration; not automatic access to private chats or vendor keys |
| **Service administrator / product operator** | Technical configuration, managed provider credentials, installation support and service controls; not staff impersonation |

The source now has **You → Service administration**, unique per-installation administrator password provisioning, salted verifiers, expiring renderer-scoped sessions, server checks and hidden credential editors. There is no intended universal password. The company subscription and each desktop's service-admin password are different concepts.

**Critical business boundary:** hiding settings or placing a signed grant on a customer-controlled machine cannot reliably protect master keys or enforce payment against its OS administrator. Master provider/Composio keys and authoritative subscription checks belong at the vendor gateway. Future devices receive scoped access. Suspension should deny subsequent paid admissions, including resumed/queued work, while preserving saved-work access, export, recovery and Stop. In-flight external operations need explicit handling and retained receipts. Billing integration and that gateway remain unfinished.

## 6. Independence, automatic setup and recovery

“Independent desktops” means separate usable workstations and execution contexts; it does not promise complete offline service operation. Shared records require the host. Managed AI/app access requires the relevant network and service authority. When a dependency disappears, preserve work and explain what is unavailable. Do not silently switch accounts, devices or company authority.

The intended setup should discover prerequisites, install verified components, persist progress and resume safely. It must handle interrupted downloads, full disks, denied permissions, conflicting ports/processes, partially created hosts, repeat invitations, lost responses and incompatible upgrades. Human sign-in, MFA and OS privacy consent remain human steps.

Recovery has distinct levels:

- Recheck a connection and reload current state: safe bounded reads; now improved in source.
- Repair an admitted component or restart an owned service: preserve data and profile, prevent overlapping instances, report readiness from checks. Complete installed behaviour is still open.
- Recover uncertain jobs/effects: reconcile durable evidence and obtain any needed decision; never blindly replay an external action.
- Recover corrupt data, restore a backup or replace a host: preserve originals, verify consistency and fence the old host so two authorities cannot execute the same work.

“Self-healing” must not mean deleting profiles, hiding corruption, granting permission, weakening certificate checks, installing unknown software or repeating an uncertain action until it appears successful.

## 7. What exists and what has actually been proved

This is a dated reading of project source/status and saved receipts, not a fresh rerun of all suites. Counts overlap across checkpoints and must not be added into a product-completion percentage.

| Layer | Recorded evidence | What it does not establish |
| --- | --- | --- |
| Existing product | Desk, Ask, Schedule, You; local preparation, approvals, receipts, packs, job/recovery and worker integration code | Complete managed company execution or all proposal workflows on both installed devices |
| Company foundation | Real PostgreSQL/TLS tests for scopes, private access, revisions, claims, enrollment, revocation and restart; a recorded 516-test dedicated company checkpoint | Complete data migration, worker confinement, enrolled desktop execution or one authoritative shared workflow pipeline |
| Physical Macs | Earlier 15-check synthetic two-Mac browser test-kit rehearsal for separate profiles, shared storage, joining and restart | Customer installers, current-source native peer execution, full background lifecycle or Windows operation |
| Reviewed sharing | Named, reviewed text sharing/review/handoff primitives, recipient responses, current grants and read-only controls | Complete source/artifact handoff, accepted responsibility, offboarding continuity and recipient Bud execution |
| Local model workflows | Recorded real-model synthetic accounts rehearsal: 110 checks across seven preparations; later corrected-profile document/inbox evidence in the operational report | Two physical private workers, live end-to-end mailbox/bank acquisition or actual customer acceptance |
| Managed settings | 220 tests in 14 files; separate HTTP installations, generated administrator credentials, session expiry, renderer/UI checks, local signed-grant admission | Hosted billing enforcement, remote gateway, packaged installation of this slice or native Windows acceptance |
| Latest recovery slice | 74 focused tests plus four real PostgreSQL/TLS tests on one Mac; browser outage → reconnect → revoked-member checks; typechecks/build | Automatically repairing/restarting a failed host, physical peer operation or fresh installed release |
| Live connected services | Prior Gmail/Calendar metadata/access checks in an existing profile; isolation checks for distinct provider users | Completed OAuth and authorised execution for two real members; the existing legacy accounts were not proved as two separately owned member connections |
| Windows | Source, packaging configuration and platform-specific implementation/tests exist | An installed Windows 11 host/client/interactive computer-use acceptance run |

The latest source changes have not been packaged and installed on both Macs. Recent Screen Sharing returned a desktop image but no visible response to remote input; this is an access/proof gap, not evidence that the physical Mac is necessarily locked.

The active register contains **65 contracts: 1 verified, 18 in progress and 46 planned**. The one verified task is the bounded QM reuse decision. “Planned” can coexist with reusable partial code; it means the full contract is not accepted. The 71-case operational catalogue is a coverage plan with open end-to-end acceptance, not 71 completed office journeys.

Development uses a shared, heavily modified checkout: branch `codex/company-core-foundation`, base HEAD `058aceabe04aed77c285f2f52f7803fc19bc7ee9`. HEAD alone does not identify the current application. A technical reviewer needs the intended dirty snapshot or its exact manifest and relevant untracked files; do not reset the checkout or review only HEAD and assume it is current.

## 8. The missing integration, and recommended order

The central unfinished path is:

**authenticated person → company/work scope → managed service grant and exact app account → private Hermes worker → permitted file/browser/computer on the intended device → durable result and human review.**

Existing Desk/Ask/Schedule work remains principally local. Shared company primitives and reviewed text items do not yet complete that path. The solution should share explicit operational objects while keeping personal work private, rather than making every local store company-wide.

| Order | Outcome to complete | Proof that should close it |
| --- | --- | --- |
| 1 | Reconcile the two-person scope, supported OS/architectures, authority contracts and deployment assumptions | A short decision record and requirement-to-code/test crosswalk; identify unresolved external facts without inventing them |
| 2 | Member/device/source bindings and vendor-operated managed access | Separate accounts under one project, no master keys in clients/workers, wrong-person/device/account denials and actual service suspension/revocation checks |
| 3 | Guided host/join installation, private worker provisioning and native capability admission | Clean setup, interrupted setup/resume, correct private profile, permitted local file and computer run on each supported OS |
| 4 | One complete two-person bill handoff through the actual execution path | A prepares → explicitly shares usable evidence → B accepts and uses their own Bud/device → B returns reviewed output → A reviews; private canaries remain private; restart and Stop work |
| 5 | Complete all three workflows and included assistance through that same path | Actual acquisition, coverage, correction, durable follow-up, reviewed output and authoritative-system checks for both people |
| 6 | Host/service lifecycle, migration, backups, update/rollback, capacity and departure | No duplicate owner after recovery; retained records/memory; verified restore; safe member/device removal; measured normal-PC behaviour |
| 7 | Installed release and office acceptance | All host/client OS combinations, signed artifacts, actual interactive devices, agreed office sources and operating handover |

The reviewer should challenge this order where evidence supports a better dependency sequence. Lifecycle and isolation design must begin early; the table is not permission to defer them until an unsafe build has shipped. A single workflow proves the common path first, but does not replace the remaining product scope.

## 9. Questions and blind spots for a broader review

Review from the perspectives of staff, colleague, owner, service operator, installer, support person, security reviewer and departing member—not only an assistant's successful chat response.

- **Product and complexity:** Does each feature support a real office outcome? Which existing components should be connected rather than rebuilt? What can wait without weakening the core? Are organisation management and shared memory being overbuilt?
- **Commercial operation:** Who activates a company/device, pays usage and receives support? What happens on overdue payment, gateway failure, budget exhaustion, lost administrator credentials, account closure or service sunset? Saved customer work must remain recoverable.
- **Trust and privacy:** What can an ordinary member, company owner, device administrator and vendor operator actually see/do? How are legacy private records assigned, same-installation identity switching handled, warm worker contexts revoked and support bundles redacted?
- **Host resilience:** What happens when the host sleeps, quits, updates, loses power/network, fills its disk, is replaced or returns after a restored host started? Is there a verified backup/recovery objective and a single active authority?
- **Desktop control:** Is the correct logged-in OS session controlling the exact app/tab/account? What about locked screens, UAC/permission dialogs, multiple displays, changed UI, user takeover, driver mismatch, crashes and lost Stop acknowledgements?
- **Connections and work:** What about cancelled OAuth, multiple accounts of one service, pagination failure, stale schema, revoked consent, partial acquisition, duplicate triggers, late responses and unknown external results? Can raw shell/browser/generated-CLI routes bypass the same restrictions?
- **Data and packs:** Are dependencies portable and verified, not just plan text? Do imports remain dormant? Are source versions, local paths, symlinks/reparse points, ambiguous ownership, damaged records, currency/CSV formatting and backup compatibility handled?
- **Scheduling and load:** One clock, time zones/DST, sleeping devices, missed runs, shared-source duplicate prevention, fair capacity and clear next action. What is actually measured on an ordinary client PC?
- **Usability and access:** Can a nontechnical person install, join, connect, understand a hold, cancel, correct, recover and leave? Does keyboard/screen-reader use work? Are advanced settings hidden without hiding source/account/device facts needed for a decision?
- **Evidence and delivery:** Are test claims tied to source/build, real identity, OS/architecture, device, account and final persisted state? Are customer scope, licensing, signing, distribution, supported versions and support responsibilities clear?

Unresolved deployment facts include actual staff/device inventory, Windows architecture, host uptime/network arrangement, office source grants/formats, ready-by schedules, reviewer responsibilities, exact templates/phone route, gateway/billing environment and backup/recovery requirements. Engineering can use explicit synthetic assumptions; production acceptance needs real answers.

## 10. Acceptance target and reading map

Two people install the supported release. One sets up the company and the other joins. Each signs in independently, connects their own accounts and completes the three workflows on their own authorised computer. They can share selected work with clear responsibility, stop it, restart/reconnect, recover and offboard without mixing private data or duplicating effects. Normal use and support do not require developer intervention for routine tasks.

Test Windows-host/Windows-client, Windows-host/Mac-client, Mac-host/Windows-client and Mac-host/Mac-client. An interactive Windows VM can supply bounded Windows evidence; macOS mocks, cross-compilation and a Windows CI file do not. Record architecture and distinguish a VM from the client's actual environment. Two physical Macs are available, but fresh controllable access is still needed for the current peer candidate.

Preserve the current no-send, no-pay, no-sign, no-trust-money and no-statutory-draft boundaries. Human-approved attended prefill does not become permission to submit every action. Exact existing portal/job rules remain authoritative. Any proposed change to these boundaries needs a separate product decision.

Repository reading map (these paths require the checkout; the small handoff ZIP does not contain the repository or raw test logs):

1. `AGENTS.md`, `docs/GOAL-PROMPT.md`, `DESIGN.md` — stable constraints and product direction.
2. `docs/REALBUD-SELECTIVE-SHARING-2026-09-15.md` — latest private-by-default/two-person sequencing decision.
3. `docs/REALBUD-CORE-EXECUTION-2026-09-14.md` and `.json` — active 65-contract register and remaining gates.
4. `docs/REALBUD-CORE-MASTER-IMPLEMENTATION-2026-09-14.md` — broad implementation contract; reconcile older expansive language with later selective-sharing decisions.
5. `docs/REALBUD-QM-REUSE-DECISION-2026-09-14.md` — exact bounded QM choice and provenance.
6. `docs/REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md`, `docs/REALBUD-NATIVE-INTEGRATIONS-2026-09-14.md`, `docs/PORTAL-WORK.md` — execution, integration and attended-job boundaries.
7. `docs/REALBUD-SERVICE-ADMINISTRATION-2026-09-15.md` — administrator UX, provisioning and gateway limits.
8. `docs/REALBUD-UPDATE-STRATEGY-2026-09-14.md`, `docs/REALBUD-HERMES-UPSTREAM-2026-09-12.md` and actual runtime/package manifests — release admission and preservation.
9. `docs/REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.md` and `.json`, `docs/REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md` — 71 cases, journeys and device gates.
10. `outputs/realbud-operational-coverage-2026-09-15/README.md`, `outputs/realbud-service-administration-2026-09-15/receipt.json`, `outputs/realbud-connection-recovery-2026-09-15/receipt.json`, and the referenced physical/native reports — dated results and limits.

The desired review output is a justified gap analysis, a simpler architecture where possible, a prioritised implementation sequence with acceptance evidence, and one repository-ready execution prompt. Do not return another broad feature wish list or call this product ready from test totals.
