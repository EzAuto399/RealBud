# Bud status and setup ownership

This checkpoint does not establish a new packaged build, installed-device behavior, live model access or customer acceptance. It covers source changes and isolated local verification of the setup/status workflow.

## Feature contract

RealBud is a daily desktop workspace. A person returning to Ask should see whether Bud can work, which prerequisite is incomplete, and who can resolve it without losing their request.

The existing native type, color, spacing, dialog and keyboard patterns remain authoritative. The requested uiux workflow applies at Feature scope. The requested taste refinement is clearer hierarchy, compact content and legible actions; marketing heroes, random layouts and scroll animations do not fit this operational surface.

1. Open Ask; the header and composer read the same authoritative Bud state.
2. Open Bud status from an incomplete setup notice; the panel names the incomplete prerequisite and responsible person.
3. For a service administrator, open the existing setup controls and complete the current step. For staff, open the relevant account or administration destination only when it is useful.
4. Observe automatic, read-only status updates; a pending or failed request never invents readiness.
5. Return to Ask with the draft intact; work starts only when the person submits it and existing authorization permits it.

## State contract

| State | Visible result | Next action |
| --- | --- | --- |
| First status load | Checking status, no ready claim | Keep drafting |
| Missing worker or safeguards | Specific incomplete prerequisite and service ownership | Administrator setup, or view status for staff |
| Missing account/model | Existing account connection path or administrator model choice | Open the appropriate destination |
| Readiness check required | Check required, distinct from a running check | Authorized check or wait for administrator |
| Check failure | Bounded user-facing reason, retained draft | Authorized retry or relevant administration path |
| Ready | Confirmed ready state with completed checks | Return to Ask |
| Offline / status refresh failure | Connection or refresh failure; last-known facts are not current readiness | Reconnect or retry |
| Recovery / withdrawn access | Explicit recovery or service hold | Existing recovery or account/service path |
| Interrupted / hidden panel | Draft retained; hidden monitoring suspended | Reopen and refresh |

There is no search or collection empty state in this flow. Missing facts stay unknown; they do not become completed checklist items.

## Authority and automation

The original failure was an action contract mismatch: `budAvailability` offered “Finish Bud setup”, but the default `BudSetupCard` rendered an ordinary managed status view with no setup action. Existing profiles can also legitimately fail a newer safeguards policy: `ensurePropertyPack` intentionally initializes new profiles without rewriting an existing one. That behavior remains intact.

Worker installation, safeguards changes and model readiness requests retain the existing service-administrator boundary. Automatic observation uses local status reads. Existing automatic repair/readiness attempts must not run for an ordinary staff session. No provider credentials, customer records, hosted settings or saved safety policy are changed by viewing status.

## Verification

Final source verification on 27 September 2026, against unchanged source hashes:

| Layer | Result | Evidence |
| --- | --- | --- |
| Focused source tests | 149 passed / 0 failed / 0 skipped across 12 files | [Test log](../outputs/bud-status-2026-09-27/final-focused-tests.log) |
| Production source build | App/server TypeScript and Vite build passed; existing large-chunk warnings remain | [Build log](../outputs/bud-status-2026-09-27/final-build.log) |
| Source-rendered browser | 9 grouped checks passed / 0 failed / 0 skipped; 17 unique screenshots; zero renderer errors | [Final receipt](../outputs/bud-status-2026-09-27/after-final/receipt.json) |
| Visual/accessibility | 360, 390, 768, 1280 and 1536 CSS px without horizontal overflow; keyboard trap, Escape focus return, draft preservation and reduced motion passed | Same final receipt; screenshots below |
| Installed/live | Not exercised; no new native package or installed update, provider request or customer acceptance | Existing authority and release gates remain |

The final browser run uses Node 24.19.0, the actual application store, an isolated local service and fictional worker/admin responses. It records zero worker mutations and zero non-local browser requests. The source hashes at start/end match, and the root review independently matched all 11 recorded hashes to current files. The isolated service and temporary data were cleaned up. Focused tests/build used the local Node 25.9.0 runtime, which satisfies the declared Node >=24 engine.

State renders include initial checking, safeguards blocked, readiness required, model missing, withdrawn access, book recovery, offline, pending refresh, failed refresh and recovered readiness. The administrator fixture exposes the existing enabled **Set up workroom** action; the fixture does not execute it. A later ready response updates the panel automatically within 15 seconds, without a model request. Repeated focus events do not create a refresh loop. Text contrast checks passed: muted text on sheet 5.27:1, primary button text 7.16:1.

Earlier `before`, `after` and `after-matrix-*` artifacts are retained as intermediate evidence. The first baseline captured a lazy loading shell and is explicitly marked incomplete. Intermediate checks exposed the missing first-open focus return and a refresh ownership overlap; the final receipt supersedes those runs. The unchanged-HEAD baseline is `before-head`, whose receipt records the exact source transforms and fictional data.

## Implementation map

| Files | Behavior |
| --- | --- |
| `src/lib/bud-setup.ts` and availability tests | Permission-aware copy, specific prerequisite reasons and validation of incoming status |
| `src/lib/bud-status-monitor.ts`, monitor tests, `src/state/store.tsx` | Shared serialized reads, visibility cleanup, 15/30/60-second failure backoff, no stale loader/focus overwrite |
| `ManagedBudStatus.tsx`, `BudSetupCard.tsx`, `WorkspaceSetup.tsx`, `AskWorkspaceSheet.tsx` | Compact status checklist, saved model shown as Configured, useful account/recovery/admin paths, direct authorized setup |
| `AskReadiness.tsx`, `ChatView.tsx`, `DeskPage.tsx`, `schedule/JobWorkspace.tsx`, `src/App.tsx` | Consistent role-aware actions, preserved draft/focus, administrator gates on both automatic readiness entry points |
| `scripts/qa-bud-status.mjs` and component tests | Repeatable fictional source-rendered checks, keyboard/state/width evidence and permission regression coverage |

## Before and after

| Surface | Before | After |
| --- | --- | --- |
| Ask setup notice | [Original notice](../outputs/bud-status-2026-09-27/before-head/ask-safeguards-1280.png) | [Role-aware notice](../outputs/bud-status-2026-09-27/after-final/ask-safeguards-1280.png) |
| Staff setup/status panel | [Original dead end](../outputs/bud-status-2026-09-27/before-head/bud-safeguards-1280.png) | [Compact checklist](../outputs/bud-status-2026-09-27/after-final/bud-safeguards-1280.png) |

Additional reviewed renders: [360 px](../outputs/bud-status-2026-09-27/after-final/bud-safeguards-360.png), [automatic ready state](../outputs/bud-status-2026-09-27/after-final/bud-ready-auto-refresh.png), [administrator action](../outputs/bud-status-2026-09-27/after-final/bud-administrator-real-action.png), [recovery](../outputs/bud-status-2026-09-27/after-final/bud-recovery.png), [refresh error](../outputs/bud-status-2026-09-27/after-final/bud-refresh-error.png).

Next release gate: package this exact source and verify the installed RealBud flow before claiming the running desktop application has changed.
