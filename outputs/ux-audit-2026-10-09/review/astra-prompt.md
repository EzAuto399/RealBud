You are an independent senior product/UX designer reviewing RealBud, a desktop app (Electron, Mac + Windows) for real-estate agency staff. Read-only: do not edit any file. Judge only from the attached screenshots and the facts below.

## Product facts (from owner decisions)
- RealBud is a "business work OS"; Bud is the AI assistant inside it (Hermes agent headless underneath, never shown). Austin/Auston Realty (property management office; staff Kevin = accounts, Sherry = property manager) is the first customer and "workflow pack". The core must adapt to different departments of real-estate agencies (property management, sales, leasing, accounts, admin) through packs; "keep property and REI specifics in the pack and adapters" (21 Sep decision).
- Shell (5 Oct decision): icon rail (Desk / Work / Schedule, Workspace at foot), context sidebar, tabs across main, main content, right context panel (Evidence, Approvals waiting, Today), slim status bar. Calm defaults; staff Show/Hide and "Arrange Desk"; safety/approval/recovery cards can't be hidden; bigger changes go through Bud approval cards.
- FDE decision (8 Oct): RealBud's own team (FDE) configures packs/workflows; customers use the work and make permitted decisions; customer screens shouldn't expose pack internals or rule editors.
- REI Cloud (the office's property-management system) is the source of truth (6 Oct): Desk keeps a dated local copy of REI facts refreshed by a 07:00 read-only "REI morning refresh" job (off by default); REI wins on conflict; Desk edits are held as "Differs from REI". Desk still offers "Add property" and "Import CSV" as primary actions. RealBud's own records: tasks, evidence, approvals, bill predictions/calendar from Gmail (W2), morning mail priorities (W3), supplier checks (W4), inspection drafts (W5), bank reference batches (W1, the only write to REI: an approved upload to REI's receipting preview).
- Setup has 5 stages: link computer → Bud set up → import office pack → connect sources → review and switch on workflows.
- Desktop-only product (phones use Telegram). Copy rules: plain words for non-technical office staff; no engine names (Hermes, MCP, broker).

## Screenshots
Mostly Mac headless renders of v0.1.46 with fictional data, in two states: "empty" (brand-new office) and "seeded" (fictional sample or Austin book). Two files named windows-0146-* are the owner's real Windows install of 0.1.46 mid-setup (setup 3 of 5).

## Task
1. List every contradiction, duplication, dead end, unclear label or confusing flow you can see, as a table: # | screen(s) | what the person sees | why it's a problem (name the decision or UX law) | severity (P1 blocks or misleads, P2 friction, P3 polish) | smallest fix. Be concrete; cite the filename. Aim for completeness; group similar items.
2. Information architecture: propose a department-adaptable model. What belongs to core (same for every agency/department) vs what a pack supplies (nouns, tabs, columns, primary actions, starter jobs, right-panel cards). Show how the Desk and Schedule screens would look for (a) a PM office with REI, (b) a sales department with no PMS, (c) accounts. Keep it to what the existing shell can express.
3. The first-run journey: where setup state and the work screens contradict (e.g. jobs "run automatically" before a pack/sources exist), and the ideal sequence of screens with one primary action each.
4. Top 10 changes ranked by impact on a non-technical office worker's day, each with effort S/M/L.

Write plainly. No preamble. Markdown.
