# Customer workspace implementation

Owner request: customizable tabs, portable Austin skill/workflow packs with guided setup and repair, Hermes learning, Windows/macOS operation, and managed subscription access. This implements the [business OS decision](decisions/2026-09-21-business-os-and-austin-workflows.md).

Historical milestone: the results and remaining work below describe this initial implementation. Subsequent host-owned mail collection, durable priorities, bill/source histories, department lifecycle, backup recovery and typed memory proposals are recorded in the [current core status](REAL-ESTATE-CORE-2026-09-21.md). Use that report and current source for present scope; the earlier ten-thread interactive-reader limit is not the later host collector's contract. The [Windows journal integration candidate](HERMES-WINDOWS-MEMORY-JOURNAL-2026-09-22.md) now has local fault tests and remains held pending native and installed acceptance.

Latest local follow-up: [staff memory recovery and private profile provisioning](HERMES-MEMORY-RECOVERY-PROFILE-2026-09-22.md). Closed interrupted requests stop retrying, ambiguous evidence stays held, and existing Windows permissions are verified without silent repair. Native Windows and customer acceptance remain unverified.

## Work ownership

| Track | Implementation | Verification |
|---|---|---|
| Workspace views | Versioned private tab definitions, validated view types, reorder/hide/rename/delete/reset, existing authorized data renderers | Scope isolation, corrupt state preservation, stale saves, keyboard/mobile/native UI |
| Customer packs | One portable bundle for bank references, bills/calendar and morning priorities; preview/import; native instruction skills; observed readiness; safe repair and upgrade/recovery | Invalid/hostile bundle rejection, no credential export, idempotent install, no activation on import, exact artifact/readiness receipts |
| Hermes and platforms | Verify reviewed release and native skill/learning mechanisms; fix platform assumptions; Windows/macOS build and smoke coverage | Source/pinned-runtime proof separate from fixtures, Mac package and physical Windows execution |
| Managed access | Existing administrator sessions plus off-device credential custody and current subscription enforcement at connector/provider dispatch | Revocation/expiry/cross-tenant denial before calls, no upstream master keys in desktop/worker, read/export recovery retained |

Keep server/index.ts integration owned by the parent while workers own separate modules. Preserve other dirty-tree work. Reuse current storage, broker, review and scheduler contracts; don't create a general plugin engine or a second billing system.

## Intended import journey

Open a pack file → preview its workflows, instructions and requested dependencies → import disabled plans → run local validation → show account/worker/mapping/timezone checks with evidence and actionable next steps → authorize a selected connection/test when needed → review a sample result → enable the agreed schedule. A scan starts only after its required source and action authority exists. Missing customer inputs remain visible, never replaced by fictional success.

Safe local fixes may restore missing packaged instructions or regenerate validated local configuration. OAuth/MFA, paid provider tests, new permissions, code changes and unknown external outcomes are not automatically bypassed by repair. Hermes learning should produce inspectable skill revisions using supported upstream mechanisms, preserving published pack instructions and RealBud's permissions.

## Subscription contract

Service operators configure credentials and customer service periods; ordinary staff cannot edit provider/core settings through RealBud. Master provider/Composio credentials must stay in the protected service. The client receives revocable installation/customer-scoped access. A current server-side subscription check must precede upstream dispatch, and expiry or suspension must deny new managed operations even if a client patches its local settings. Preserve records and read/export during service suspension. No software running on a customer-controlled OS can promise that the customer cannot modify that local software or run a separate copy with their own services.

Payment collection, production hosting, credential migration and actual customer suspension are external rollout actions, not effects of a local build. Existing Modelvia work owns model routing and resale billing; do not fork it into a new desktop billing mechanism.

## Completion gates

Each track must finish implementation, integration, failure/recovery checks and applicable visual validation. Record actual tests/build receipts here at handoff. A portable pack is not proof that Austin's bank export or REI import is accepted. A Mac test or Windows CI definition is not an installed Windows result. Final customer-ready release needs supported signed builds, deployed authenticated services, approved source-account connections and a real customer workflow rehearsal.

## Implemented and verified locally

- Up to 12 named personal views for tasks, bills, saved jobs and authenticated shared work. Add, rename, reorder, hide, restore and remove; keep core navigation accessible. Revision conflicts preserve newer edits; damaged state is held and archived through explicit reset. Opening a saved job preserves unfinished wording.
- A portable 26 KB Austin pack names all three business outcomes and installs four supplied-source preparation plans plus a native instruction dependency. Preview is read-only. Import/repair preserve edits, require reviewed content, reject credentials/paths/unsupported metadata, and do not start schedules. The complete native skill name obeys the upstream 64-character limit.
- Native Hermes suggestions for owned pack instructions have visible differences, digest-bound review, apply/reject/revert, baseline/history retention and interrupted-upgrade recovery. Instructions are loaded after a run claims its job, and their digest is recorded in its receipt. Dependent approvals/schedules reset before changes; active work blocks an upgrade. Journal size is checked before effects so retained history cannot exceed its reader limit. Both scheduled and interactive work use the immutable private worker profile.
- The gateway holds Composio project keys and admits only the bounded Gmail reader. Its operator registry and current service ledger govern scoped credentials, expiry and revocation. Desktop setup requires administrator authority, invalidates earlier sessions, serializes changes and projects safe status data. Unknown OAuth outcomes are journaled and held across restart. See [operator setup and recovery](MANAGED-CONNECTIONS-OPERATIONS.md) for scope and actual billing integration limits.
- Native learning is enabled only with supported reviewed Hermes policy. Windows staging finds owned prerequisites and avoids Unix-only copy/extraction assumptions; installer CI runs installed-runtime smoke checks. See [Hermes and platform evidence](HERMES-PLATFORM-2026-09-21.md).

## Final verification receipts

All commands used Node 24.19.0. No real customer account, paid model, payment, deployment or release channel was used.

| Layer | Actual result |
|---|---|
| Whole application tests | `pnpm test`: **2,831 passed, 109 skipped**; 244 passing files, 14 skipped files. No failures. `outputs/customer-workspace-2026-09-21/full-test.log` |
| Managed gateway | **95 passed**, no skipped or failed tests, including real loopback HTTP and operator provisioning concurrency. Gateway TypeScript check passed. `outputs/customer-workspace-2026-09-21/gateway-tests.log` |
| Build | `pnpm package:prepare` passed frontend/server TypeScript, Vite, bundled service dependencies, updater and browser helper. Native speech/CUA/PostgreSQL staging passed. Build retains Vite's existing large-chunk advisory; no performance benchmark is claimed. |
| Mac package | Unsigned arm64 **0.1.19** preview built with electron-builder, `--publish never`, in `outputs/customer-workspace-2026-09-21/package/mac-arm64/RealBud.app`. Installed `/Applications/RealBud.app` was not replaced. |
| Native GUI | **9 journeys passed**, no renderer errors, using the actual packaged Electron app and a disposable real PostgreSQL fixture. Includes saved-view creation/reload, pack import/resource loading, department permission changes/stale rejection, service controls and recovery, plus 390 px checks. `outputs/customer-workspace-2026-09-21/native-qa.json` |
| Pack lifecycle | Packaged service + rendered browser passed preview → import → exact native pending proposal → apply → revert → reload/reimport; missing acceptance remains visible. `outputs/customer-pack-2026-09-21/receipt.json` |
| Saved views | Real authenticated API + rendered desktop/mobile checks passed persistence, stale edits, exact-job navigation, unsaved wording, authorized sources and corruption recovery. `outputs/workspace-tabs-2026-09-21/ui-receipt.json` |

Packaging review caught and fixed absent workflow resources. Final verification also fixed an obsolete redaction-marker assertion; the secret-absence assertion stayed intact. An earlier communications-test teardown race did not recur on focused or final full runs. Browser/native fixtures were shut down after checks.

## Remaining production work

This is a verified local implementation, not a declaration that the requested end-to-end customer system is production complete.

1. **Source acquisition and workflow acceptance:** the supplied-source pack does not automatically acquire a bank export or perform final REI import. Managed Gmail currently reads at most ten threads from seven days; complete historical search, attachments and unattended morning ingestion still need an admitted implementation, coverage receipts and account-specific rehearsal. Review original/corrected CSV pairs, property mappings, bill recurrence, timezone and a sample morning ranking with the customer before enabling schedules.
2. **Service rollout:** deploy the protected connector service and connect its ledger to the authoritative Modelvia subscription/payment lifecycle. Provision customer-scoped model and connector access, desktop grants, operator recovery and monitoring. No automatic nonpayment cutoff was activated against a real customer in this work.
3. **Platform release:** run the new Windows installer workflow and clean Windows 11 acceptance; sign/notarize the Mac release and verify installation/update/restart/permissions on customer hardware. Native banking/browser control, microphone quality, enterprise execution policy, performance and a real two-computer office remain separate acceptance checks.
4. **Further extensibility:** views are bounded saved views, not arbitrary executable tabs. Owned instruction revisions are reviewable; whole-pack version migration, memory proposals, scripts and unrelated core skill changes require their own supported design. The current imported revision is immutable and conflicting customer edits are preserved.

The next work should close those specific gaps without treating the successful local receipts as live service or customer acceptance.
