# System map review, 10 October 2026

**This does not establish:** customer acceptance, packaged or installed behaviour, or a CI result. It re-checks the 9 October map ("RealBud map: what works, how Bud and Hermes fit, and the gaps", written from `main` at e54b401, release 0.1.48) against the 0.1.50 candidate on `claude/desk-work-areas`. Evidence tier: source, plus contrast ratios measured from the tokens.

## What changed since the map
- **Gap 1 (packs can't shape the GUI) is only partly closed.**
  - In 0.1.50 a pack's `desk.areas` sets title, layout, notice level and order for the four core work areas (`server/customer-packs.ts:90-106`, `server/desk-preset.ts:20-30`).
  - A pack still can't declare the rail, the tab set, non-area sections, saved views, forms or task steps.
  - A new client's own pack can't be chosen as the office pack. `AGENCY_WORKFLOW_PACK_IDS` (`shared/agency-workflow-packs.ts:4`) allows only three host-coded ids, and no built-in pack ships `desk`. So the preset is proved only with fictional packs in tests.
- **Accessibility, corrected:**
  - A shared dialog hook exists (`src/lib/use-dialog-keyboard.ts`, used by 7 dialogs).
  - `:focus-visible` restores the ring that `:focus { outline: none }` removes.
  - The real gaps were the Tasks drawer (no Tab wrap; 16 of 30 Tab presses left it), Arrange Desk dropping focus when closed from the More menu, and muted text under AA on four surfaces: inset 4.45, selected 4.17, raised 4.21 and raised-hover 3.76. All three are fixed in 0.1.50 (§11 of [Desk work areas](DESK-WORK-AREAS-2026-10-10.md)).
  - There is still no automated check: no axe.
- **Reliability, corrected:** nothing resumes after a restart.
  - An in-flight Ask turn is dropped, and open permission cards are denied (`server/store.ts:801`).
  - Running jobs become "Interrupted on startup — no action was resumed" (`server/job-runs.ts:164-166`).
  - Sign-in handoffs restart only on a person's click.
- **Evidence, corrected:**
  - There are 109 QA scripts, not 104.
  - CI runs no browser QA at all: `qa-e2e.mjs` runs HTTP suites, and no workflow installs Playwright or Chrome.
  - Server coverage is gated (60/45/60/62). Renderer coverage isn't.
- **Unchanged and still true:**
  - Austin special cases (`shared/austin-pack.ts:43-47`, `CustomerPackSetupCard.tsx:24`).
  - The old pack system (`server/workflow-packs.ts:53,57`: two hard-coded definitions, no rollback).
  - Every member sees every department name and open-case count (`server/company/departments.ts:109,343`).
  - Six fixed settings targets (`server/workflow-settings-broker.ts:188-194`).
  - Windows workers unconfined.
  - Composio keys in `config.json` (`server/config.ts:116-128`).
  - All three Hermes 0.21.5 gates open.
- **Stale project note:** `website/` is now a separate, git-ignored repository. CLAUDE.md's `website/` test command needs the owner's OK to change.

## Next steps, ranked
1. **Let a client's pack be the office pack.** Replace the host-coded pack ids and recipe-role bindings with roles declared in a signed pack and validated when it is admitted. A new client's `desk` preset and recipes then apply with no core edit. Prove it with two fictional agencies on one build (the map's step 4). Size: medium to large.
2. **Run browser QA in CI.** Add Playwright as a dev dependency and run the shell, Desk work areas, link gate and Austin showcase scripts on every PR. Then add axe to the same scripts. Needs: the owner's OK for the dependency and CI minutes.
3. **Department visibility.** Decide whether a member without a grant may see a department's name and open-case count. If not, filter both department queries by grant and run the Postgres suites (`REALBUD_TEST_POSTGRES=1`).
4. **Retire the old pack system.** Fold its two Austin definitions into customer packs, which gives them rollback. Then point the QA scripts that call `/api/workflow-packs` at the customer-pack routes.
5. **Later:**
   - pack-declared settings, once step 1 shows which settings differ;
   - resuming an Ask turn after a restart;
   - Windows worker isolation (owner decision);
   - Composio key custody;
   - the Hermes 0.21.5 gates.

Owner-gated work continues alongside: Kevin's Gmail and Redbark sign-ins, the live REI run and Windows signing.
