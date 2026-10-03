# Hermios integration owner status — 1 October 2026

This checkpoint does **not** establish a connected Hermios account, deployed endpoint, native CRM screen, production rollout or customer authority. A source-only module contract and injected host adapter are implemented and verified against fictional tests and upstream contract fixtures; independent source review found no concrete issue. No Hermios account calls, installed-app changes, billing changes or deployment occurred in this follow-on. The completed Auston work remains at the [mock-workflow checkpoint](AUSTON-MOCK-WORKFLOWS-2026-10-01.md).

## Planning inputs and ownership

The initially supplied planning paths returned **No such file or directory**:

- `/Users/yo-da/Documents/GitHub/salesfren/docs/realbud-hermios-build-coordination.md`
- `/Users/yo-da/Documents/GitHub/salesfren/docs/realbud-hermios-platform-design.md`

The coordinator subsequently located them under `/Users/yo-da/Documents/Documents - yo-da’s Mac mini/GitHub/salesfren/docs/`. The relocated build-coordination document was read. The concrete implementation contract and source were read at `/Users/yo-da/projects/hermios-realbud-modules/docs/contracts/hermios-modules-v1/README.md` and `packages/twenty-shared/src/application/hermiosModule.schema.ts`, plus profile/modules services and policy projection. The [native design handoff](HERMIOS-NATIVE-DESIGN-HANDOFF-2026-10-01.md) remains presentation evidence, not verified transport.

Accepted local scope is four new files only: [shared contract](../shared/hermios-modules.ts), [contract tests](../shared/hermios-modules.test.ts), [host adapter seam](../server/hermios-modules.ts), and [adapter tests](../server/hermios-modules.test.ts). No shared routing, store, Apps, company, runtime or billing files were edited. No second entitlement engine or model route is introduced. These modules are deliberately not mounted in the application until a verified connection implementation exists.

## Concrete adapter progress

- Strict profile, snapshot and configuration parsing follows the v1 source and generated UUID/date patterns. Unknown fields, unsafe revisions, duplicate modules and contradictory effective states fail closed. Planned entries can be explicitly denied. Expiry is not recomputed locally; same-revision access changes remain possible. Organization instructions remain inert strings.
- Read calls the exact `get_hermios_profile` and `read_hermios_modules` operations through an injected host port. The port must supply a verified RealBud company/member ↔ Hermios workspace/profile binding and connection selection generation. Profile email and labels never establish identity. Results are cleared/discarded after switches, including A→B→A when the required generation/clear lifecycle is honored.
- Configure requires a prior read, exact profile/revision, fresh identity/access/permission reads and the complete normalized three-field preference object. Only the pilot is configurable in this initial seam. Inaccessible modules permit an inert disable with unchanged normalized preferences; attempts to change preferences are held before dispatch. Hermios retains authoritative effect-time permission and revision checks.
- No automatic retry exists. Any unconfirmed result after mutation dispatch—including tool error, transport error, malformed success, wrong workspace or account switch—is uncertain and clears the snapshot. A new read and explicit retry are required. Post-commit snapshots may reflect another writer; the returned current snapshot is not presented as proof that the submitted values remain current.
- The host port must pin credentials to the captured connection and recheck membership immediately before dispatch. This is a required integration contract, **not an implemented OAuth/session transport**. No public route or Bud tool exposes configuration.

Final verification: **116 passed / 0 failed / 0 skipped**, two files, 412 ms. All five upstream snapshot fixtures parse successfully. Consolidated `pnpm typecheck` and `git diff --check` pass. The separately rerun shared-parser suite is **85 / 0 / 0** and overlaps the combined count. Independent read-only review found no concrete issue; it did not independently rerun tests. The first server typecheck found a string-union inference issue in the new parser; an explicit tuple corrected it before the successful checks. No failing attempt is counted as passed.

Evidence: [adapter receipt, source/schema/fixture hashes and limits](../outputs/hermios-contract-adapter-2026-10-01/adapter-receipt.json), [combined test record](../outputs/hermios-contract-adapter-2026-10-01/root-focused-tests.log), [shared-parser tests](../outputs/hermios-contract-adapter-2026-10-01/focused-tests-final.log). Contract provenance is pinned to the coordinator's local Hermios commit `03da339758` on `codex/realbud-module-access`; hashes in the receipt preserve the exact consumed artifacts. Upstream backend/UI acceptance counts are not relabeled as RealBud integration proof.

## Existing RealBud hooks

Source baseline: Git HEAD `e11c0bf79e13a75773b108b4aef0a749f8ce0894`, with substantial shared, uncommitted changes. These are existing internal integration points, not agreed Hermios endpoints.

| Area | Existing hook | Boundary to preserve |
|---|---|---|
| Shell and navigation | [App shell](../src/App.tsx), [screen boundary](../src/components/WorkspaceScreen.tsx), [saved-view contract](../shared/workspace-tabs.ts) | Desk, Ask, Schedule and You remain available. Saved tabs are a fixed set of display preferences, not a remote module catalogue or executable plugin loader. Navigation protects unfinished property, bill and case edits. |
| Company and department access | [Company API contracts](../shared/company-api.ts), [company host](../server/company-host.ts), [database authority](../server/company/index.ts) | Company/member sessions, department scopes, revisions, lifecycle locks and database permission checks remain authoritative. A renderer filter or external module title cannot grant access. |
| Assigned-case preparation | [Reviewed-plan gate](../server/department-work-plan.ts), [execution client](../server/company-execution-client.ts), [department preparation UI](../src/components/CompanyDepartmentPreparation.tsx) | Exact case/plan/instruction/instance review, separate owner approval, lease/fence checks and identity checks before/after host calls. Current department plans are analysis/draft only; private inbox/files/portal recipes are rejected without a department source connection. |
| Shared work and decisions | [Shared-work contract](../shared/company-work.ts), [work outbox](../server/company-outbox.ts), [department outbox](../server/company-department-outbox.ts) | Selected portable evidence copies retain source/version references. Those references grant no source access. Exact saved intents, current revisions and uncertain-result reconciliation must survive any mapping to external records. |
| Ask and continuing work | [Work continuation](../src/lib/work-continuation.ts), [Ask app context](../src/lib/ask-app-context.ts), [store](../src/state/store.tsx) | A prior result is reference material, never fresh facts or execution authority. Connection context is display state; it does not supply provider permission. These surfaces currently overlap other uncommitted UI work. |
| Identity and managed model | [Workspace identity](../server/workspace-identity.ts), [office link](../server/office-link.ts), [model access](../server/worker-model-access.ts), [managed service](../server/managed-service.ts) | Keep immutable private-workspace identity distinct from company membership, portal identity and execution grants. Preserve Modelvia provisioning, revocation, limits and protected credentials; a Hermios module must not introduce a replacement model/account authority implicitly. |
| Existing workflows and sources | [Agency role bindings](../shared/agency-workflow-packs.ts), [Auston revision-4 pack](../pack/workflows/austin-office/realbud-austin-office-v1.json), [job executor](../server/job-executor.ts) | Known recipe IDs and reviewed plans bind roles. Kevin remains the sole invoice reviewer; Sherry's separate rehearsal is not a production integration. No private mail/bill data becomes department-wide merely by adding a module. REI writes remain simulated; Zapier remains exclusive to Property Inspect. |

The existing company portal binding is specifically a RealBud identity relationship ([contract](../shared/company-portal.ts)). It is not an established Hermios login or tenant mapping. Hermes is the current managed worker runtime; similarity of names does not establish a Hermios product adapter.

## Shared changes and installed baseline

The shared checkout is not a clean integration base. Current overlapping changes include:

- Core execution/source path: `server/index.ts`, `job-executor.ts`, `private-json.ts`, `mail-ingestion.ts`, `recipe-draft.ts`, Ask source handling and connected-app/Gmail brokers.
- Model/service and browser path: `office-link.ts`, `managed-service.ts`, Hermes ACP/runtime environment, browser authority/runtime and new native work-browser files.
- Work UI and records: store, Chat/Composer/app-context/continuation files; source-bill rules, graph, API, shared types and review UI; new duplicate-review helpers/tests.
- Distribution and instructions: package/lockfile, Electron packaging/browser scripts, property instructions, Auston pack definition/generated revision 4, and the separate maintenance rehearsal pack.

Coordinate file ownership and an immutable reviewed patch before later implementation. Do not reset, overwrite, broadly regenerate, or package these unrelated changes as a Hermios adapter. Files listed as hooks above may be unchanged while their imports and callers are dirty.

The installed app is **not** the shared checkout. The Auston checkpoint records a local QA update applying only three compiled readable-input modules: `private-json.js`, `mail-ingestion.js` and `job-executor.js`, built against verified installed baselines. That update retained workspace identity and native-browser bytes. The separately reviewed Gmail collector was released on the managed gateway. The duplicate-bill repair remains source/local-browser evidence, and the maintenance rehearsal pack remains unimported. See the checkpoint's build/install manifests; this audit did not independently reopen the installed app or repeat live checks.

## Verified integration blockers

1. RealBud has no Hermios authenticated transport, OAuth client/token lifecycle or explicit persisted company/member binding. Existing Apps uses Composio/managed-gateway credentials; existing company portal binding fixes its issuer to `realbud.app`. Neither is a Hermios login. The contract remains marked not deployed.
2. A transport owner must supply the actual origin/client registration, verified membership flow, token custody/refresh/disconnect behavior, JSON-RPC request correlation and generation invalidation. Do not use email matching, a configurable Composio URL, a worker key or a model grant to fill this gap.
3. The native Apps/catalog card and preference draft/reconciliation UI must be wired through existing authenticated company controls after that binding is concrete. Unknown-write drafts must survive refresh and require a person to compare changes; the adapter does not own UI draft persistence or CRM caches.
4. Record reads, field/record filtering, selected-evidence handoffs and execution authorization remain later journeys. Module enablement proves none of these. Current module controls do not authorize the Auston private source data to become office-wide CRM data.

The original read-only baseline above is retained for coordination. This follow-on adds only source/local adapter evidence. It does not change the installed Auston QA app or the reviewed gateway collector release, and no other chat was messaged from this task.
