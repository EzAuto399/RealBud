# RealBud end state

Latest continuation: [setup, team and website integration QA](INTEGRATION-QA-2026-09-23.md) records current source checks, two-instance testing, isolated website integration, hosted authentication boundaries and fixture repairs. Read its remaining proof gates before describing readiness.

Previous continuation: [macOS and Windows candidate](PLATFORM-CANDIDATE-2026-09-23.md) tracks the isolated source candidate, native process and launcher fixes, current checks, installer artifacts and distribution gates. The [earlier Windows preparation](WINDOWS-READINESS-2026-09-23.md) retains the previous installer and rejected timeout approach as dated evidence.

Previous continuation: [Readiness and Modelvia gap fixes](READINESS-GAPS-2026-09-23.md) records 41 settled live API checks, actual-worker local failure paths, the readiness and provisioning fixes, bounded PDF bill reading, browser verification and the remaining account/device/deployment gates. These evidence layers do not establish universal readiness.

Updated 21 September 2026 from the owner's clarification. The [architecture decision](decisions/2026-09-21-business-os-and-austin-workflows.md) defines the detailed workflow and security contracts. The [17 September snapshot](history/END-STATE-2026-09-17.md) remains historical evidence.

Current owner clarification, 23 September: [core first, then workflow packs](decisions/2026-09-23-core-first-and-workflow-scope.md). The bank workflow ends at CSV for now; REI acceptance is deferred. The [core readiness checkpoint](CORE-READINESS-2026-09-23.md) records present gaps and verification without claiming universal readiness.

## The product

RealBud is a business work operating system that can stand alone and expand through customer workflows. It supports a solo user, an office with shared work and departments, and private work that remains private when a person joins or leaves. The desktop runs on the customer's operating system; Hermes works behind the RealBud interface.

Austin Realty is the first concrete workflow pack. Prove the reusable core with an empty workspace and a fictional generic job before building and testing these customer workflows. Future customers should be able to add their own supported sources, business rules and work views without rewriting authentication, approvals, persistence or recovery.

## What a person should experience

Open RealBud and see what needs attention, what is waiting for someone else and when the sources were last checked. Open a task to see the evidence, proposed action, owner and next step. Review a bank batch with explained changes; inspect expected bills and actual due dates on the calendar; resolve a blocked connection without understanding an API key.

The office owner can organize departments, membership, shared workflows and work views. Each member can personalize allowed tabs, layouts and filters. Hermes can propose a change, show its effect and help apply it through the same validated controls. Every change can be understood and recovered without editing privileged application code.

## The reusable system

| Core responsibility | User-visible outcome |
|---|---|
| Identity and scoped records | Private work stays private; shared work is visible only to the right office/department members |
| Work items and source evidence | One reliable record for each job, bill or follow-up, with linked evidence and preserved human decisions |
| Review and action authority | The user can see what will happen, approve the exact effect when needed and inspect the actual result |
| Calendar and scheduling | Expected events, verified deadlines and recurring work use the office timezone and show freshness/missed work |
| Durable execution and recovery | Restarts, duplicate clicks, offline periods and lost responses do not silently duplicate external effects |
| Versioned workspace definitions | Useful custom views/workflows can be added, tested, disabled or reverted without losing business records |
| Managed services and lifecycle | Core/provider credentials remain controlled by RealBud; connections, devices and service access can be revoked and retired |

## Austin's first complete workday

1. The approved bank export becomes a preserved source artifact. RealBud applies reviewed CSV/reference mappings where configured, holds uncertain rows and delivers the reviewed CSV. REI upload, recognition, import and posting are outside the current stage.
2. Approved email history supplies proposed bill facts and recurrence patterns. Confirmed facts become source-linked bill occurrences. Predicted arrival and verified due dates appear distinctly in the RealBud calendar, with missing or overdue work visible. Gmail is an existing adapter; other providers require their own implemented and verified connections.
3. A configurable morning scan maintains today's ranked work and unanswered follow-ups. Human edits survive later scans. The desk shows when the account was checked and whether the scan was incomplete or missed.

Bank login/MFA, source-account consent and consequential action approval remain understandable user interactions. Composio project/organization keys and provider administration never become customer workspace settings.

## Hosting and customization boundary

Vendor-only secrets must live outside customer-controlled code and storage. A managed connector broker issues limited authority and enforces source, tenant, member, installation and workflow permissions. The current local project-key configuration is an implementation gap, not the target custody model. The website account portal, connector service and model gateway have different responsibilities even if hosted by the same operator.

The website can request Morning priorities or a published preparation on an explicitly opted-in private workspace. A person on that computer reviews the exact current plan before existing local execution; the portal receives bounded durable status. Pairing/reporting alone grants no execution authority. The [stable portal identity prerequisite](PORTAL-IDENTITY-2026-09-22.md) now binds verified provider subjects to immutable provisioned people and invalidates old sessions after account changes. Its actual Next/PostgreSQL/browser verification passed locally, using fictional provider responses. Hosted migration and live sign-in are unproved. The subsequent [attended enrollment checkpoint](REMOTE-APPROVER-ENROLLMENT-2026-09-22.md) adds named workspace permissions, exact local disclosure-template consent and revocation recovery, with actual desktop/portal/database verification. Enrollment does not itself publish private work or start it. The [remote work checkpoint](REMOTE-WORK-2026-09-22.md) now adds explicit sharing opt-in, complete reviewed publication, portal decisions and online claims for both existing private-workspace executors. Source and isolated compiled application flows exercise lost replies, actual process death before/after enqueue, inert restore and revocation. Shared-department execution still requires an explicit company-member/host binding and current department-case authority; it cannot inherit authority from the private-workspace grant.

A managed connector service changes which selected source data leaves the machine. State that flow and retention honestly before rollout; the earlier blanket claim that connector credentials always remain local is superseded. Preserve local-first records where appropriate without promising that cloud model/connector operations are offline.

## What is proved, and what comes next

Previous continuation: [Modelvia, security and workflow QA](MODELVIA-QA-2026-09-23.md) now records successful isolated live API tests after the earlier expiry/release blockers: four fictional workflows and clarified streaming, six settled requests, contract-2 prices and confirmed cleanup. One initial exact-text streaming failure remains preserved. Ongoing RealBud account/mapping, customer workflow and device acceptance are not established by these API tests; the packet also records the signed Mac candidate and local security/UIUX fixes.

Previous continuation: the [product and operations spec and status for 23 September](PRODUCT-OPERATIONS-SPEC-2026-09-23.md) records setup by browser link instead of a typed code, one join code for a second computer, Modelvia recovery and cap sync, Hermes worker efficiency, website billing clarity, a support file, Windows installed-service start-up (4.1 s after removing PowerShell cmdlets) and product-created private data on Windows, each with its evidence tier and what is still open.

Previous continuation: the [company-member identity binding](COMPANY-PORTAL-BINDING-2026-09-22.md) now connects verified portal people to actual company membership through attended acceptance/confirmation. It includes exact retry recovery, certificate-rotation fencing, terminal disconnect and restore invalidation. Source and compiled application flows pass across the actual desktop, website and two disposable databases. Final focused checks pass 185 application tests, 70 website tests and 63 website SQL assertions. Department execution still needs independent case admission, scoped source/provider checks and suitable background delegation; mapping alone cannot authorize it. Native installers and live office/customer acceptance remain open.

The earlier [reviewed instruction history receipt](SKILL-HISTORY-ARCHIVAL-2026-09-22.md) adds retained older instructions, bounded browsing, exact reviewed revert, interruption recovery and complete encrypted backup graphs. The full default suite plus the separately enabled native Hermes cases records 4,617 unique passing tests, zero failures and 149 remaining environment-gated skips. The unsigned Mac candidate passes four actual archival/revert/crash GUI groups, native startup and fresh private-profile checks. The subsequent [two-device evidence-gate repair](TWO-DEVICE-EVIDENCE-GATE-2026-09-22.md) recovers all 71 cases, explicitly formalizes the missing participant policy and adds strict receipt validation plus QA/CI wiring. This verifies the checker only; it does not add installed-device observations. Enrolled-person setup is now covered by the later enrollment checkpoint. The later private remote review/approval/claim capability is recorded above; shared-department execution remains unfinished.

The previous [website requests receipt](WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md) adds the complete request/local-review/executor/status path for two operations, v1/v2 restore invalidation, lost-response recovery and pre-dispatch SIGKILL proof. The final full suite passed 4,574 tests with zero failures and 149 environment-gated skips. The fresh unsigned Mac artifact passes five website-request groups, eight managed-mail groups, native startup and private-profile checks. Exact source, packaged and portal evidence is recorded there. The previous [history archival receipt](PACK-HISTORY-ARCHIVAL-2026-09-22.md) retains its immutable archive, rollback and mid-write recovery evidence. Remote approver enrollment was completed in the later checkpoint; department adapters, Windows and external customer commissioning remain separate gates. The earlier [pack and managed-mail receipt](WORKFLOW-PACK-UPGRADES-MANAGED-MAIL-2026-09-22.md) retains its two-agency fictional-provider evidence.

The [reusable core implementation](REAL-ESTATE-CORE-2026-09-21.md) now records the connected host mail collector, durable morning priorities, generic office pack, custom saved tabs, source-linked bill review/calendar and byte-preserving bank review. Managed connector custody and subscription checks are implemented behind a protected server boundary. These local implementations and fictional-provider rehearsals do not establish deployment or installed-customer acceptance. The earlier [desktop receipt](BUSINESS-DESKTOP-2026-09-21.md) remains the departments/service/recovery baseline. The current core report also records encrypted private backup/restore, permanent execution histories, department case lifecycle and packaged native Mac GUI checks. Windows memory storage and journal integration are implemented as a held candidate with local fault tests. The [memory recovery/profile follow-up](HERMES-MEMORY-RECOVERY-PROFILE-2026-09-22.md) adds signed staff closure, missing-evidence holds and private configuration provisioning, with a fresh unsigned Mac package and rendered checks. Actual Windows, installed workflow and office acceptance remain separate gates.

Complete the reusable core's authoritative records, UI, execution, extension lifecycle and recovery before customer-pack acceptance. Prove solo and office behavior, backups/restore, permission revocation and product retirement/export. A customer rollout then requires the supported installed platform, real source-account and scoped workflow acceptance, and observed daily operation. REI integration is deferred. Keep each proof layer explicit.


September 22 continuation: [department execution authority](DEPARTMENT-EXECUTION-AUTHORITY-2026-09-22.md) now supplies scoped background grants, recoverable case admission, renewable ownership, current selected-case source checks and inert restore. Its real database/TLS and compiled-module evidence is separate from actual worker/website/UI integration, which remains next. This checkpoint does not change the full end-state or native/live acceptance gates.
