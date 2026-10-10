# Desk work areas: one Desk that fits each office's workflows

**This does not establish:** user-tested benefit, packaged or installed behaviour, or customer acceptance.

Date: 10 October 2026. Status: **built** on `claude/desk-work-areas` (slices 1–4, §11), not released. Design evidence tier: source survey plus local renders of today's Desk (fictional sample book, isolated temp home, no worker). Mockup and screenshots: [outputs/desk-work-areas-2026-10-10/](../outputs/desk-work-areas-2026-10-10/).

This is the concrete Desk layer of [the reusable-shell brief](PRODUCT-DESIGN-BRIEF-2026-10-10.md) (shell owns authority and recovery, packs supply view presets from a registry of approved layouts). It does not change that contract.

## 1. Problem, from renders of current `main`

Rendered from `origin/main` (e54b401c) plus the 0.1.49 branch. An earlier draft of this section described the shared checkout, which was 586 commits behind; that draft is withdrawn.

1. **Three overlapping ways to reach the same work.** Area tabs (Tasks, Hermios, Properties, Bills), an "Other work" dropdown that repeats Bills next to Mail and Shared work, and the left context sidebar. At 390 px the tab row breaks: "Properties" and "Bills" stack beside "Other work".
2. **Each workflow panel opens as a setup page.** Mail priorities shows three equal-weight buttons, schedule controls and five "(0)" filters before any work. The bills calendar starts below the fold, after three paragraphs of caveats. Bank reference review exists only in the Schedule job drawer.
3. **Arrange Desk exists but promises more than the page does.** Mail, bills and shared work only add or remove "Other work" items, activity only gates a menu item, and card order is ignored in the task area. More → "Desk options" still holds a block marked "Temporary manual fallback until Bud can arrange Desk" (`DeskPage.tsx:801`). The Workspace layout flag `showBud` has no reader.
4. **Bud cannot arrange Desk natively.** Its only layout path is the `sections` argument of `views_create`, behind a once-only approval card, with no Undo. The renderer's refresh waits for a tool `item.completed` that the server never broadcasts (`server/product-mode.ts`), so an open Desk changes only on focus or remount.
5. **Notices are uneven.** Only weekly bills and morning priorities send a desktop notice (`src/lib/notify-routine.ts`); bank review gets none, and nothing marks what is new in the app.

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

**Light tuning: the existing "Arrange Desk" sheet**, extended from cards to work areas. It has one row per area:
- show or hide the area;
- move it up or down;
- choose its notice level;
- choose list or calendar where both exist.

Needs you is locked first. Below the rows are three actions: Save, Reset to office default, and Undo last tab or card change. The sheet says what it changes: "Changes this computer's Desk. Your office's workflows and permissions stay the same." (The layout is saved per computer, not per person.) **Bud arranges Desk through the same path.** One Bud tool changes the same layout through the same server route as the sheet (revision check, history). Because it changes only the person's own view, it applies at once and Ask shows a receipt with Undo; deleting a saved view keeps its approval card. The server announces every saved layout, so Desk re-reads at once whoever made the change. Bigger changes, such as a new area, come from the pack.

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
- Older cores refuse a pack with a `desk` key (`server/customer-packs.ts` allowlists every field), so a pack that presets Desk needs core 0.1.50 or later.
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

1. **Bud arranges Desk; areas as tabs** (about 1 day). One write path for the sheet and a Bud tool, with receipt and Undo. A server event on every saved layout replaces the client refresh hook. Mail, bills and shared work become tabs. Remove "Other work", the temporary "Desk options" block, `showBud` and `views_create`'s `sections`. Keep the tab row on one line at 390 px.
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

The mockup is static HTML with fictional data, and the "now" screenshots are local fictional renders. Neither is customer evidence. No user testing has been done yet. What was built and verified, and its limits, is in §11.

## 10. Build decisions for slices 2–4 (10 Oct 2026)

Facts from the source survey that change the plan:
- Mail, bills and bank data load only when their panel opens; no server event carries them.
- Notices come from the static `notify` flag in `shared/workflow-catalog.ts`. Bank references is off, and maintenance and inspections are on.
- Bill findings also include `review-hold`.
- A notice click always lands on Tasks.

Contracts, written first so packets can build in parallel:
- `shared/desk-areas.ts`:
  - areas `mail`, `bills`, `bank`, `shared-work`;
  - the layout registry and the layouts each area can render;
  - notice levels Each new item / One summary per run / Problems only;
  - area to pack workflow, and area to scheduled jobs;
  - `OfficeDesk`, the office preset: from the active pack, else `coreOfficeDesk()`.
- `shared/needs-you.ts`:
  - `GET /api/needs-you` is projected on the server from each store, so Desk makes one read instead of opening every panel;
  - problems come first;
  - stable `<source>:<id>` keys;
  - a source that can't be read is listed as unavailable, never shown as empty.
- Layout file v3:
  - adds the `bank` section (appended at the end);
  - each area section may carry the person's own `notify` and `layout`; absent means the office preset;
  - a missing known section is filled at the end instead of sending the file to recovery;
  - an unknown section is still refused.

Packets (each with its own worktree and file list):
1. Layout v3, the office preset in the response, and Bud's `desk_arrange` choosing notice and layout.
2. The Needs you server projection.
3. Pack `desk.areas`: validation, preview, and the office preset from the active pack, proved with two fictional packs. Austin's pack is unchanged in this release.
4. Area cleanup:
   - setup and schedule controls folded into a collapsed "Setup" disclosure;
   - one primary action per area;
   - no zero-count filters;
   - a common status line (last check, next check, Check now).
5. Desk integration:
   - Needs you on the Tasks tab;
   - tab counts with a text problem marker;
   - the Bank references area;
   - Arrange Desk split into "Work areas" and "Cards on Tasks", with notice and layout choices, Reset to office default and Undo last tab or card change.
6. Notices:
   - levels per area;
   - problems always notify;
   - a click opens the area that sent the notice.

## 11. What was built (10 Oct 2026)

Branch `claude/desk-work-areas`, not released or merged. Evidence tier: source, local tests and local renderer QA with fictional data in isolated temporary homes. There is no packaged build, installed device, live integration or customer acceptance yet.

Built (§10 packets 1–6, plus the review fixes):
1. Layout v3. It adds the Bank references section, a per-area notice level and layout, and the office preset in every answer. Bud's `desk_arrange` uses the same route.
2. `GET /api/needs-you`.
   - Mail and bills are read only when the office shows those areas.
   - Job items come only from jobs Schedule can open, within the last 100 runs.
3. Pack `desk.areas` presets, proved with two fictional packs. Austin's pack is unchanged.
4. Each area has one status line, with Setup collapsed.
   - Tasks shows Needs you.
   - Area tabs show counts, and the accessible description names them ("2 items, 1 problem").
   - Arrange Desk is split into "Work areas" and "Cards on Tasks". It has Reset to office default and "Undo last tab or card change", which is disabled while a draft is unsaved.
5. Notices per area. Problems always notify, and a click opens the area that sent the notice.
6. The simple desk keeps every work area as a tab. A startup step gives the tabs back to layouts that were applied automatically and never touched (`showAreaTabsOnAutomaticSimpleDesk`).

Also in this bundle:
- Accessibility, from the [system map review](SYSTEM-MAP-REVIEW-2026-10-10.md):
  - Muted text (`--color-ink-muted`, `--color-ink-secondary`) is darkened to `#625c52`. It now passes 4.5:1 on every surface; it had measured 3.76–4.45:1 on inset, selected, raised and raised-hover.
  - The Tasks drawer keeps Tab inside it; before, 16 of 30 Tab presses left it in Chrome. Arrange Desk uses the same shared trap. Closed from the More menu, it now returns focus to More instead of dropping it to the page.
- The pre-rename data folder moves only into the default `~/.realbud`.
- The office link comes first. An unlinked or revoked computer opens on "Connect this computer to your office" before Bud's setup screen.
  - Recovery never waits behind that screen.
  - The link step can no longer be skipped.
  - A session-only exit opens the sample desk, or saved work once the computer is disconnected.

Evidence:
- Full suite at `b1148c26`: 11,068 passed. Five failed for an environment reason: the PDF worker under `node --permission` through a symlinked `node_modules`. They pass with a real install. `pnpm check:electron`: 34/34.
- After the link-gate merge: typecheck is clean. Vitest over `src`, `shared` and the Needs you and workspace-tab server tests: 232 files, 2,931 passed.
- Renderer QA: 12 of 13 pass on the merged branch (built UI, real install): link-gate 17/17 (rerun after the copy fix), setup-stages 29/29, onboarding-setup 15/15, screen-loading 7/7, kevin-sherry-day 26/26, weekly-bills 6/6, w2-calendar 5/5, desk-work-areas 8/8, customizable-desk 9/9, desktop-shell 11/11, workspace-tabs, source-bills 30/30. clean-walkthrough is 12/13: step 6 fails the same way on `main`. Receipts: [outputs/office-link-gate-2026-10-10/](../outputs/office-link-gate-2026-10-10/).

Limits:
- These fail on `main` too: `qa-inspections` ("Visit moved." / 409 capacity) and `qa-clean-walkthrough` step 6.
- Not run:
  - `qa-shell-purpose`, which needs `QA_BASELINE`;
  - `qa-native-private-restore`, which needs a packaged build;
  - `qa-browser-link-e2e`, which needs Postgres and a website build.
- Low findings left open:
  - The Bank reference review is drafted in two places (`src/components/JobDrawer.tsx:496`).
  - A revoked computer is detected only by the server's 5-minute report.
  - A pack that declares `desk` needs core 0.1.50, and packs have no minimum-core field yet.
  - A client's own pack can't be chosen as the office pack: `AGENCY_WORKFLOW_PACK_IDS` (`shared/agency-workflow-packs.ts:4`) allows three host-coded ids, and none of those packs ships `desk`. So the pack preset is proved only with fictional packs injected in tests. This is step 1 of the [map review](SYSTEM-MAP-REVIEW-2026-10-10.md).
  - Layout `table` passes `validatePackDesk`, but no area renders it, so importing a pack that uses it is refused.
  - An older core that opens a v3 layout sends it to recovery.
- The link screen:
  - A computer whose link read is still in flight shows Desk briefly first.
  - There is no team-seat exemption, because the renderer has no reliable seat signal.
  - Whether to keep the exit is the owner's call.
