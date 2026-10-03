# Reviewed department workflows over a reusable product core

Status: implemented source candidate; acceptance receipts live in `outputs/qm-productization-2026-10-03`. This decision does not establish installed-device, live integration or customer acceptance. The macOS detached-worker Stop defect remains a release hold.

## Decision

Use one RealBud core with separately reviewed agency and department configuration. The first two department groups are Accounts (including general admin) and Property Management (including maintenance and inspections). Customer-specific records, credentials, membership, grants and acceptance evidence stay outside portable workflow packs.

The owner selects exact reviewed preparation plans for a department. Members see configured plans that match their local installation. This is an incremental extension of the existing company scope, case and execution model. It does not add a second scheduler, agent roster, plugin runtime or authority source.

## What QM contributes

The comparison pins [yc-software/qm](https://github.com/yc-software/qm/tree/5dbebac68f671cf456ebd42061ff9578fa4fe138) at `5dbebac68f671cf456ebd42061ff9578fa4fe138`. Its reviewed deployment definitions, scoped knowledge, resumable setup and observable background jobs are useful product patterns. See the [source-backed comparison](../../outputs/qm-productization-2026-10-03/qm-comparison.md).

QM's one-organization database binding is not proof of pooled multi-tenant isolation. Its general-purpose automatic/dangerous operating modes and disabled screening defaults are not adopted. RealBud keeps existing approval, identity, source, sandbox and recovery boundaries. No QM code or scripts were executed to implement this slice.

## Data and authority

`DepartmentConfiguration` version 1 contains the department template, up to eight exact reviewed plans and up to eight work-type defaults. It is bounded to 24 KiB. A selected plan includes its plan digest, instruction digest, literal review and optional installed pack identity/binding digest. Defaults only help users select a plan; they do not assign staff or authorize execution.

The existing department scope stores this configuration. Its revision is the optimistic concurrency boundary. Owner saves use company-bound review digests, existing authenticated scope/request locks and the encrypted department outbox. Immutable audit receipts hold before/after values. A lost reply replays the same request. Historical restoration is a new reviewed save of the exact earlier configuration, not restoration of old grants.

Plan identity across installations is its ID plus exact reviewed content, hashes and locally checked pack binding. The host verifies configured content/authority; it does not remotely attest member code or execution. For the compatible department-starters family, local recipe and skill revision counters are not assumed to match after independent imports or a reviewed revert. Each execution grant still records the actual executing instance's revision. The host rejects plans outside the current configured selection on begin, confirmation, admission, check and renewal; filtering the UI alone is insufficient.

Saving settings publishes selected instructions, reasons and history to authorized department members. An unchanged normalized save is refused before revision changes or revocation. The UI says so before consent. No connector, private file, personal memory or credential is inherited by department membership. The current department execution boundary remains one assigned case's supplied title/description, analyse/draft only, no external origins, at most five minutes and twelve turns, followed by human review.

## Migration and recovery

Migration 0009 adds nullable scope configuration. Existing departments become explicitly unconfigured. It increments existing department revisions so the established lifecycle trigger invalidates prior execution authority and holds affected work for review. Records and results remain. No migration is run against the installed customer database in this change.

Backup compatibility handles known older manifests explicitly; unknown shapes are not silently accepted. Restored work remains held and requires fresh authority. Configuration saves must validate returned content and the original saved revision before the outbox marks them confirmed. The client independently validates the same receipt before acknowledgement and reloads current settings after a historical replay.

## User workflow

1. Import the department starter pack and review local plans under Schedule.
2. Create Accounts and Property Management under Workspace → Office → Departments and access; set membership separately.
3. Choose Manage, select the appropriate starter plans or approved custom plans, choose work-type defaults and review the change.
4. Save with a reason. Members request one preparation for an assigned case; the owner approves that exact case, plan and instance.
5. Review the result and record the case outcome. Preparing a draft never implies a message was sent, a repair booked or an invoice paid.

Missing plans are shown explicitly. The UI preserves conflict drafts, prevents switching departments from discarding a draft, distinguishes pre-dispatch validation from uncertain saves, and exposes saved plans/defaults for comparison. Historical settings load as drafts for another review.

## Starter pack and extension path

The new immutable `department-starters` revision 1 provides invoice issue, admin/mail case, bank exception, owner/property case and maintenance/inspection case review. It contains generic instruction text only, no agency identities or customer records. Schedules are off. Importing does not approve plans or qualify model runtime.

Case-only instructions are embedded for this new pack family; published file-based packs and existing arbitrary custom pack wrappers retain their prior bytes. Future pack families need an explicit compatible contract before receiving this behavior.

Custom work can use eligible locally reviewed case-only plans. Packs requiring support files unavailable to the isolated department worker are excluded until they implement an explicit compatible contract. Department connector bindings, reusable cross-department execution graphs, unattended consequential actions and organization-wide memory promotion are not implemented by this configuration slice.

## Release and rollout conditions

The removal containment refuses automatic worker profile reset when complete cleanup cannot be established. This protects profile state; it does not establish that separately detached workers stop. A kernel-owned worker lifetime boundary or equivalent proven mechanism remains necessary before release.

Next product gates are a reviewed Accounts-to-PM case handoff, department-scoped source bindings, source-backed result review and realistic capacity/cost evidence. Pilot acceptance must include real staff on two devices, actual model output quality, selected live connector operation and sustained recovery exercises. Fictional fixtures and local test counts do not substitute for those gates.

The requested Opus 5.5 review ran after renewed sign-in, with xhigh requested. Findings, verified fixes, evidence boundaries and deferred recovery work are tracked in [the review disposition](../../outputs/qm-productization-2026-10-03/POST-OPUS-REVIEW.md). Source review is separate from test execution and does not imply release approval.

Exact outbox retry resubmits the saved request. If it is absent from restored history and still permitted by current identity and revision, it can apply; a recorded request replays its receipt. The UI states this explicitly. Invalid administrator-modified storage fails closed and is preserved; a repair operation requires a versioned immutable-audit, backup, replay and UI contract rather than ordinary Save.
