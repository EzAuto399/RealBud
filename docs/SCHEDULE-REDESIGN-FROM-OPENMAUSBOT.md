# Schedule redesign — what to learn from OpenMausBot

**Status:** PROPOSAL. Nothing implemented. Awaiting an explicit scope decision.
**Date:** 11 September 2026
**Sources inspected:** `github.com/milind-soni/OpenMausBot` cloned to `/tmp/rb-audit/omb-ref` (read-only reference); RealBud `src/components/RoutinesPage.tsx`, `src/components/schedule/*`, `src/lib/schedule-week.ts`.

**Constraint check (from `CLAUDE.md`):** *"OpenMausBot upstream: take harness/safety only... Do not take iOS, extra engines, teams, plugins, or their model shop."* This proposal takes **design patterns and interaction structure only**. No OMB code is copied, and no OMB product concept (bots, calls, webhooks, groups, rooms) is imported. RealBud's Schedule is named loops on the RealBud clock and stays that way.

---

## 1. The core diagnosis

The user's complaint — *"a bit messy and unorganized, hard for a user to navigate and understand"* — is accurate, and it has a **structural** cause rather than a cosmetic one.

RealBud's Schedule is **one long document with four stacked sections**, and its "navigation" is four buttons that scroll to anchors:

```tsx
// RoutinesPage.tsx:577-590
<nav aria-label="Schedule sections">
  {[["schedule-week","This week"], ["bud-job-builder","Job plans"],
    ["schedule-runs","Results"], ["schedule-packs","Import packs"]]
    .map(([id, label]) => (
      <button onClick={() => {
        const section = document.getElementById(id);
        section?.scrollIntoView({ block: "start" });
        section?.focus({ preventScroll: true });
      }}>{label}</button>
    ))}
</nav>
```

Measured live: **`documentHeight = 2235 px` on a 950 px viewport** — the user scrolls 2.35 screens through content they mostly do not want, to reach the part they do. Selecting "Results" does not show results; it scrolls past job plans.

OpenMausBot does the opposite. Its tabs **switch content**:

```tsx
// RoutineCalendarPage.tsx — section switcher
<button aria-pressed={section === "calendar"} onClick={() => setSection("calendar")}>Schedule</button>
<button aria-pressed={section === "logs"}     onClick={() => setSection("logs")}>Logs {unseenFailures > 0 && <span>{unseenFailures}</span>}</button>
<button aria-pressed={section === "webhooks"} onClick={() => setSection("webhooks")}>Webhooks</button>
...
{section === "webhooks" ? <WebhooksPanel/> : section === "logs" ? <RoutineLogs/> : <CalendarGrid/>}
```

One section fills the viewport at a time. This is the single highest-value change available.

---

## 2. Side-by-side

| Concern | RealBud today | OpenMausBot | Verdict |
|---|---|---|---|
| **Section nav** | 4 buttons that scroll to anchors; all four sections stacked; 2235 px page | Segmented switcher, one section at a time, `aria-pressed`, live badge on the failing section | **Adopt** — this is the user's complaint |
| **Date navigation** | None. `WeekCalendar` always renders the current week; no prev/next/today; grep for `prevWeek\|nextWeek\|anchor\|weekOffset` returns nothing | `‹ Today ›`, a "Schedule range" select (Day / 3 days / Week), `calendarRangeLabel(rangeStart, viewDays)` | **Adopt (reduced)** — navigation yes, 3-day range not needed |
| **Month orientation** | None | `MiniMonth` — 42-cell Monday-first grid, month label, ‹ › month paging, `aria-label="Mini calendar"` | **Adopt, low priority** |
| **Schedule phrasing** | `scheduleSummary()` → `"Weekdays 7:30 am"` — **missing the word "at"**. It renders in the per-loop edit card and its collapsed fallback (`RoutinesPage.tsx:288,296`), and in `JobWorkspace.tsx:784` via `recipeScheduleLine`. The **week card does not use it** — `WeekCalendar.tsx:146-147` shows only `slot.name` ("Morning") and the time | `scheduleLabel()` / `scheduleSentence()` → "Every weekday at 7:30 am", "Every 15 minutes · weekdays · 9:00 AM–5:00 PM · until Mar 3, 2027" | **Adopt the phrasing**; the helper already exists in RealBud, is missing a word, and is not surfaced on the week card |
| **Creating a job** | No single obvious "New". Job creation lives in the "Teach Bud a job" section, below the fold | A `New` menu with three described choices ("Scheduled task — Ask a bot to do something later") | **Adopt the pattern**, adapted: RealBud has fewer kinds |
| **Calendar rendering** | 7-row list of day rows with pill slots (`WeekCalendar.tsx`) | Hour grid, `role="grid"` + `role="columnheader"`/`gridcell`, 24 h rows, drag-to-create, resize | **Do NOT adopt** — see §4 |
| **Loading / error / empty** | `jobsLoading`/`jobsError` passed only to `JobWorkspace`; no page-level state | `routinesLoadState === "loading"` → `role="status"`; `"error"` → `role="alert"` rendered in the toolbar | **Adopt** — small, honest, improves recovery |
| **Run history** | "Results from all jobs" section in the same scroll | Dedicated Logs section with its own failure badge | **Adopt** (follows from §3.1) |

---

## 3. What I recommend adopting

### 3.1 Section switching replaces scroll-to-anchor *(highest value)*

**Current:** clicking "Results" scrolls; nothing is hidden or shown.

**Proposed:** four real sections, one visible at a time, as a segmented control using the existing `pm-control` styling and the `aria-pressed` pattern OMB uses:

```
[ This week ] [ Job plans ] [ Results (3) ] [ Import packs ]
```

- "This week" remains the default landing section.
- "Results" carries the unseen-failure badge that **already exists** at `RoutinesPage.tsx:561-575` — today it scrolls to the Results *section*; it would select the Results *section*. Same data, better destination.
- Keep the section ids (`schedule-week`, `bud-job-builder`, `schedule-runs`, `schedule-packs`) so the existing `deep-link`/`showRoutines` store action and the `dispatch({ type: "showRoutines", section: "logs" })`-style calls keep working.
- **Rename "Import packs"** → keep, but the label "packs" is on `DESIGN.md:148`'s ban list for non-Advanced surfaces ("No technical terms such as pin, pack, headless, recipe or revision outside Advanced diagnostics"). Flag for a separate decision.

**Acceptance test:** page height at 1512×950 drops from 2235 px to ≈950 px; only one section's heading is in the accessibility tree at a time; `aria-pressed="true"` follows the visible section.

**Risk:** users with muscle memory for scrolling may briefly hunt. Mitigation: keep the order identical to today's vertical order.

### 3.2 Give the week a direction

**Current:** the calendar is frozen on the current week.

**Proposed:** add `‹ Today ›` plus a range label to the WeekCalendar header, exactly where the existing `todayHint()` already renders the range (`WeekCalendar.tsx:77`). Introduce an `anchorMs` prop and compute the week from it rather than from `nowMs` alone. RealBud already has `mondayOfWeek(nowMs, timeZone)` (`schedule-week.ts:186`), so the arithmetic exists.

**Skip** OMB's Day / 3-day / Week range select — RealBud's loop counts are small and a 7-day horizon is the right fixed unit.

**Acceptance test:** `›` shows next week's dates; Today returns; the "today is quiet" hint only appears on the actual current week.

### 3.3 Say what the schedule actually is

**Current:** the week card shows `Morning` + `7:30 am`. The user cannot tell that "Morning" runs weekdays only, or that a job is on-demand rather than scheduled.

**Proposed:** use the phrasing helper that **already exists in RealBud**. `scheduleSummary()` returns `"Weekdays 7:30 am"` — two fixes needed:
1. **Add the missing "at"** → `"Weekdays at 7:30 am"`. OMB's version reads `"Every weekday at ${niceTime(...)}"`. This is a one-line copy fix with a test.
2. **Render it on the week card**, under or beside the slot name, as OMB does with `scheduleLabel(call.schedule)`.

Keep RealBud's own vocabulary (Morning / Letter) as the primary label; the schedule phrase is the qualifier.

**Acceptance test:** a weekday-only job is distinguishable from a daily job from the week card alone, without opening Edit.

### 3.4 One obvious way to create

**Current:** no single create affordance; job creation sits inside a section below the fold.

**Proposed:** a `New job` control in the Schedule header, opening the existing `JobWorkspace` create path. Do **not** copy OMB's three-item menu — RealBud has effectively two kinds (a named loop, and a one-off "Teach Bud a job"), and a two-item menu is not worth a menu.

**Acceptance test:** from landing on Schedule, a user reaches the create form in one action without scrolling.

### 3.5 Honest loading and error states on the page itself

**Current:** `loading`/`loadError` are plumbed only into `JobWorkspace`. The Schedule frame shows nothing while loops load or if the read fails.

**Proposed:** a page-level `role="status"` while loops load with an empty list, and `role="alert"` on a failed read — the pattern OMB uses and that RealBud already applies correctly elsewhere (`RoutinesPage.tsx:592-611`).

**Acceptance test:** with the loops read failing, the page says so rather than rendering an empty week.

---

## 4. What I recommend explicitly NOT adopting

**The hour-grid calendar.** OMB centers a 24-hour × N-day grid with drag-to-create, drag-to-resize, and pointer-based slot selection. Adopting it would be a mistake here:

- RealBud's loops are **few and long-horizon** — one or two runs a day ("Morning 7:30 am"), not many short appointments. A 24-hour grid renders mostly empty space, which is the opposite of the density `DESIGN.md:11-17` asks for.
- Grid interactions are **pointer-only**. RealBud's keyboard and accessibility position is currently strong (verified `role="listbox"`, real dialog focus traps, visible focus on 61/61 controls). Drag-to-create and drag-to-resize would need full keyboard equivalents to avoid regressing that, for a task a time field already solves.
- It would import OMB's product model (calls, durations, 15-minute slots) which `CLAUDE.md` excludes.

RealBud's 7-day list is the **right** primitive for this product. It needs navigation and better labels, not replacement.

**OMB's tiny type.** Their UI runs at 9.5–12 px (`text-[9.5px]`, `text-[10.5px]`). RealBud's `DESIGN.md:55` sets 14–15 px operational text and 12 px labels, and F6 in the audit already flags RealBud's own 10.5 px as too small. Do not import their scale.

**Drag-a-bot-onto-a-time.** OMB's sidebar drag source is built around multiple bots. RealBud has one worker and `DESIGN.md:96` forbids presenting it as a roster.

---

## 5. Suggested staging

| Stage | Change | Effort | Risk |
|---|---|---|---|
| **S1** | Section switching (§3.1) | ~1 day | Medium — restructures the page, but no data changes |
| **S2** | Week navigation + "at" fix + schedule phrasing on the card (§3.2, §3.3) | ~1 day | Low |
| **S3** | `New job` entry point (§3.4) + page-level load/error states (§3.5) | ~0.5 day | Low |
| — | Hour grid, 3-day range, mini-month | **deferred** | — |

S1 is the one that answers the complaint directly; S2 makes the content understandable once it is reachable.

**Dependencies and blockers:**
- **`main` does not currently build** (`ChatView.tsx:368` passes `onSendToPhone`/`onSendSummary`/`phoneHandoffBusy`; `AskMessage.tsx:11` accepts none). Nothing here can be verified until that is fixed.
- `RoutinesPage.tsx` already carries **+278/−406** of uncommitted work, and `JobWorkspace.tsx` is in the same change set. S1 touches the most contested file in the pending diff — it should be sequenced **after** that work lands, or explicitly coordinated.
- The label "Import packs" conflicts with `DESIGN.md:148`; renaming is a separate decision, not part of this proposal.

**No user testing has been done.** §5's effort figures are expert estimates, and every acceptance test above is a *proposed* test, not a result.
