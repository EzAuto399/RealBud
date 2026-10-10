# Desk work areas: one Desk that fits each office's workflows

**This does not establish:** a built feature, user-tested benefit, packaged or installed behaviour, or customer acceptance.

Date: 10 October 2026. Status: **proposed design**, not built. Evidence tier: source survey plus local renders of today's Desk (fictional sample book, isolated temp home, no worker). Mockup and screenshots: [outputs/desk-work-areas-2026-10-10/](../outputs/desk-work-areas-2026-10-10/).

This is the concrete Desk layer of [the reusable-shell brief](PRODUCT-DESIGN-BRIEF-2026-10-10.md) (shell owns authority and recovery, packs supply view presets from a registry of approved layouts). It does not change that contract.

## 1. Problem, from today's renders

1. **Workflow results are hidden.** Mail priorities and the bills calendar sit behind the "Other work" dropdown. Bank reference review sits only in the Schedule job drawer (`schedule/JobDrawer.tsx:401`). The main Desk view (Tasks) shows only the rent queue, so Kevin's three workflows never show "something needs you" there.
2. **Each workflow panel opens as a setup page.** Mail priorities shows three equal-weight buttons, schedule controls and five "(0)" filters before any work (`now-mail-priorities-1280.png`). The bills calendar starts below the fold, after three paragraphs of caveats (`now-bills-board-1280.png`).
3. **Customize desk does less than it says.** Three of its seven checkboxes (mail, bills, shared work) change only the dropdown menu, not the page (`DeskPage.tsx:805-815`).
4. **Notices are uneven.** Only weekly bills and morning priorities send a desktop notice (`src/lib/notify-routine.ts`). Bank review gets none, and there is no in-app record of what is new.
5. **Small faults found.** With a work panel open, two "Back to tasks" controls show at once. At 390 px the header wraps to two rows, and "Check sample tasks" appears twice.

## 2. Product, user, job

- **Archetype:** desktop work tool for office staff. Dense, desktop first, 390 px must stay usable.
- **Primary user:** an office worker who runs two to five workflows every working day, for example Kevin (accounts: bank references, bills, morning mail). They are non-technical, so frequency favours one list they can trust over many screens.
- **Job:** "Open RealBud in the morning, see everything that needs me across my workflows, deal with it, and know nothing was missed."
- **Happy path:** Kevin opens Desk, sees 6 items in Needs you, deals with the missing water bill (drafts a follow-up), clears the bank references and closes the day with Needs you at 0 and every area marked "checked".

## 3. The design

**Desk = a fixed shell, Needs you, then one tab per workflow ("work area").** The office's workflow pack supplies the areas. Each area renders with one layout from a short approved list, chosen by what the work is about.

| Layout (registry) | Use when the work is about | Today's component | First users |
|---|---|---|---|
| Review list with detail | decisions on found items | `DeskCase` queue/detail | rent tasks, bank references, maintenance findings |
| Priority list | triage by urgency, snooze, done | `MailWorkPanel` | morning priorities |
| Calendar with agenda | dates: due, expected, forecast | `BillMonthCalendar` + `SourceBillsPanel` | bills & calendar |
| Table | comparing many rows | saved-view list | book / properties (later) |

Every area uses the same four parts, so all workflows read alike:
1. **Tab** with a count of items that need you. A problem adds a "!" marker with a text label, never colour alone.
2. **Status line:** what ran, when, what it found, what runs next, and **Check now**. It never says "nothing new" unless a full check succeeded (`ui.md` honesty rule).
3. **Body** in the area's layout.
4. **Setup and schedule** controls stay one level down, in a collapsed "Setup" disclosure. They never sit above the work.

**Needs you** is the first tab and is always shown. It projects items from every area into one list: a Problems group, then Needs your review. Each row names its workflow in text, what was found, why it needs you and the next step. Stored states stay in their own stores; Needs you is a display adapter (brief §4, step 4).

**Notices ("found something / needs review")**
- In app: tab counts, a "New" label on items found since you last looked, and a "N new since you last looked" note in the status line. Arrivals are announced through a polite live region.
- Desktop notice, set per area to Each new item, One summary per run, or Off. Clicking the notice opens Desk on that item.
- **Problems always notify and always appear in Needs you:** a check that didn't run, expired access, or a held run. This cannot be turned off.
- No email or SMS notices. They are not built, and would be a separate decision.

**Light tuning: "Arrange Desk"** replaces Customize desk. It has one row per area:
- show or hide the area;
- move it up or down;
- choose its notice level;
- choose list or calendar where both exist.

Needs you is locked first. Below the rows are three actions: Save, Reset to office default, and Undo last change. The sheet says what it changes: "Changes only your view. Your office's workflows and permissions stay the same." Bigger changes, such as a new area or another office's layout, come from the pack or from asking Bud. No "Change with Bud" button until Ask can apply that change.

## 4. What a pack declares (preset only)

```json
"desk": { "areas": [
  { "workflow": "morning-priorities", "title": "Morning priorities", "layout": "priority-list", "notify": "summary" },
  { "workflow": "bills-calendar", "title": "Bills & calendar", "layout": "calendar", "notify": "each" },
  { "workflow": "bank-references", "title": "Bank references", "layout": "review-list", "notify": "each" }
] }
```

Rules:
- Layout names must exist in the registry, or validation refuses the pack.
- A preset grants no access and starts no work.
- A person's hides, order and notice choices survive pack upgrades.
- A new area from an upgrade appears at the end of the list.
- Unknown fields are ignored by older cores.
- v1 packs, which have no `desk` key, keep today's Desk.

## 5. State matrix (every area)

| State | Status line | Body | One next action |
|---|---|---|---|
| Not set up | "<Area> isn't set up yet" | what it needs, plain words | Finish setup |
| Checking | "Checking Gmail… started 8:00 am" | items appear as found | Stop |
| Found items | "Checked … · N to review · next …" | the layout | open first item |
| Nothing new | "Checked Mon 6 Oct, 8:03 am · next …" | "No new bills in 214 messages from 1–6 Oct." | See this month |
| Didn't run | "Didn't run · Mon 8:00 am" | why, and what hasn't been checked since | Check now |
| Access expired | "Problem · since Fri 10 Oct" | "Nothing has been checked since." | Reconnect Gmail |
| Stale (>12 h older than its cadence) | "Last checked 3 days ago" | items, marked stale | Check now |
| Conflict | "This card changed — open it again" | draft kept | Open again |

Edge paths:
- **Error:** a decision fails. The item stays, the draft is kept, and a plain reason appears with a retry.
- **Empty:** for a new office, Needs you shows each area's setup state, never "Nothing needs you".
- **Interrupt:** the selected area, item and drafts persist across refresh. URL: `#/desk/<area>/<item>`.

## 6. Assumptions (riskiest first)

| Belief | Evidence | Risk if wrong | Cheapest test |
|---|---|---|---|
| One cross-workflow list beats separate screens for Kevin | design judgment; the owner asked for "notification of something found" | staff ignore a long mixed list | 15-min task test with the fictional book: time to find the missing bill, today vs mockup |
| Three layouts cover the Austin and Sherry workflows | survey of W1–W5 docs | W5 inspections need a week planner | map W5 to the calendar layout on paper first |
| Desktop notices per area are enough | W1–W3 decisions ask for completion and exception notices | someone misses a problem while away from the PC | count missed problems in the first two weeks of use |

## 7. Build slices (each one verifiable alone)

1. **Areas as tabs** (about 5 h). Promote the existing mail, bills and shared-work panels from the dropdown to Desk tabs driven by today's `sections` layout. Remove "Other work" and the duplicate "Back to tasks". Add the shared status line. Rewrite the Customize copy to match what it does. Keep the header on one row at 390 px. No schema change.
2. **Needs you across areas** (about 1 day). Add a display adapter from mail "needs attention", bill findings (`missing-review`, `coverage-hold`), bank pending corrections and routine problems into one list. Add per-area notice levels by extending `notify-routine.ts`. Problems always notify.
3. **Pack presets and Arrange Desk** (1–2 days). Add the `desk.areas` manifest extension, with validation, preview and rollback. Keep pack defaults and personal overrides separate. Move bank review into a Desk area. Prove it with two fictional packs (brief §4 step 3).
4. **Area cleanup** (about half a day). Fold setup and schedule controls into "Setup". Give one primary action per area. Drop zero-count filters.

## 8. Verification plan

- 1280, 768 and 390 px renders of every area in each state above, forced with fictional fixtures.
- 390 px with no page-level horizontal scroll; only the tab strip scrolls.
- Keyboard walk: Desk, then the tabs (arrow keys), the list, the detail, the decision, and back.
- Contrast pairs to check: muted on inset and on selected. These fail today at 4.45:1 and 4.17:1; use `ink-secondary-strong`.
- Existing `qa-customizable-desk.mjs` and Desk unit tests stay green.
- New: notice routing per level, and the Needs you projection.

## 9. Limits

This document is a design. Nothing in it is built. The mockup is static HTML with fictional data, and the "now" screenshots are local fictional renders. Neither is customer evidence. No user testing has been done yet.
