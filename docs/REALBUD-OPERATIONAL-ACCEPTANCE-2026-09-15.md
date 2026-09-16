# RealBud operational acceptance — 15 September 2026

Status: **not yet accepted for complete office operation**. This is the executable-work checklist, not a claim that every row has run. Source tests, synthetic API/component rehearsals, real-model preparation, live connected services, installed devices and customer acceptance are separate evidence layers. The [machine-readable catalogue](REALBUD-OPERATIONAL-ACCEPTANCE-2026-09-15.json) keeps every unproven end-to-end case open. The [current run report](../outputs/realbud-operational-coverage-2026-09-15/README.md) records actual checks and blockers.

## Test office and success criteria

Use fictional Acacia Agency: Accounts A and Property B have separate application directories, private conversations/memory/files and separate connected accounts under one managed service. A company owner and service administrator are distinct roles. Both staff can do all three workflows; departments are scenario labels, not mandatory product setup. Use a third uninvited member for denial checks. Never send mail, pay, sign, issue notices or post financial records as a side effect of QA.

Successful preparation means a persisted, source-backed result for human review. Successful collaboration means selected work and decisions survive restart with clear responsibility. Successful external action requires an actual adapter/service receipt and readback when supported; assistant prose is insufficient. Failure must preserve data, identify the affected source/account/device and offer a useful recovery step.

## Three complete business journeys

1. **Inbox priorities:** connect the person's account → select mailbox/window → retrieve with coverage → group threads and identify uncertainty → prepare priorities → human review → save source-linked work → explicitly share selected work when needed → preserve human changes on the next scan. A reply draft is not sent mail.
2. **Expected bills:** select expectations and permitted invoice sources → assess coverage and arrival windows → identify received/duplicate/missing/uncertain bills → human review → save observation and follow-up → request a colleague's missing fact if needed → record arranged-payment follow-up → verify eventual completion from the authoritative PMS. Closing a review does not mark a bill paid.
3. **Bank references:** select a bank export on the correct device → confirm account/date coverage/format → preserve original → prepare reference suggestions and ambiguity holds → review exact rows/revision → export a checked copy → compare totals in the PMS preview → staff performs final import and verifies the result. Bud does not transfer money or auto-post receipts.

Run each independently for A and B, then run the handoff between them. Packs enter dormant: import and inspect procedures before approving a local run or enabling a schedule. No manually maintained duplicate portfolio is required.

## How to record a case

For each OP ID, capture source/build hash, OS/device/profile, synthetic source identifiers and hashes, starting state, user actions, actual result, job/revision IDs, fault injected, final persisted state and cleanup. Record passed, failed, blocked by implementation, blocked by environment or not run separately. Do not include keys, passwords, tokens or real customer bodies. A suite pass may support a row but cannot fill an absent native/service receipt.

Pairwise coverage is sufficient for ordinary layout/format combinations; explicitly test every critical identity/permission boundary and external-effect uncertainty. Add a regression case whenever a new defect appears. This catalogue is broad coverage of the agreed scope, not a mathematical guarantee against every possible failure.

## Case catalogue


### Installation and joining

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-001 | **Owner** — Install on a clean Mac and Windows host | Set up company without a terminal; signed binaries, durable storage and clear prerequisite recovery |
| OP-002 | **Colleague** — Join from the other OS using a valid invitation | Join the intended company with a separate person and device identity |
| OP-003 | **Colleague** — Use expired, reused, wrong-company and malformed invitations | Reject safely; retain existing local work and offer a new invitation |
| OP-004 | **Owner** — Interrupt setup, retry, or open setup twice | One owned service/database; no duplicate company or lost state |
| OP-005 | **Owner** — Restart, change network, encounter a port conflict or stale host certificate | Reconnect to the paired host or present an explicit repair; never trust a different host silently |
| OP-006 | **Colleague** — Join with existing private records and imported packs | Preserve private records; joining does not publish them or activate schedules |

### Identity, privacy and managed service

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-007 | **Two staff** — Open both profiles simultaneously with different private canary notes | No cross-person chat, memory, counters, search, notifications or local-file leakage |
| OP-008 | **Staff** — Sign out or change membership while requests and uploads are pending | Clear private UI and refuse stale writes/results; cancel or safely retain owned work |
| OP-009 | **Administrator** — Try accessing an unshared staff case or impersonating a member | Deny; admin service credentials do not become a member session |
| OP-010 | **Service operator** — Expire entitlement or exhaust quota while work is pending | Gateway denies new work with a clear reason; receipts remain available and no fallback master key is used |
| OP-011 | **Service operator** — Update a model/API key or recover a managed connection | Preserve member account ownership; never distribute master keys in packs, logs or worker environments |
| OP-012 | **Staff** — Recover a forgotten sign-in or revoke a stolen device | Authorized recovery restores only the same identity; revoked sessions/devices cannot continue |

### Connected accounts

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-013 | **Two staff** — Connect separate Gmail and Calendar accounts under one managed project | Each member lists and uses only their own bound account IDs |
| OP-014 | **Staff** — Cancel OAuth, leave consent pending, retry after a lost response | Show pending/cancelled/unknown accurately; avoid duplicate connections |
| OP-015 | **Staff** — Disconnect, expire consent, or revoke access mid-job | Stop the affected operation, keep work, and show reconnect; never switch to a colleague account |
| OP-016 | **Staff** — Approve a company-shared app account and later remove its grant | Current grant governs discovery and execution independently of shared text visibility |
| OP-017 | **Staff** — Receive timeout, 429, 5xx, pagination failure or an unknown execution outcome | Bound retries; retain coverage/checkpoint; reconcile uncertain effects before another write |
| OP-018 | **Staff** — Attempt a denied tool through alternate tool names or raw parameters | The server denies send/pay/sign and out-of-scope operations, regardless of assistant prose |

### Inbox priorities

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-019 | **Accounts** — Read a defined mailbox and coverage window, classify, review and save priorities | Source-linked work list with explicit coverage, owner, uncertainty and next action; no outgoing mail |
| OP-020 | **Property** — Run the same inbox workflow on the second account | Read that account only; same workflow capability without the first user account |
| OP-021 | **Staff** — Encounter a dangerous maintenance report, ambiguous address or missing attachment | Human escalation/source hold; no invented resolution, booking or source fact |
| OP-022 | **Staff** — Read duplicate messages, forwarded threads and a new material reply | Link/update the correct work; do not duplicate completed work or erase human edits |
| OP-023 | **Staff** — Read a suspicious instruction embedded in an email or attachment | Treat it as content; do not change permissions, pay, send or disclose unrelated data |
| OP-024 | **Staff** — Read a newsletter, rent dispute and owner update request | No invented task for newsletter; verify ledger before an arrears claim; select privacy-appropriate output |
| OP-025 | **Staff** — Lose page 2 or restart during mailbox scan | Retain checkpoint and show partial coverage; never call the mailbox fully checked |

### Expected bills

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-026 | **Accounts** — Read selected expectations and invoices, prepare review and record human decision | Source-backed received/missing/uncertain classification; distinguish preparation from saved board records |
| OP-027 | **Property** — Receive a bill review, inspect permitted evidence and return the missing fact | Explicit handoff and private Bud preparation; sender reviews the returned result |
| OP-028 | **Staff** — Encounter duplicate invoice, credit, revised amount, ambiguous property or date | Preserve originals and uncertainty; no duplicate obligation or guessed mapping |
| OP-029 | **Staff** — Check a bill before its arrival window or with incomplete source coverage | Do not mark missing merely because the scan did not see it |
| OP-030 | **Staff** — Mark payment arranged without verified PMS evidence | Keep follow-up open; arranged is not paid and review closed is not financial completion |
| OP-031 | **Staff** — Edit concurrently, revoke source access or load a corrupt bill record | Reject stale edits/access; preserve corrupt data and show recovery rather than an empty board |

### Bank reference preparation

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-032 | **Accounts** — Select bank file, confirm format/rules, prepare, review and export a checked copy | Preserve original bytes, row order, totals, leading zeros and every column except approved references |
| OP-033 | **Property** — Run the same bank workflow on their own selected file | Use that local selection; same filename on another device is not the same source |
| OP-034 | **Staff** — Use unmatched/ambiguous payer, duplicate date window or a partial account export | Hold ambiguity and flag overlap/coverage; no automatic assignment by name alone |
| OP-035 | **Staff** — Use malformed CSV, quoted commas, Unicode, empty input, credit/refund or duplicate rows | Parse deterministically or explain rejection; never silently drop or coerce financial rows |
| OP-036 | **Staff** — Export before review, repeat review, or change source after approval | Deny until the current exact revision is reviewed; reject stale approval |
| OP-037 | **Staff** — Compare totals in the PMS preview and confirm final import manually | Record human/PMS evidence separately; Bud preparation never claims a bank transfer or posted receipt |

### Sharing and continuity

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-038 | **Sender** — Preview and share selected text to a named colleague | Only selected material becomes visible; show sender, audience and purpose |
| OP-039 | **Recipient** — Open a view-only item and a writable item | View-only explains restriction with no Save response; writable item permits the current authorized action |
| OP-040 | **Two staff** — Retry a lost successful share or race two responses | One creation per request ID; one current revision wins; no silent overwrite |
| OP-041 | **Recipient** — Lose write permission while drafting or receive a closed item | Server rechecks authority; preserve draft where appropriate and explain why action stopped |
| OP-042 | **Recipient** — Accept responsibility and return a reviewed Bud result with usable evidence | Durable owner/acceptance/result; selected source has independent access, not a sender-only path |
| OP-043 | **Owner** — Remove or replace an absent responsible person | Reassign permitted business work before losing continuity; private chat remains private |
| OP-044 | **Staff** — Browse older pages or return after a long disconnect | Recover older open work and current state; distinguish loading, empty, connection error and corrupt record |

### Private worker and computer use

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-045 | **Two staff** — Run private workers simultaneously with distinct file nonces and memories | Correct authenticated member, Hermes home, account and execution device for each run |
| OP-046 | **Staff** — Select Word, Excel, CSV and PDF sources with the same names on both devices | Read the selected version on the intended device; originals unchanged and unrelated folders unavailable |
| OP-047 | **Staff** — Encounter missing worker, unsupported release or a model timeout | Clear setup/recovery; no fabricated output or substitution of a personal Hermes checkout |
| OP-048 | **Staff** — Attach an approved site and perform a bounded read/prefill | Only the saved job/origin/account; verify the actual adapter result |
| OP-049 | **Staff** — Navigate off origin, switch browser account or request send/pay/sign | Deny or require the existing exact authorized human step; no permission inherited from company join |
| OP-050 | **Staff** — Stop while a tool is pending; retry after confirmed stop | Revoke execution, acknowledge process/control release and preserve partial receipts before retry |
| OP-051 | **Staff** — Lock or sleep desktop, revoke accessibility, disconnect Cua or take manual control | Pause/release safely; visible repair at the task; no phantom completed run |

### Packs and schedules

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-052 | **Owner** — Import, export, re-import and move a pack to a fresh profile | Procedures survive; credentials, source files, approvals and active schedules do not travel |
| OP-053 | **Staff** — Import invalid, oversized, conflicting, old-version or partially damaged packs | Validate whole input before changes; preserve existing procedures and explain conflicts |
| OP-054 | **Two staff** — Schedule the same shared occurrence or trigger manual work twice | One authoritative occurrence/claim; bounded capacity, no duplicate execution |
| OP-055 | **Staff** — Miss a time due to sleep, DST, timezone change or host outage | Explicit catch-up policy and correct next occurrence; no burst of unintended work |
| OP-056 | **Staff** — Edit/disable a schedule with an existing run or pending approval | Approval remains tied to its exact revision; stop and future scheduling are separate |
| OP-057 | **Staff** — Schedule a job that needs an attended computer | Queue a clear Start beside me step rather than silently controlling a sleeping/unattended desktop |

### Recovery, maintenance and departure

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-058 | **Owner** — Back up and restore onto a replacement host | Verify restored records, memberships, grants, job history and source references; prevent two active hosts |
| OP-059 | **Staff** — Disk full, file lock, permission denied, lost removable drive or corrupt record | Preserve old data; actionable recovery without presenting success or empty data |
| OP-060 | **Owner** — Install an app/worker update during queued work or revert a failed update | Compatible staged version, retained profiles and data, atomic selection and bounded recovery |
| OP-061 | **Owner** — Quit app, restart OS or crash during pending work | Owned child processes and service lifecycle are explicit; recover receipt without assuming effect did not happen |
| OP-062 | **Staff** — Export/leave company or uninstall/reinstall the application | Clear data-retention choice, scoped export and revoked device; no accidental deletion of company records |

### Usability and accessibility

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-063 | **First-time staff** — Complete setup, join, connect, import and start work without technical assistance | Plain-language navigation and one useful next action; no master-key/engine configuration for staff |
| OP-064 | **Keyboard user** — Tab through forms, review, cancel, errors and return focus | Named controls, visible focus and usable keyboard order; modal/async changes are announced |
| OP-065 | **Staff** — Use narrow window, enlarged text, long names and large task queues | No lost controls or horizontal clipping; scannable state, pagination and visible pending/error feedback |
| OP-066 | **Staff** — Refresh, close a form, navigate away or retry after slow response | Prevent double actions, explain unsaved/uncertain state and preserve work as specified |
| OP-067 | **Staff** — See Demo, synthetic, real-source, partial and reviewed output together | Every layer is clearly labelled; no sample result masquerades as office completion |

### Platform and capacity

| ID | Perspective / action | Required outcome |
| --- | --- | --- |
| OP-068 | **Release operator** — Run Mac-host/Mac-peer, Windows-host/Windows-peer and both mixed pairs | Record actual versions, runtime, TLS, identity, worker, file and computer-control receipts for each pairing |
| OP-069 | **Windows user** — Use standard account, firewall, antivirus, paths with spaces/Unicode and native file picker | Supported installer and driver work without weakening OS protections or relying on macOS path semantics |
| OP-070 | **Two staff** — Run simultaneous tasks plus a third queued job and revoke one worker | Fair bounded capacity; no profile collision; unaffected member can continue |
| OP-071 | **Service operator** — Inspect logs/diagnostics and a support export | Useful correlation and recovery data; no credentials or other members private content |

## Release gate

Complete office readiness remains false while a critical installed, account-routing, source-authority, worker-control or recovery case is unproven. Prioritise the [two-person sequence](REALBUD-SELECTIVE-SHARING-2026-09-15.md) and the existing [core register](REALBUD-CORE-EXECUTION-2026-09-14.md); this catalogue does not create another product subsystem or mark a register task complete.
