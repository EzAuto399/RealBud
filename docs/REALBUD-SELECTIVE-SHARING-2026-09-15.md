# RealBud: private work and deliberate sharing

The user approved private staff workspaces with optional sharing of reviewed work. Joining the same company connects membership, managed service access and permitted operational records. It does not merge Desks, conversations, Hermes memory, browser sessions, local folders or personal Composio connections.

## Product decisions

| Object | Default | Deliberate sharing |
| --- | --- | --- |
| Ask conversation, personal memory, working files | Private to the person | Share a selected, reviewed result; never the whole conversation or folder implicitly. |
| Personal Desk preparation | Private | Create a shared result, review request or handoff with a named audience. |
| Department/company case | Visible only to its granted participants | Preserve ownership, decisions and history through handoffs; business continuity must not depend on one person's chat. |
| Workflow template | Company publication with owner review | Each recipient imports a dormant copy; execution permissions and scheduling need their own approval. |
| Composio account | Individual account owner under the managed project | Company app connections require explicit grants; sharing a result does not share an account. |
| Desktop, cookies and source files | Owned by the signed-in user/device | Require a separately authorized device/source operation. A company join or work handoff is insufficient. |

Keep Desk for work, reviews, exceptions and recovery. Properties are linked context, not a mandatory parallel portfolio. Keep one Bud persona per user's context and one RealBud authority for jobs and scheduling. A shared business brain remains optional.

## Implementation sequence

1. **Reviewed work slice — implemented and locally verified.** A person creates a reviewed text result, review request or handoff for named colleagues; recipients see it on Desk and respond; the sender can close the collaboration. Current membership and grants are checked at the service boundary. Retries must not duplicate work, stale edits must not overwrite responses, and private source records stay untouched.
2. **A usable handoff between two named people.** Add selected source references, explicit acceptance and one responsible person, a short durable activity history, and withdrawal/reassignment. Start with the source type needed by the first proposal workflow; do not build a general file-sync system. A reference identifies evidence but grants no access. A recipient must have independent access or receive an explicitly selected copy with its source/version recorded. Local paths on the sender's computer are not usable attachments on the recipient's computer. Define continuity before disabling the current responsible member; an administrator does not gain personal conversation access. A closed review is not proof the underlying business action completed.
3. **The recipient uses Bud on their own desktop.** First resolve company, member, device, private Hermes home and permitted connections at the authoritative execution boundary. Use distinct member-owned Composio identities under the managed project and enforce the service grant at the model/tool gateway. Then let the recipient explicitly attach a currently permitted work item to private Ask, prepare a result, review it and return selected output to that item. Recheck source and work access at execution, not only when opening the card. Keep existing job approval, cancellation, recovery and computer fences; joining or accepting a handoff does not authorize remote control. Do not auto-read all shared records into memory.
4. **Reliable operation and recovery.** Use the existing durable job controller and one clock. Show which member/account/device will act and whether the required source, service and desktop are available. Distinguish waiting, running, awaiting review, failed and outcome unknown. Do not retry an uncertain external effect blindly or switch to another person's account/computer as a fallback. Verify host sleep/restart, backup restoration, member removal, account revocation, simultaneous work and a cancelled worker before broadening workflow coverage.
5. **Installed acceptance.** Run the three agreed proposal workflows with two independent profiles, each person's own app accounts and local files, on installed Macs and Windows. Test host sleep, restart, revoked membership, disconnected accounts, stale permissions, duplicate triggers and recovery. Local database/browser evidence does not pass this gate.

The active [65-task register](REALBUD-CORE-EXECUTION-2026-09-14.md) remains the overall delivery contract. This decision narrows “shared workspace” to explicitly scoped work; it does not mark the managed execution, device or installer tasks complete.

## Two-person pilot scope — clarification, 15 September

The [71-case operational acceptance catalogue](REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.md) expands the verification protocol across the three workflows, roles, accounts, devices, recovery and accessibility. The [follow-up run](../outputs/realbud-operational-coverage-2026-09-15/README.md) fixes view-only action affordances and a bounded file-read limit, with real-model preparation evidence. It does not complete shared worker execution or installed two-device acceptance.

Steps 2 and 3 are the next two implementation outcomes. Build a complete fictional bill handoff through those outcomes before expanding organisation management. Preserve the requested breadth of Hermes, Composio, local-file and computer capabilities; use one workflow to prove their common execution boundary first. This is sequencing, not removal of the other proposal workflows or platform requirements.

| Needed for this pilot | Can wait for demonstrated demand |
| --- | --- |
| Named recipient, clear responsibility, explicit acceptance and a usable selected source | Department administration screens, role designers, department dashboards and bulk sharing |
| Private member/account/device binding, current access checks and managed service enforcement | A shared business brain, autonomous agent organisation or additional scheduler |
| Minimal activity history, revocation, reassignment and recoverable jobs | A general document library, automatic folder mirroring or a replacement CRM/portfolio |
| Installed host/join, both users' independent app connections, restore and both-OS proof | Company-wide automatic ingestion and collaborative editing of every private Desk record |

Existing department grants may be reused underneath named sharing; departments need not be a setup requirement. Show the person, requested outcome, next action and source availability on the work card. Put account/device detail beside the action when it affects the decision, and offer recovery where the problem occurs. Keep Desk, Ask, Schedule and You as the navigation.

### Blind spots that must remain explicit

- **Operational ownership versus personal privacy:** a shared company obligation needs continuity when its responsible person is absent or removed. Keep private chat and memory private; transfer only the permitted work and evidence. Current sender-only close is insufficient for offboarding continuity.
- **Identity switching:** clearing the shared-work panel does not prove that all legacy local Desk/Ask data is isolated. Separate application data directories remain the current desktop boundary; test every launch/surface before promising same-installation multi-member privacy.
- **Independent execution:** a successful shared database connection does not establish a working peer Hermes profile or a second member's Gmail/Calendar authorization. These need real provider and native-device checks.
- **Host availability:** a sleeping or unavailable host cannot coordinate new shared actions. Define visible waiting/reconnect behaviour and prove restoration from a backup; do not silently execute a second local copy of a scheduled job.
- **Billing authority:** hiding keys behind service-admin settings is useful access control, but cannot protect a master secret against the administrator of the computer that stores it. The managed gateway must independently enforce entitlement and usage; peer desktops should receive scoped access rather than master keys. The current local entitlement consumer explicitly does not claim this gateway enforcement.
- **Evidence versus completion:** a model's answer, closed review or successful button click does not establish the business result. Save the actual adapter result/source reference and expose partial or uncertain outcomes.

### Next vertical acceptance check

1. Accounts selects a fictional bill and asks Property for a specific review. Preview identifies the selected evidence, recipient and requested outcome.
2. Property sees the item, accepts responsibility, and opens it with Bud on the second desktop. No private Accounts conversation, account credential or unrelated local file becomes accessible.
3. The launch resolves Property's authenticated identity, private Hermes context, approved source and intended account/device. A missing or revoked permission produces a clear repair action; there is no fallback to Accounts' access.
4. Bud prepares the review. Property reviews and deliberately shares the chosen result back; durable history identifies the actor, source/version and actual result. Completing this review does not pay, send or post the bill.
5. Repeat with concurrent opens, a lost response, restart, revoked source access and an unavailable responsible person. There must be one current responsibility and no duplicated external effect; unknown outcomes require reconciliation before retry.
6. Repeat on installed devices. A Windows VM can establish Windows guest behaviour; macOS simulations cannot prove Windows native accessibility, installer or computer-driver behaviour. Record each environment separately.

This clarification changes the implementation order only. No runtime change, new test pass or completed milestone is claimed here.

## Checks for the reviewed work slice

- Accounts shares a fictional bill summary to Property. Only the chosen text and audience appear; neither person's private canary note appears.
- Property reads and responds from a separately configured application through pinned TLS. The original summary remains unchanged.
- A company owner who is not a participant cannot read or change the item.
- Two retries with the same request identity create one record. A changed retry is rejected.
- Concurrent responses accept one current revision and explain the conflict to the other request.
- Sign-out or switching company/member clears the visible content and rejects late results.
- A restarted joined application can sign in and recover the current shared item.
- Removed grants or revoked membership stop subsequent reads and writes.
- Browser checks cover preview, confirm, recipient response, close, errors and identity switching at narrow and wide widths.

## Delegation and review

Two actual Grok CLI packets use the requested `grok-4.6` model with `xhigh` reasoning: backend persistence and frontend sharing controls. They receive bounded reference source, no credentials and no tool access. Codex owns the public contract, HTTP/TLS integration, cross-profile acceptance and final review. Completed packets must have a CLI end receipt and parsed deliverable; elapsed time or partial text is not completion. A separate Grok review follows integration.

[Verification, test guide and remaining limits](../outputs/realbud-selective-sharing-2026-09-15/README.md): 514 local tests plus a rendered synthetic two-profile walkthrough. No new installed-device or Windows acceptance is claimed.
