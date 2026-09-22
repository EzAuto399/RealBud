# Customer workflow packs and reviewed instruction revisions

Implemented in `server/customer-packs.ts`, `server/customer-pack-definition.ts`, shared contracts and the Schedule/You workflow-pack cards. The distributable artifact is `pack/workflows/austin-office/realbud-austin-office-v1.json`.

## Scope and authority

The three Austin business workflows are bank references and REI handoff; bills and calendar; morning priorities and unanswered follow-ups. Four existing typed recipes perform the supplied-source preparation stages. The included upstream inbox skill and license are installed in the job workroom, with a bounded named instruction skill under the selected private Hermes profile. The execution host can inject `instructionContext(recipeId)` after claiming a job, so approved local text is available even when native skill tools are unavailable.

Import requires a content preview and matching digest. Only bounded text recipes/instructions are accepted; paths, scripts, imported credentials, external capabilities, origins and schedules are rejected. Identical repeated installation preserves local plan edits and approved instruction overrides. A first binding of an already matching saved plan invalidates its prior approval. Conflicting plans or edited artifacts are retained for explicit reconciliation. Missing files can be repaired from the immutable journal. Import never accesses an account or runs a model/workflow.

Setup reads local artifact state and host-injected observations. Installed files, worker setup, selected-account checks and workflow acceptance are separate. Unknown observations remain unknown. This is not a connected bank/mail/REI workflow claim. Source acquisition, selected account verification, mapping acceptance and real business results remain separate gates.

## Reviewed self-improvement

The bridge understands the exact Hermes 0.21.3 pending skill shape, including `replace_all:false` and `origin:background_review`. Only complete create/edit text for an already installed pack-owned `SKILL.md` is reviewable. Name and description are the only allowed native frontmatter keys. Arbitrary targets, paths, patch batches, deletion, scripts, core/other skills and memory cannot be activated here. Native `apply_skill_pending` is never invoked.

The UI shows the source/target, changed text and complete current/proposed text. Apply/reject requires matching pending and active digests. Apply/revert is serialized, refuses queued/running dependent work, persists recovery intent, atomically resets dependent plans to shadow with no approval or schedule, then atomically switches the owned instruction file. Baseline bytes stay immutable; local revision history and decision receipts are separate. Revert creates a new revision and cannot restore an earlier schedule or approval. An interrupted change holds future work until explicit recovery. Parent execution paths must retain the readiness/context checks and current-revision admission checks.

The supported runtime, safe policy and enabled learner are distinct UI states. Profile repair is owned by the Hermes platform service. Staging/review does not sandbox other worker tools; existing workroom and execution authority checks remain required. No actual model-generated improvement is claimed by the synthetic pending-proposal test.

## Verification

- Focused Vitest: 25 customer-pack tests and 23 recipe tests pass, including malicious path/metadata/secret content (scoped and vendor credentials), the native 64-character name limit, near-limit journal preflight, symlink, duplicate, edit conflict, stale approval, rollback, restart, queued-run exclusion, exact pinned proposal, apply/reject/revert and interrupted recovery cases.
- Whole TypeScript client/server check passed after final UI refinement; parent runs final build/full suite.
- `scripts/qa-customer-packs.mjs`: actual local HTTP server and rendered Chrome with an isolated disposable profile and synthetic worker/pending proposal. Checks unauthenticated rejection, no-mutation preview, real import files and paused plans, incomplete acceptance, review/apply/revert, reload/repeated import, zero browser errors and 390 px overflow.
- Receipt and visually inspected screenshots: `outputs/customer-pack-2026-09-21/`. These prove the local lifecycle and rendered UI, not paid model calls, installed native app behavior, customer accounts, live bank/REI execution or customer acceptance.

## Remaining limits

Published pack revisions are immutable; importing a different published revision is intentionally rejected until a pack-level migration is designed. Reviewed local instruction versions can be upgraded/reverted now. Pre-existing conflicting legacy recipe definitions require explicit reconciliation and are never replaced automatically. The current native dependency is inbox triage; other preparation instructions remain in their typed recipes. Unsupported native memory/other-skill/script proposals need separate review tooling. Local instruction history is bounded by 100 revisions per skill and a 2 MB journal. Both pending and completed state are preflighted before file or approval changes; reaching either limit requires service archiving and preserves the prior state.
