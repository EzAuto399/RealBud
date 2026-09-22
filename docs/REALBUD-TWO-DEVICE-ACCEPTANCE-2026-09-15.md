# RealBud two-device completion and acceptance plan

Date: 15 September 2026. This is an execution and coverage plan, not a new passing test report. It supplements the [active 65-task register](REALBUD-CORE-EXECUTION-2026-09-14.md); it does not promote its statuses or expand the customer agreement.

## Latest bounded recovery check

[15 September recovery report](../outputs/realbud-connection-recovery-2026-09-15/README.md): source now observes host availability automatically and recovers the Company view without re-pairing or replaying writes. A real PostgreSQL/TLS host outage test keeps the same peer, preserves shared revisions and separate local file canaries, and resumes after host restart. This is local integration proof. Complete per-device onboarding, automatic component repair, background services, managed Bud/Composio/Cua execution, installed peer and Windows acceptance remain open. The operating model and next implementation gates are listed in that report; neither desktop is promised full offline service access.

## Current checkpoint

The [15 September operation report](../outputs/realbud-office-operation-2026-09-15/README.md) records the subsequent actual checks and fixes. The practice host was resumed; use its current session receipt because loopback ports change. The original planning review did not rerun live tests; the operation report now owns the later evidence.

| Layer | Evidence available | Remaining gate |
| --- | --- | --- |
| Company foundation | Real PostgreSQL scope, concurrency, claim, revocation and restart checks; physical two-Mac browser test-kit checks | Existing desktop workflows still use local storage/execution |
| Native encrypted join | Sep14 signed fix installed on Mac mini; installed helper reported encrypted company status | Retrieve complete peer receipt; verify native member sign-in, current candidate update and restart |
| Files and Bud | Peer selected spreadsheet survived unchanged with mode 0600; local model read synthetic DOCX/XLSX | Standalone helper profile-routing bug invalidates intended-profile attribution of earlier document runs. Source fix passes; configured model response, admitted peer worker and managed execution remain unverified |
| Departments | Six synthetic identities exercised company grants and case lifecycle through integration tests | Usable department/member management and shared Desk handoff |
| Connected services | Same-key REST/source checks separate the existing provider user from a new empty user; foreign account responses are refused | Existing Gmail and Calendar both belong to one legacy provider user. Complete actual second-member OAuth, acquisition, connection lifecycle and managed per-member execution |
| Windows | Packaging/installer smoke workflow exists in source | No current Windows 11 installed-device acceptance; CI configuration is not a run receipt |

The current source explicitly describes sharing as a preview: `server/company-host.ts` and `src/components/CompanySetupCard.tsx`. Existing Desk, Ask, sources and schedules remain local. The latest [structured result](../outputs/realbud-device-workflows-2026-09-14/result.json) records `officeReady: false`, no peer model proof and no shared managed model route.

## What connecting should mean

Confirmed service model: users have separate Composio connected accounts under one managed project/API key. Bind each authenticated RealBud member to its stable provider user identity and exact permitted connected-account IDs. The key identifies the project; it must never stand in for the person. Existing connections must retain their verified ownership through migration and key rotation. A shared company connection is a separate explicit grant.

The host computer remains a staff workstation. A background company service owns shared PostgreSQL, authorization, durable work ownership and the company clock. Each installed desktop has its own signed companion, device identity, private Bud context and local execution environment.

| Concern | Intended company behavior | Intended behavior on each desktop |
| --- | --- | --- |
| Identity | Authenticate a person, enrolled device and current grants on every operation | Display company, signed-in person and this computer; membership does not grant device administration |
| Desk | Shared cases, revisions, owners, review decisions and receipts | Personal and shared views with explicit audience; a shared case opens the same revision on both devices |
| Ask | Publish only the explicitly shared result or handoff | Conversations, preferences and personal learning stay private; a shared answer must not include private retrieval by accident |
| Schedule | One authoritative occurrence and claim for shared work | Show execution computer and readiness; an unavailable device holds the work visibly |
| Files | Store authorized artifact metadata and protected shared copies with provenance | A local path belongs to its computer. Selecting a file creates the approved copy; joining does not mount another computer's folders |
| App connections | Permit a specific company/member to use a specific account and operation | Personal Gmail, cookies, clipboard and browser sessions remain individually owned; a company connection is shared deliberately |
| Model access | Broker allowed usage with entitlement, budget and attribution | Worker gets scoped access, not master credentials; each computer needs its own admitted runtime/readiness proof |
| Computer use | Authorize the exact job, device and current scope | Run on the named desktop and verified account/window; retain local Stop and exclusive interactive control |
| Failure | Persist pending/uncertain work and reconcile before another attempt | Keep local drafts and explain which shared capabilities are unavailable; no silent switch to another desktop |

Four states must be distinguishable: **host reachable → member signed in → this device ready → this job permitted**. One green “Connected” badge cannot imply all four.

Local-only work may remain available without the host when it already has independent authorized resources. A job relying on company records, managed model access or company tools must hold when those dependencies are unavailable. A disconnected Stop request must say whether the executing device acknowledged it.

Joining a second desktop should not automatically synchronize private chats, copy cookies, expose Downloads, start schedules or run its mouse. If the same person uses two devices, any private-history continuation must remain authenticated to that person; execution resources still belong to the selected device. Another person signing into that computer must not inherit the previous person's context.

## Build order and exit conditions

1. **Finish the physical native join checkpoint.** The prior signed join fix is installed and its helper reached the host. Follow the [current next actions](../outputs/realbud-office-operation-2026-09-15/next-actions.md) to retrieve the complete receipt, install the next tested candidate, verify actual native member login and preserved files/packs, then restart both apps. Screen Sharing again returned `noWindowsAvailable`/timeouts; an AX window title was not proof of a locked Mac.
2. **Complete member/device and managed-service execution.** Bind every job/tool call to company, member, enrolled device, allowed account and current grants. Provision each supported Hermes runtime independently. Keep the service administrator separate from the company owner. Prove budgets, cancellation and revocation through the real managed route before enabling peer execution.
3. **Connect existing Desk, Ask and Schedule to company ownership.** Complete repository/migration wiring, artifact access, revision conflicts, one active worker claim, typed completion receipts and recovery UI. Preserve local records through a verified migration; do not create an empty shared workspace and call the migration finished.
4. **Finish the local capability boundary and connection UX.** Admit file/browser/terminal/Cua capabilities individually through the job broker. A separate Hermes home and safe mode do not establish OS-level confinement. Test helper tools as well as the primary Cua route. Connect/check/reconnect/disable must work while Bud is busy.
5. **Complete host operation and lifecycle.** Background service ownership, login/logout, sleep/wake, proper Quit behavior, backup/restore, host replacement, version compatibility and recovery. Resolve the observed native Quit process remaining alive before treating update/restart as reliable.
6. **Run the complete business journeys on installed devices.** First the two Macs; then actual Windows builds and interactive Windows 11. Promote each supported host/client topology only with its own receipts.

Service-key protection needs more than a hidden developer page. That page controls ordinary application users. An administrator of a customer-owned OS controls its local files and executable. Shared platform master keys and paid-service enforcement therefore belong in the managed service boundary outside that customer's control. Test that no staff worker, installer, exported pack or diagnostics bundle contains those keys. This does not require moving the company's PostgreSQL database to the cloud.

## First full office rehearsal

Use the retained fictional practice office. Computer A hosts and runs an Accounts member; computer B runs a Property Management member. Use a separate owner identity for membership/grant operations. Give both members the agreed workflow permissions, with a specific shared case scope and private canary notes. Do not reuse staff identities as service-admin credentials.

Reuse the [six-role scenario cards](../pack/testing/agency-day-examples.json) and [known importable packs](../outputs/realbud-agency-rehearsal-2026-09-14/README.md). The scenario-card JSON is not an importable workflow pack. Additional roles can be simulated for API isolation; label them separately from two physical users.

| Journey | Concrete exercise | Pass result |
| --- | --- | --- |
| Morning priorities | Each member requests a brief from their permitted mail/calendar and shared unfinished cases; one source is intentionally unavailable | Separate useful briefs, original source references and freshness/coverage warnings; unresolved work carries forward; no private cross-member content |
| Invoice and missing bill | Accounts imports a fictional invoice/expected obligation; PM receives only the reviewed handoff, supplies a missing fact, and Accounts reviews the new revision | One continuing shared case; both see the current owner/revision. Received, processed, arranged and independently confirmed paid remain distinct |
| Bank reference preparation | Select a synthetic ANZ-format CSV on B, review suggested references, save a new approved copy, then share that artifact with Accounts on A | Originals unchanged; dates, amounts, row order/count and untouched fields identical; ambiguous matches held; saved bytes verified. Real authorized ANZ acquisition and REI preview are separate later gates |
| File-based assistance | Give A and B different DOCX/XLSX files with hidden synthetic reference codes and the same filenames | Each Bud retrieves its own file/code through its own worker. Share one chosen result and verify the other member receives only that artifact |
| Calendar assistance | Read the specifically connected calendar on the other account; prepare an internal entry | Principal, calendar, time zone and proposed values are explicit. A write test requires the exact allowed one-use decision, no attendees/notifications, and persisted read-back; no write is implied by this plan |
| Attended computer work | On each device separately, choose a synthetic page/window, read a value, prefill an allowed field and Stop; then attempt independent jobs on both devices | Actions occur only on the assigned device/account/target; no unexpected host control. Stop is acknowledged, effect receipts match observed state and missing evidence stays partial |
| Handoff and recovery | Both members open the same case; try competing claims, then interrupt the owner while working and recover deliberately | Only one active owner; stale writes/approvals rejected; no duplicate external effect; recovery is understandable to the next member |
| End of day | Restart apps and host, sign back in, inspect unfinished work, then run the next occurrence | Private drafts/packs and permitted shared work survive; missed work is visible; one company occurrence runs; no duplicate catch-up |

These cover the core proposal outcomes of morning priorities, expected/missing-bill follow-through and reference preparation, with included file/calendar assistance. They do not settle the still-open customer account, format, reviewer and cadence crosswalk.

## Failure and edge-case checklist

All boxes below are **planned installed end-to-end acceptance**. Related earlier unit/API/test-kit evidence does not tick them automatically. Tests that need unfinished features are blocked by those features, not counted as passes.

| ID | Exercise | Required result |
| --- | --- | --- |
| T01 | Fresh host setup and join as a normal OS user | Clear prerequisites; usable company/member session; no developer terminal or master-key copying in the normal staff journey |
| T02 | Mistyped code, wrong host, changed certificate, unreachable network/firewall | Distinct actionable errors; untrusted host rejected; no global trust bypass or exposure of the local admin API |
| T03 | Setup interruption, full disk or port collision; retry after response loss | Existing profile/database retained; owned setup resumes; successful pairing is not duplicated |
| T04 | Expired/reused invitation, duplicate username, wrong password and member recovery | No accidental identity creation, enumeration or owner impersonation; supported recovery remains usable |
| T05 | Two devices share a display name; a profile is copied to a third device | Device identity and enrollment remain distinct; copied local state is not sufficient to inherit device authority |
| T06 | Sign out/switch member/company while a request or worker is active | Previous scope cannot produce a new result in the next person's view; stale sessions and ongoing action authority are invalidated correctly |
| T07 | Private canary notes, files and memory; shared prompt asks for all office information | Another member cannot retrieve them through API, search, Bud, logs, exports or shared summaries; same-OS-account limitations are documented |
| T08 | Read-only department user guesses a case/artifact ID or forges an audience | Authoritative service denies unauthorized access/edit; a hidden UI control is not the permission check |
| T09 | Revoke membership, device or source grant while tools are discovered/queued | Next protected action denied; cached tool handles and prior approvals do not retain authority |
| T10 | Same person on two devices; different person later uses one device | Person-scoped access consistent; local browser/file resources remain device-bound; no cross-person context reuse |
| T11 | Two people edit the same revision and claim the same occurrence | One accepted claim; stale edit gets a recoverable conflict, without silent data loss |
| T12 | Crash before action, after action, and after receipt persistence | Each phase has a defined recovery; uncertain external effects reconciled before retry; no prose-only success |
| T13 | Lost heartbeat/lease expires; old worker reconnects after handover | Old worker cannot act, renew or settle; intentional recovery establishes the only new owner |
| T14 | Manual run races a schedule, duplicate trigger/webhook or repeated click | One durable occurrence/effect; repeat response points to existing work |
| T15 | Source/account/device/output changes after approval | Approval becomes stale; require a new exact decision for the changed operation |
| T16 | Host sleeps, shuts down, restarts or loses the network | Both apps show useful degraded status; no busy retry loop; private drafts preserved; shared work resumes honestly |
| T17 | Peer sleeps/locks/disconnects while host is healthy | Its computer task pauses/holds; it is never silently moved onto the host desktop |
| T18 | Quit the UI, log out of the OS and reboot the host | Defined background service behavior; interactive computer work stops when its user session is unavailable; updater sees correct process state |
| T19 | Delayed scheduler, DST/time-zone change and clock skew | One company clock; bounded catch-up and truthful freshness/ready-by state; expired permissions cannot be revived by client time |
| T20 | Managed model/tool outage, exhausted allowance and revoked entitlement | Clear dependency/budget state and bounded retry; no fallback to another user's key, personal profile or uncontrolled model route |
| T21 | Restore backup to a replacement host while old host comes online | Verify records/artifacts/permissions, admit the replacement identity and fence the old authority; do not run two active company clocks |
| T22 | Mixed app/runtime/driver versions; interrupted upgrade and rollback | Compatibility check before work; profiles/memory retained; previous admitted runtime available; database rollback uses a compatible migration/restore plan |
| T23 | Same filename on both computers, renamed/deleted original and inaccessible folder | Artifact ownership/copy/digest resolves correctly; no assumption that a remote pathname exists locally |
| T24 | Unicode/long/reserved filenames, empty/corrupt/oversize Office file and spoofed format | Clear supported limits/errors, no path escape or partial file presented as ready; original remains untouched |
| T25 | Symlink/junction/reparse-point escape and mid-read file replacement | Worker/broker cannot follow a source outside its granted scope; native OS protections verified, not inferred from string checks |
| T26 | Double-select, cancel or navigate away while copying; app restart with attachment draft | No send before copy completion, lost attachment, wrong completion attached to a new draft, or unreported incomplete copy |
| T27 | File or webpage instructs Bud to read another user's files, upload data or reveal keys | Content cannot expand authority. Terminal, browser helpers and site-to-CLI routes obey the same enforced scope |
| T28 | OAuth completed in the wrong account; multiple Gmail/calendars share similar labels | Verified provider principal/resource binds access; mismatch held; no automatic first-account selection |
| T29 | Expired token, partial consent, revoked connection or reconnect while Bud is busy | Staff can repair the exact connection independently; stale jobs do not switch accounts |
| T30 | Paginated mail/calendar, duplicate invoice, late attachment, partial response and rate limit | Coverage/freshness/cursors survive retry; gaps visible; one evidence/case identity; no false claim of a complete inbox |
| T31 | External write succeeds but its response is lost | Read-back/reconciliation determines the result before any retry; cancellation alone is not proof the write stopped |
| T32 | Wrong browser profile/window, foreground changes and target closes/reopens | Stop or reattach to the exact verified target; old references cannot act in another window |
| T33 | Accessibility/Screen Recording denied, Cua crash, UAC/lock/MFA prompt | Explain the missing permission or required human step; no input into unrelated or secure screens |
| T34 | User moves mouse/types during computer work; two jobs seek one desktop | One interactive control lease; visible hand-back/pause; concurrent jobs on different devices remain independent |
| T35 | Local Stop and remote Stop during execution and network loss | Measured acknowledgment, bounded execution and visible unknown/unreachable state; no success before actual effect verification |
| T36 | Import the same pack twice; upgrade/export/reimport on the other device | No duplicate routines/cases; private bindings stay private; dependencies/corrections preserved; imports remain dormant until reviewed |
| T37 | Pack missing dependencies, unsupported capability, corrupted manifest or attempted schedule autoactivation | Specific repairable validation; no unsupported operation, key import or unintended automatic activation |
| T38 | New member completes setup, finds a shared case, attaches a file, fixes a connection and locates Stop unaided | Labels explain the next step; device/audience/account obvious; disabled actions explain why; no need to learn internal engine names |
| T39 | Keyboard-only use, screen reader, narrow window, enlarged text and Windows display scaling | Focus/labels/errors usable; primary controls and review evidence remain visible; status is not conveyed by colour alone |
| T40 | Both staff work while host runs scheduled collection; cold start and sustained office rehearsal | Record resource use, responsiveness, queue/fairness, completion time and Stop latency; host remains a usable working computer |

## Platform coverage

| Configuration | Purpose and evidence requirement |
| --- | --- |
| Physical Mac A host + physical Mac B companion | First full native office rehearsal, both workers and Cua sessions, no browser-kit substitution |
| Windows CI installed package | Exercise actual Windows runtime, embedded dependencies, installer, TLS and process behavior; capture immutable build/hash/OS receipt. Windows Server runner is not Windows 11 desktop proof |
| Interactive Windows 11 VM + Mac peer/host | Exercise real Windows app/dialogs/permissions and both Windows client and host roles. Record VM, OS and CPU architecture; ARM virtualization does not prove x64 packaging |
| Intended Windows 11 client hardware | Final Cua, Office/browser, scaling, corporate security/firewall and normal-user install check using the target architecture |
| Mac host + Windows client; Windows host + Mac client; Windows host + Windows client | Required where offered as supported configurations. Use the same source manifest/protocol compatibility, including simultaneous use, recovery and file handoffs |

Simulation is useful for many staff, contention, delayed replies, grant changes and failure injection. It cannot establish native permissions, Cua control, installed-service lifecycle or the client's actual Office/browser behavior. Both Macs executing a Node kit does not prove the native app's transport—the certificate defect already demonstrated this difference.

## Recording and completion

For each case record: case ID, status (`planned`, `blocked`, `pass`, `fail`), device/OS/architecture, app artifact hash/source manifest, runtime/driver versions, company/member aliases, executing device, source/account aliases, original/output digests where relevant, job/occurrence/receipt identifiers, observed effect, recovery result, timings and redacted evidence path. Never put tokens, recovery keys or customer content in shared receipts.

Do not total overlapping test suites or convert old evidence into a new pass. Repeat affected checks after a fix; retain the failure and link its passing replacement. New unverified paths stay blocked until their implementation and dependencies exist.

The next milestone is **two installed Macs complete the same office rehearsal through private local workers and managed shared access, with shared ownership and recovery**. After that, apply the same acceptance to Windows and the customer's approved workflow inputs. A paid-pilot readiness claim additionally needs the named office's people, accounts, formats, reviewer, cadence and observed final outputs agreed and verified.

This planning pass changed documentation only. It did not install an app, reconnect a provider, run Bud, activate a schedule or perform a business write.
