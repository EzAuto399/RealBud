# Daily-use UX redesign brief — 1 October 2026

Status: design brief for an isolated prototype. No production source changes. Owner request (1 Oct 2026): make RealBud easier to navigate and operate every day, make Hermios CRM stand out as the easy way to work with customer records, and make workflows read clearly — simple enough that people enjoy using it daily.

Design pass: Codex CLI, `gpt-6-astra` at `ultra` effort. Review and integration judgment: Claude Code session.

## Read first

- `CLAUDE.md`, `.claude/rules/ui.md`, `DESIGN.md` (tokens, four doors, copy rules)
- `docs/decisions/2026-09-21-business-os-and-austin-workflows.md` (current product direction)
- `docs/decisions/2026-10-01-connection-sessions-and-hermios-placement.md` and `docs/HERMIOS-NATIVE-DESIGN-HANDOFF-2026-10-01.md` (Hermios is the CRM; what is and is not built)
- `outputs/hermios-native-design-2026-10-01/` — the earlier Hermios prototype. Reuse its record view, identity strip and "Work with Bud" rail; do not redesign them from scratch.
- `outputs/connections-design-2026-10-01/` — current Connections dialog (Bud / Apps / Phone / Office)
- Current screens: `src/components/Sidebar.tsx`, Desk (`src/components/Desk*.tsx`), Ask (`ChatView.tsx`, `Composer.tsx`), Schedule/jobs, `YouPage.tsx`. Screenshots: `outputs/customizable-desk-2026-09-30/desk-customized.png`, `outputs/workflow-ux-2026-10-01/job-review-desktop.jpg`, `outputs/connections-design-2026-10-01/*.jpg`.

## Diagnosis (from current source screenshots, fictional data)

1. **Bud lives in three places** — the Ask door, the Desk right rail, and Connections → Bud. There is no single, always-reachable "ask Bud about this" surface.
2. **Too many equal-weight actions.** The empty Desk shows ~9 buttons (Queue, Run sample morning ×2, Ask Bud, More, Prepare next step, Check Bud connection, Open conversation, Connections). Nothing says what to do first.
3. **Screens explain instead of show.** Schedule's job plan is four disclosures and four caveat paragraphs before a disabled primary button.
4. **Workflows don't look like workflows.** No visible trigger → sources → Bud prepares → you approve → effect chain; no next run / last result / needs-you status at a glance.
5. **Hermios is buried** in Connections → Apps → search "crm" → "Planned".

## Design moves

1. **Bud within reach, attached to context.** A ⌘K command bar and a collapsible Bud panel available on every door. It carries the current object (case, CRM record, job, run) as visible, removable context chips. Ask remains the door for conversation history. Constraint from `DESIGN.md`: Bud is contextual assistance, never the product shell — the panel opens *on* work, it does not replace it.
2. **One primary action per screen.** Every screen state has exactly one primary button. Secondary actions go to a quiet row or overflow. Safety copy collapses to one line plus approval cards at the moment of approval (send / pay / sign / notice still show actual recipient, amount or content).
3. **Workflows as cards.** Each workflow (e.g. morning arrears, owner letter, inbound triage, Austin workflow pack entries) is a card with a step strip (trigger → sources → Bud prepares → you approve → effect), status chips (next run, last result, needs you) and one action. Teaching a new job becomes a three-step flow: describe → review the steps Bud proposes → try once. Repeat scheduling is a later, optional step.
4. **Hermios as the CRM home.** A CRM view inside the Desk door (four doors stay four). Before a verified connection exists, show a clear "Connect Hermios" panel that explains what the person gets (records next to their work, Bud prepares follow-ups from selected records) and honestly states it is not available yet — no fake Connect action. After connection: the earlier prototype's record list + record canvas + Work with Bud rail. Selecting a record and pressing ⌘K drops it into Bud's context.
5. **Desk opens on Today.** Three bands: Needs you (approvals and held items), Bud prepared (results ready to review), Coming up (next workflow runs). An empty Today shows one next step, not nine.

## Hard constraints

- Product is **RealBud**; the worker is **Bud**. Never show "Hermes", "MCP", "broker", "RealBud clock" or "You →" on primary surfaces (`src/lib/workspace-copy.test.ts`). **Hermios** (the CRM) may be named.
- Colours only from the `DESIGN.md` / `src/styles.css` tokens. No gradients, glow, glass or chat-app styling. 44 px targets. Breakpoints 1279/959/719. Motion transform/opacity only with reduced-motion fallback.
- All data fictional and labelled as such. No network calls, no accounts, no model invocation, no CRM access from the prototype.
- No invented capabilities: do not show CRM writes, automatic sending, Hermios sign-in, or workflow readiness as working. Planned things say planned.
- Accessible names on every control; dialogs trap focus, close on Escape and restore focus.

## Deliverables and file ownership

The design pass owns **only** `outputs/ux-redesign-2026-10-01/**`. Do not modify `src/`, `server/`, `shared/`, `pack/`, `docs/`, `package.json` or the lockfile. Do not install packages, commit, push, or run the repository's package build.

1. `outputs/ux-redesign-2026-10-01/SPEC.md` — screen-by-screen spec for the five moves: layout, primary action per state, empty/loading/error/stale states, copy, keyboard, responsive behaviour, and an integration map naming the production component each piece would replace or extend.
2. A runnable prototype in the same folder, following the pattern of `outputs/hermios-native-design-2026-10-01/serve.mjs` (Vite from the existing `node_modules`, `configFile: false`). Must cover: Today, Bud panel + ⌘K with context chips, workflow cards + three-step teach flow, CRM view (not-connected and sample-connected states, clearly labelled).
3. A QA script that captures screenshots at 1440×1000, 1024×800 and 390×844 into `screenshots/`, asserts zero page errors, no horizontal scroll at 390 px, and writes `receipt.json`.
4. `README.md` with run instructions, what is fictional, and open questions for the owner.

Evidence tier: source prototype only. Not a packaged build, installed device, live integration or customer acceptance.
