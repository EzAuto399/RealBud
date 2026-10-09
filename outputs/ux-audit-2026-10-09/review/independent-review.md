# RealBud 0.1.46: independent UX review (9 Oct 2026)

Judged from screenshots only. Paths are relative to `capture/`. Evidence tier: local headless renders, plus two installed-Windows shots.

## 1. Problems

| # | Screen(s) | What the person sees | Why it's a problem | Sev | Smallest fix |
|---|---|---|---|---|---|
| 1 | windows-0146-schedule, extra/seeded-schedule-all-jobs, extra/seeded-schedule-job-open, status bar | "Runs automatically… Today, 7:30 am", Run now enabled, "Next: Morning money check" at setup 1 or 3 of 5. The block only shows inside the drawer | Honest status | P1 | Row says "Waiting for setup (step 4)". No next run, no Run now |
| 2 | qa-clean-walkthrough/24-approval-waiting-1280, qa-austin-showcase/13-rule-change-card | A levy payment is shown as "Running a command in the workroom: `echo hi`", with "Allow for this task" as primary. A permanent rule change offers "Allow once" | Browser-authority decision (show the real payee and amount); safe default; the label contradicts the effect | P1 | Payee and amount in words, with "Allow once" as primary. Rule cards: "Use new rule / Keep current", with before → after |
| 3 | qa-austin-showcase/01-desk-book, windows-0146-desk-properties, qa-clean-walkthrough/14-add-property, extra/seeded-desk-tab-properties, extra/empty-workspace | "CSV live", "PMS CSV export", Add property + Import CSV as primaries, Remove on every card, "review an export" | REI is the source of truth (6 Oct) | P1 | REI packs get a "From REI · 07:00" chip and a Source column (REI / Differs from REI). Add, Import and Remove go into ⋯ |
| 4 | extra/empty-desk-hermios, extra/seeded-workspace-connected-apps, all Desk shots | A "Hermios" tab with two primaries. The copy contradicts itself ("opens inside RealBud… open it in its own browser tab") and calls it "the tab beside Needs you" | Sounds like the engine; a third-party product sits in core nav | P1 | Remove the tab. Make it a connected app only when the pack names it |
| 5 | qa-austin-showcase/06, 07, 08-w1 | The only REI write is a 7-step wizard in a Schedule drawer. It shows "Off" mid-run, and "No tenant list saved from REI yet" after the preview matched. The disabled Run now carries a circular instruction | Schedule = when, Desk = doing; dead end | P1 | Run it on a Desk tab. The drawer keeps timing, last result and "Open on Desk" |
| 6 | 02-w3, 11-w4, 06/08-w1, 23-step6-failure, 33-workspace-settings | "Mock maintenance comparison for Sherry", "SYN-P01 · property-manager", "Redbark", "model service", "Managed connections", "Gmail scope", "…csv · 413 bytes · UTF-8 · digest", "Source-run key. This is not a production distribution" | Copy rules; trust | P1 | Copy sweep. Dev banner in dev builds only. Pack labels name vendors ("ANZ bank feed") |
| 7 | 23-step6-failure, 02-w3, 03-w2, 12-desk-empty, extra/seeded-workspace-approvals | "Open Agency workflow setup" twice (with different capitals), "set in Agency setup", "Add connector https://… access token" | FDE decision: staff don't see config | P1 | An "Ask the RealBud team" request card. Move the connector form to the FDE console |
| 8 | 01-desk-book, extra/seeded-desk-tasks | One queue counted four times: sidebar, "Task queue · Status" dropdown, Today tiles, Approvals waiting (same 3 items). Evidence repeats item 1 | Duplication; Hick's law | P2 | The sidebar is the only filter. Delete the dropdown and tiles. Today shows time-bound items |
| 9 | 01-desk-book, 09-bud-ready-desk, extra/empty-workspace | Three onboarding surfaces: Get started, "Your first day with Bud 0 of 5", Workspace "Start here". Get started sits above 3 waiting approvals | Competing instructions | P2 | One checklist. After step 3 it shrinks into the status bar |
| 10 | 09, 12-desk-empty, extra/empty-desk-get-started, 01 | Two filled primaries ("Open packs…" or "Enter link code", plus "Add properties"). Header: Check tasks + Ask Bud + More + Other work | One primary per screen | P2 | Setup screens show only the step's action. Header: primary, Ask Bud, ⋯ |
| 11 | extra/seeded-desk-other-work-menu, extra/seeded-desk-more-menu, 02-w3, 11-w4, 12-w5 | Bills is both a tab and an "Other work" item. More › "Properties and imports" repeats a tab. Mail, supplier and inspection work render under the Bills tab | One home per thing; Jakob's law | P2 | Tabs only. Delete Other work |
| 12 | 22-schedule-needs-you-empty, 20-work-answer | Four ways to make a job: Add a job, Show Bud a task, Make this repeatable, Schedule work | FDE owns config; Hick's law | P2 | "Make this repeatable" becomes a request to the team. Hide Add a job |
| 13 | windows-0146-schedule, 22, 06-w1, 33, 01 | "Loops" vs "jobs". "Other jobs" under the Scheduled tab. Sidebar "Next Fri 7:30" beside the row's "Today, 7:30". Sidebar and list differ in order and members. One check has four names: Money check, Check tasks, Recheck, Run the morning check | Consistency | P2 | One noun, one name per job, one date helper |
| 14 | 02-w3, 03-w2, extra/seeded-workspace-*, 01, 24 | Paragraph status ("4 candidates, 4 prepared, 0 held…") and three look-alike mail buttons. Disabled buttons give no reason. "Approving… does not send", with no next step. "Waiting for you", "Working for 0s" and "Answer the request above" all at once; three Stop controls | Honest status; dead ends | P2 | One button with a one-line result. A reason next to each disabled button. Say who sends. One waiting line, one Stop |
| 15 | extra/seeded-workspace-approvals, extra/seeded-right-panel-more-panels, extra/seeded-desk-more-menu | "Approvals" is both the pending items and a policy page. "Connected apps" vs "accounts". "Activity" vs "Bud activity" | Consistency | P2 | Call the policy "Ask-first rules". One noun for each thing |
| 16 | all, 11-w4-findings | Icon-only rail. Workspace reuses the app logo. An unexplained "!" | Recognition over recall | P2 | Labels, a distinct icon, text for each badge |
| 17 | extra/empty-desk-get-started vs 01-desk-book, 06-linked | Before any pack, step 4 says "Sign in to the office Gmail"; Austin needs REI. "Model access is set up", then "Continue to Bud setup" | Core hard-codes pack facts | P2 | Steps 3–4 copy comes from the pack |
| 18 | 30-recovery-card | An unconfirmed A$1,240 payment with "It happened" as the filled primary | A biased default on money | P2 | Equal-weight buttons |
| 19 | 03-w2, 05-w2, 11-w4, 12-w5, 08-w1, 20, qa-desktop-shell/03-arrange-desk | 09/10/2026, 2026-10-14 and 9 Oct mixed; "3060.00"; "1 properties"; "Fictional Cou…". The greeting "Morning money lives on Desk" is a PM noun in core. "Simple desk" vs "Reset to recommended" | Polish; pack nouns leak into core | P3 | One formatter. The greeting comes from the pack. One reset button |

## 2. Department-adaptable model

**Core:** rail; the queue states Needs you / Next / Waiting / Done today; how a work item looks (why, evidence, proposed action, Approve/Edit/Decline, recovery); approval and recovery cards; the three locked right-panel cards; Schedule mechanics (on/off, next run, blocked reason, last result, link to Desk); the source-freshness chip; the 5-step setup; formatters; permissions.

**Pack (declared, installed by the FDE):** the main noun and its record tab; columns and filters; the source for each noun (REI, bank feed or none). The source alone decides whether Add/Import/Remove show. The pack also supplies up to 3 work tabs with one primary each, starter jobs (off, with the sources each needs), extra right-panel cards, setup copy, and Bud's greeting and examples.

**Rule:** Schedule says *when*. Desk is where the work happens. Every job links to its Desk tab.

```
(a) PM office, REI
DESK  [From REI · 07:00]                     [Approve next] [Ask Bud] [⋯]
Tabs: Needs you 3 | Properties | Bills | Inspections
Properties: Address | Tenant | Rent | Arrears | Source (REI / Differs)
Right: Evidence · Approvals waiting · Today (inspections, bills due)
SCHEDULE  Needs setup: Bank references – [Sign in to REI]
          On: REI refresh 07:00 · Money check 07:30 · Owner letter Fri
          Off: Mail priorities · Supplier check · Inspection plan

(b) Sales, no PMS
DESK  [Kept in RealBud]                      [Add contact] [Ask Bud] [⋯ Import]
Tabs: Needs you | Contacts | Listings | Open homes
Contacts: Name | Stage | Last contact | Next step
Right: Evidence · Approvals waiting · Today (callbacks, open homes)
SCHEDULE  On: Mail priorities 08:00 · Vendor report Fri
          Off: Open-home follow-up Sun 18:00

(c) Accounts
DESK  [From REI + ANZ feed · 08:00]          [Review 4 unmatched] [Ask Bud] [⋯]
Tabs: Needs you | Bank references | Bills | Owner statements
Bank references: Date | Amount | Matched to | Status
  stepper here: Review › REI upload › You process › Check
Right: Evidence · Approvals waiting · Today (month-end, uploads)
SCHEDULE  On: Bank pull 08:00 · Money check 07:30
          Needs setup: Supplier check – needs Gmail
```

## 3. First-run journey

**Contradictions:** jobs "run automatically" before linking, a pack or sources (row 1). Work says "Bud ready" at step 3, and Desk offers "Ask Bud" while the composer is blocked (extra/empty-work-one-turn-composer-disabled). Desk pushes "Add properties" before the pack declares REI (09, 12). Workspace "Start here" competes with Get started. The sample book sits under a 0-of-5 setup card (extra/seeded-desk-tasks). W1 shows "Off" mid-run.

| # | Screen | Primary |
|---|---|---|
| 0 | Welcome: your name ("Explore sample" opens a clearly badged sample) | Continue |
| 1 | Link this computer | Paste link code |
| 2 | Bud getting ready (auto-advances) | (none) |
| 3 | Office pack: what it adds. If none, "Ask your RealBud team" | Add pack |
| 4 | Sources the pack needs, one at a time | Sign in to REI, then Connect Gmail |
| 5 | First copy: "128 properties from REI, 07:00" | Bring in today's copy |
| 6 | Jobs, with the recommended set ticked | Switch on 3 jobs |
| 7 | Desk › Needs you, setup card gone | Approve on the first item |

Until step 6, Schedule rows read "Waiting for setup" and the status bar shows no "Next:".

## 4. Top 10 changes

1. **Honest job state before setup.** (S)
2. **Plain-language approval and rule cards** with the real payee and amount; Allow once as primary. (M)
3. **REI as the source on Desk:** chip, Differs column, Add/Import/Remove demoted. (M)
4. **One queue:** the sidebar filters; delete the dropdown and tiles. (S)
5. **Move run steppers (W1 and others) to Desk tabs.** Schedule keeps timing only. (M)
6. **Remove the Hermios tab.** (S)
7. **Copy sweep:** mock names, vendor and engine terms, IDs, the dev banner, one formatter. (S–M)
8. **One onboarding path** in the order above. (M)
9. **Pack-declared Desk:** tabs, columns, primary, jobs, greeting. (L)
10. **Swap staff-facing config for "Ask the RealBud team" requests, and label the rail.** (M)
