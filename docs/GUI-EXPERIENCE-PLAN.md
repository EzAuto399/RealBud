# RealBud desktop GUI — experience audit and improvement plan

Date: 2026-09-02
Status: audit complete; quick wins shipped on this branch (see §9 "Shipped"); structural work proposed.
Canonical constraints: `docs/GOAL-PROMPT.md` wins. Design language: `DESIGN.md` (Warm Operational Ledger). Do not remount first-run, add a fifth nav place, or start inbound / Pocket — `docs/NEXT-WAVE.md` still gates those. Live portal is attended saved-job runs behind Attach (2026-09-02).

Everything below was taken from the running app at a **900×600** viewport (Electron's `minWidth`/`minHeight`, `electron/main.mjs:205–206`) on an isolated data dir, plus a read of the components and server named inline. Evidence screenshots: `docs/screenshots/desk-900x600-before.png` and `docs/screenshots/desk-900x600-after.png`.

---

## 1. Audit of the current experience

### Strengths (keep)

- **Four doors, one spine.** Desk / Ask / Schedule / You (`src/components/Sidebar.tsx:150–174`) map cleanly to the product spine in `DESIGN.md`. `aria-current="page"` is set; every nav item has a label and a visible focus ring.
- **Decision structure is honest.** `DecisionBar` (`src/components/pm/primitives.tsx:184–221`) only offers Allow wording / Edit / Deny / Copy; no Send exists anywhere, and the post-allow bar says so ("Copy, then send from the PMS. RealBud did not send it.", `DeskCase.tsx`). Stale Allow is rejected server-side by revision (`server/desk.ts`) and surfaced as "This card changed — open it again" (`DeskPage.tsx:30–34`).
- **Worker readiness is proved, not assumed.** `ready` requires an installed pinned CLI, the pack in manual approvals, a workroom policy, *and* a successful hands ping persisted to `hands-ping.json` (`server/hermes-status.ts:26–47`). The Bud setup journey (`src/lib/bud-setup.ts`) shows one current step and locks later ones.
- **Onboarding is short and escapable.** Two steps, name-first, "Explore the sample desk" escape, resume via `realbud.onboarding-stage`, failed save keeps input (`Onboarding.tsx:66–136`).
- **Single-flight on the risky calls.** `/api/desk/check` runs under `deskCheckFlight` (`server/index.ts:1151–1160`); chat send returns 409 when busy; loop runs dedupe by idempotency key (`server/job-runs.ts:272–284`).
- **Motion is already restrained.** Six short shell animations (180–280 ms, transform/opacity only) with a `prefers-reduced-motion` block (`src/styles.css:4–10, 275–283`). Mascot motion is confined to the sidebar brand mark, onboarding hero and setup aside; it is not on the case canvas.
- **Tokens exist and are used.** `@theme` in `styles.css` carries the DESIGN palette; components use `bg-sheet`, `text-ink-muted`, `border-line` etc. No stray Tailwind gray palette in `src/`.

### Friction points (ordered by how often a PM would hit them)

| # | Where | Observed | Why it matters |
|---|---|---|---|
| F1 | Desk at 900×600 with cards | Header stack (title, subtitle, 5 tools, 6 count chips, keys hint, full morning brief, go-live strip) used **≈420 px of 600**. The queue drawer opened with only its filter buttons visible; the case canvas showed the address and the decision bar and **nothing of the wording being approved** (`desk-900x600-before.png`). | A PM was asked to "Allow wording" without being able to see it. This is the compact-window failure and a safety issue. **Fixed** (§9). |
| F2 | Desk Recheck miss | The hold banner leaked raw worker stderr: `⚠ tirith security scanner enabled but not available … UnrecognizedClientException when calling th)` (`server/hermes-hands.ts:202–216`, rendered `DeskPage.tsx:457–460`). No next step. | `docs/QA-LIVE-DEBUG.md` says a raw errno in UI is a bug. The real cause (no model attached) was invisible. **Fixed** (§9). |
| F3 | Same action, many doors | Recheck reachable from Desk header, Desk empty state, sidebar pulse, Ask chips, Schedule morning loop. Go-live card on Desk *and* You. Agency name on OfficeCard *and* GoLiveCard (two "Save" buttons on You). "Set up Bud" on Ask empty state, Ask banner, Ask composer, You Go-live. | Every duplicate is another thing to scan and another place a state can disagree. Ask showed the same not-ready message three times. **Partly fixed** (Ask consolidated; Desk go-live hidden in compact case view). Rest in §4. |
| F4 | Vocabulary leaks | "Hermes builds the safe plan" on Schedule (`RoutinesPage.tsx:216`); "(Hermes login)", "Recently available in Hermes", "Hermes catalogue" in the model sheet (`BudSetupCard.tsx:73,109,750,802,815`); `revision …xxxxxxxx` in the case Decisions list (`DeskCase.tsx:213`). | `DESIGN.md` zero-terminal rule: Hermes and technical identifiers only inside Advanced diagnostics. **Fixed**. |
| F5 | Queue rows | Row meta is the full case explanation (the licensee row ran to 6 lines). | Queue is a pointer, not the case. **Fixed** (two-line clamp, full text on hover). |
| F6 | Case body order | Facts grid (2×2, ~170 px) → four "None" safeguard rows (~160 px) → proposed wording. | The object of the decision sat last. **Fixed** (facts read as one row when the canvas is wide enough; safeguards fold to one line when none are in force, expandable). |
| F7 | Stuck "Saving…" | With the local service unreachable, the profile save on You sat on "Saving…" indefinitely; `api()` had no timeout (`src/state/store.tsx:774`). | A hung service must become a retryable failure. **Fixed** for the profile save (15 s budget); adopt per-call budgets elsewhere (§9). |
| F8 | Schedule page | Every loop card carries a full time/weekday retune form, the week grid repeats seven rows of the same two chips, and copy blocks explain the same clock three times ("Work on the clock", "Runs", loop descriptions). | Schedule is the least frequently visited door but the densest. Retune is a rare act; it should be a disclosure. |
| F9 | You page | 10 sections in one scroll; "Checking Bud … Check again if this does not settle in a moment" shows during a routine 1–3 s load. | A normal load should look like loading (skeleton), not like a problem. |
| F10 | Desk header chips | "Phone off", "Demo" read as system flags rather than help. Chips are also filter buttons but look identical to the informational ones. | Interactive and informational pills should differ (§5). |
| F11 | Ask history | The Ask thread starts with a fixed Bud greeting and a "Today" divider even when nothing has happened; the empty state also shows a large heading. | Two empty states for one screen. |

### Inconsistent patterns

- **Two pill systems.** `StatusLabel` (`primitives.tsx:53–69`) vs ad-hoc `rounded-full border px-2 py-0.5 text-[10.5px]` chips in `RoutinesPage.tsx`.
- **Primary button styles are inlined** (`rounded bg-agency px-3.5 py-2 text-[13px] font-medium text-white`) in DeskPage, ChatView, RoutinesPage, MorningBrief, OfficeCard, BudSetupCard, Onboarding. Only Allow/Edit/Deny/Copy go through a primitive.
- **Token aliases.** `accent`/`agency`, `panel`/`sheet`, `hairline`/`line`, `ink-secondary`/`ink-muted` are the same values under two names (`styles.css:12–37`); usage is mixed per file.
- **Dialog behaviour.** Add-property and Settings trap Tab; the CSV review dialog does not (`DeskBook.tsx:467–482`).
- **Unmounted chrome.** `SettingsModal`, `SettingsPanel`, `ComputerPanel`, `PluginsPanel` exist with focus traps and Escape handling but are never rendered from `App.tsx`; `ChatView` still toggles their store flags. Dead paths confuse future work (`docs/NEXT-WAVE.md` says do not purge now — leave, but do not extend).

### Confusing states

- Recheck runs when `hermes.ready` is false (it should — a miss is an honest fact) but the miss did not say "attach a model". Now it does.
- Sidebar "Recheck" (WorkdayPulse) and the header "Recheck" do the same thing under two guides; the pulse's label is `guide.actionLabel`, so after a miss it reads "Recheck" next to "Continue with the sample", which suggests it will replay the sample. Both hit `/api/desk/check`.
- Ask with the worker not ready said: chip "Workroom ready" (hold), banner "Bud needs a private readiness check…", composer "Bud is not ready yet…", empty state "Finish Bud on You". Consolidated to one composer strip + the empty-state heading.

### Accessibility findings

- Visible focus: **pass.** Programmatic `focus({focusVisible:true})` over every focusable control on Desk (19) and You (41 reachable) showed a 2 px agency outline on all of them; the only misses were controls inside a closed `<details>`, which are not focusable.
- Escape: closes the Desk queue/evidence drawers, CSV and add-property dialogs, bubble editor, `@` picker. **Pass.**
- Reduced motion: `view-in` animation resolves to `none`; mascot motion is disabled; spinners keep turning (now at 2.4 s so "working" stays visible without a fast spin). **Pass.**
- Icon-only controls: `OptionCard` dismiss had no name; `UpdateBanner` dismiss had `title` only. **Fixed** (`aria-label`, `aria-hidden` on the glyph).
- Live regions: Desk announces decisions through `aria-live="polite"` (`DeskPage.tsx:335–344`); chat log is `role="log"`. **Pass.**
- Gaps: no skip-to-content link; `<h1>` per page but no app-level `banner` landmark; CSV dialog lacks a Tab trap; queue `listbox` options are buttons (works, but arrow keys are handled at `window` level, not on the listbox — screen readers will not announce a roving selection).

---

## 2. Proposed end-to-end journey: one PM weekday

Grounded in `docs/PM-DAY.md`. Times are the office's (agency timezone from the book).

| Time | What happens | Where the PM looks | What Bud does | Human boundary |
|---|---|---|---|---|
| 7:25 | App opens on Desk. Morning loop already ran at 7:30 yesterday; today's is due. Sidebar pulse: "Morning money check at 7:30". | Desk header counts: `0 need you · 4 next`. | Nothing yet. | — |
| 7:30 | Clock presses Recheck. Header shows "Checking… 12 s". If the PM is elsewhere, the Desk badge and an OS notification carry "2 need you". | Desk (or notification → Desk). | Fetches ledger JSON through the pinned profile; misses hold facts. | Bud never drafts a notice; licensee cases land as "For licensee". |
| 7:35 | Queue (Now) lists 12 Oak, 4/22 Harbour, 91 King (licensee first). Case canvas shows facts in one row, safeguards one line, the proposed wording, then **Allow wording / Edit / Deny / Copy**. | Desk case. | Wording waits. | **Allow** records a decision; **Copy** puts wording on the clipboard; the PM pastes into the PMS. Nothing is sent. |
| 7:40 | 91 King: "For the licensee — RealBud will not draft a notice". PM reads facts and moves on. | Desk case (no decision bar). | — | Licensee decision stays outside RealBud. |
| 9:40 | Between inspections, a phone tap allows courtesy wording on Harbour (paired channel). Desk case footer shows "Allowed via Telegram · 9:41 am". | Phone, then Desk later. | — | Same route, same revision check as Desk. |
| 11:00 | Tenant calls about a leak. PM opens Ask: "Log a leak at 8 Pine, urgent, tenant says under sink". Bud puts a maintenance card on Desk (Now → "Allow" adds it to the book). | Ask → Desk. | Reads the book, proposes a card, asks per-turn if it needs a tool. | Dispatching a tradie stays in the PMS. |
| 13:00 | Recheck misses (provider credit ran out). Banner: "Missed — facts held. The worker could not answer — Billing or credits exhausted at the model provider. Facts stay held." Chip stays Held; old cards keep their last-observed stamp. | Desk header. | — | PM tops up on You → Bud → Model connection, presses Recheck. |
| 16:00 Fri | Friday owner letter runs; Schedule shows "Finished · 6 on Desk". Desk Waiting lists owner drafts; each is Allow/Copy. | Schedule → Desk. | Drafts factual catch-ups from book + notes. | Copy only. |
| 17:30 | Window closes. Tomorrow: same Desk, same counts, no re-onboarding. Anything undecided is still in Now. | — | — | — |

Design consequence: **the Desk case is the unit of work**; every other surface exists to get the PM to the right case or to explain why Bud could not produce one.

---

## 3. Information architecture and navigation model

Keep the four doors. Change what each door owns so nothing is owned twice.

```
Desk      queue → case → evidence → decision → copy         (work)
Ask       case-scoped conversation → proposed Desk work      (help)
Schedule  named loops, their runs, and what each produced    (time)
You       this office · Bud · phone · profile · Advanced     (setup & recovery)
```

Ownership rules (each fact has exactly one home; other places link to it):

| Concern | Owner | Other places show |
|---|---|---|
| Recheck (live) | Desk header | Sidebar pulse **links** to Desk and presses the same button; Ask chip and Schedule "Recheck" call the same route. Remove the Recheck from the Desk empty state (the header is 60 px above it). |
| Go-live progress | You → Go live | Desk shows a **one-line chip** ("Go live · 3 left") that jumps to You. No agency-name input on Desk. |
| Agency name | You → This office | GoLiveCard reads it; it does not edit it. |
| Bud setup / model | You → Bud | Ask shows one strip at the composer with the specific reason and one button. |
| Morning brief | Desk header (collapsible) | You and Ask show the **headline only** ("6 checked · 2 need you") with an "Open Desk" link, not the address chips. |
| Runs / receipts | Schedule → Runs | Desk "Activity" is the same feed filtered to today. |
| Phone pairing | You → Phone | Desk chip reads "Phone · Telegram" only when paired; hidden when nothing is paired (today's "Phone off" is noise). |

Navigation additions (chrome only, no new place): `Cmd/Ctrl+1–4` for the four doors, `[`/`]` already toggle queue/evidence. Keep `↑/↓` on the queue. Do not add Cmd+K (`docs/NEXT-WAVE.md`).

Compact rule: below 1280 px width the queue and evidence are drawers (already); below **760 px height** the header folds (shipped). Both are pure presentation.

---

## 4. Screen-by-screen recommendations

### First launch, onboarding, recovery (`Onboarding.tsx`)

- Keep both steps. Reduce `md:min-h-[510px]` so the card fits 600 px without a scrollbar (today the card is 560 px plus padding).
- On "Open the sample desk", land on Desk with the queue **closed** and the morning empty state showing one Recheck — the first thing the PM should do. (Today three Recheck buttons are visible.)
- Recovery path ("A protected book is already on this Mac") should open You **scrolled to Recovery** with the Advanced disclosure open; today it lands at the top of You.

### Desk (`DeskPage.tsx`, `desk/*`)

Shipped: compact header (one-line brief, hidden subtitle/keys hint, go-live hidden while a case is open in short windows), single-row facts, folded safeguards, two-line queue rows, single-row queue filters, Recheck no-op while running.

Next:
- **Header toolbar → one row.** Title left; `Recheck` primary right; `Properties`, `Activity` as secondary; `Open Queue`/`Evidence` only appear as drawer toggles. Move the count chips into the queue header (they are the queue's filters) and keep two informational pills in the header: hands (`Bud live` / `Held` / `Demo`) and phone (only when paired).
- **Case canvas order:** header (address · tenant · rent · kind pill) → "Why it is here" one sentence → **Proposed wording** → Facts row → Safeguards (folded when none) → Tenancies / People / Decisions as `<details>`. Evidence-first is preserved by the header sentence and the facts row; the object of the decision is above the fold at 600 px.
- **Deny with a reason.** `Deny` should open a one-line optional reason (same textarea pattern as Edit) so the decision log carries it; phone deny already supports "no — too soon".
- **Recheck progress** stays in the header (`recheckProgress`) — add an inline "Stop" that calls the existing interrupt path only if the server exposes one for desk checks; otherwise keep it uncancelable and say so ("Recheck is asking Bud · usually under a minute").
- Miss banner: keep the plain sentence (shipped) and add the one action it implies: **"Open model connection"** when the reason mentions the key or billing, **"Install Bud"** when the CLI is missing.
- Queue: make the `listbox` own the arrow keys (`onKeyDown` on the list, `tabIndex=0`, `aria-activedescendant`) so screen readers announce selection; the window-level handler can stay as a fallback.

### Ask (`ChatView.tsx`, `Composer.tsx`, `PendingApproval.tsx`)

Shipped: one blocked-state message at the composer carrying the specific reason (offline / install / workroom / readiness), the top banner removed, the composer disabled while the local service is offline.

Next:
- Drop the fixed greeting bubble when the thread is empty; the empty state already introduces Bud. One empty state, not two.
- The per-turn approval takeover is good; label the choice by consequence: "Allow once" / "Allow for this task" / "Deny" / "Stop this turn". Show **what Bud is about to do and which case it is for** as the first line of the card.
- Streaming: keep "Working for Ns" and the Stop square. Add the tool name in plain words ("reading the book", "checking a source") rather than the raw tool id shown in `ToolRow`.
- Error row: "Retry" re-sends the last message (`canRetryLast`). Keep, and disable while the retry is in flight so a double-click does not queue two turns.

### Schedule (`RoutinesPage.tsx`, `schedule/WeekCalendar.tsx`)

- Loop cards: collapse the retune form behind "Change time" (disclosure). Card face = name · next run · last result chip · `Run now` / `Pause`.
- Week grid: show only days with something scheduled *and* the chip once per loop; "Planned" loops (inbound triage) should be a single footnote row, not seven repeated grey chips.
- Merge "Work on the clock" and "Runs" explanations into one sentence under the title. The receipts list stays.
- A running loop shows the same progress line as Desk Recheck; `partial` stays a distinct chip (already).

### You (`YouPage.tsx`, `BudSetupCard.tsx`, `you/*`)

- Order: **Bud** first when not ready (it is the blocker for Ask and live Recheck), then This office, Go live, Phone, Profile, Advanced. When Bud is ready, This office first.
- Replace "Checking Bud … Check again if this does not settle" with a skeleton for the first 3 s; show the "Check again" affordance only after 8 s.
- Bud card: move the Make / Research / Act trio under the journey or into the ready state; while setting up, the journey is the content.
- Model sheet: provider → model → key is right; add a masked "key present · ends …ab12" line and a "Test connection" that is the same hands ping, so "Verify" and "Test" are one thing.
- Advanced: keep the `<details>`; add the worker version, pin and pack facts there (already) plus "Copy diagnostics" for tickets (`docs/QA-LIVE-DEBUG.md` asks for exactly these fields).

### Evidence, approvals, cancellation

- Evidence rail: keep `SourceStamp` with observed time; show "stale (>12 h)" as a hold chip **on the case header too**, since the rail is a drawer below 960 px.
- Allow/Deny/Edit already require a click on a 44 px control with the wording visible (after the compact fix). Never auto-focus Allow.
- Cancellation: Edit → Cancel restores the original body (exists). Add "Undo" (5 s) after Deny — the server already records decisions by revision, so undo is a new decision, not a rewrite.

---

## 5. Component and token strategy

Build on `styles.css` `@theme`; do not add a second design system.

**Colour.** Keep the eleven DESIGN tokens as the only names in new code (`paper, sheet, ink, ink-muted, line, agency, agency-hover, selected, hold, danger, portal`). Treat `accent/panel/hairline/ink-secondary/card/inset/raised` as legacy aliases: no new usages; migrate file-by-file when touched. Status colour is always paired with a word (`StatusLabel` does this).

**Typography.** Screen title 27/600, case title 23/600, body 14–15, label 12/500 (`.pm-screen-title`, `.pm-case-title`, `.pm-label`). Tabular numerals on rent, days, times (`tabular-nums` — already used in `FactSummary`). Nothing operational under 12 px; the 10.5 px chips on Schedule move to `StatusLabel` (11 px).

**Spacing and density.** Scale 4/8/12/16/24/32. Two densities: *comfortable* (≥760 px tall) and *compact* (`COMPACT_WINDOW_QUERY`, `src/lib/use-media-query.ts`). Compact removes explanatory lines and folds secondary panels; it never shrinks controls below 40 px (44 px for decisions).

**Elevation.** Flat panes with `border-line` dividers. Shadow only on drawers (`.pm-split-queue` overlay), modals, and the desktop notification toast. No nested card grids as layout (Schedule's stacked cards are the exception to fix).

**Radius.** 4 px controls, 8 px panels, pills only for binary status (`StatusLabel`).

**Primitives to add (small, in `pm/primitives.tsx`):**

| Primitive | Replaces | Notes |
|---|---|---|
| `Button` (`primary | secondary | quiet`, `busy`, `size`) | ~30 inline class strings | `busy` renders the spinner and sets `aria-busy`; clicks are ignored while busy (no `disabled`, so focus is not lost). |
| `Disclosure` (`summary`, `open`, `onToggle`) | ad-hoc `<details>` and toggles | Used by Safeguards, Schedule retune, Advanced, morning brief. |
| `InlineNotice` (`tone: hold | danger | agency`, `action?`) | miss banner, recovery notice, Ask blocked strip, Desk error | One place for icon + sentence + one action. |
| `Skeleton` | text placeholders during first load | Respects reduced motion (static block). |

**Focus.** Keep the global `:focus-visible` outline (2 px agency, 2 px offset). Remove `focus:outline-none` from inputs that only change border colour (`SettingsModal.tsx:71`, `OptionCard`) so keyboard focus is never border-only.

**Responsive.** `≥1280`: queue + case + rail. `960–1279`: queue drawer + case + rail. `<960`: case primary, both drawers (already in `styles.css:156–226`). Add the height axis: `<760` compact header (shipped). Container queries (`@container` on the case body, shipped) handle the canvas width independently of the window.

---

## 6. Motion system

Principle from `DESIGN.md`: motion explains state; transform and opacity only; a static reduced-motion equivalent; never delays a decision.

| Moment | Trigger | Purpose | Motion | Duration / easing | Interruptible | Reduced motion |
|---|---|---|---|---|---|---|
| Change door | nav click / Cmd+n | orientation | `view-in` rise 7 px + fade | 220 ms, `cubic-bezier(.22,1,.36,1)` | new click restarts (keyed remount) | none (instant) |
| Drawer open/close | Open Queue / `[` / Escape | hierarchy | translateX 28 px + fade, backdrop fade | 240 ms | yes | instant, backdrop still shown |
| Case change | queue select / ↑↓ | continuity | header text swaps instantly; body fades 120 ms | 120 ms | yes | none |
| Recheck running | header Recheck | progress | spinner + elapsed seconds + phase label (`recheckProgress`) | continuous | n/a (state) | spinner at 2.4 s; label unchanged |
| Cards landed | snapshot revision change adds Now rows | attention | new queue rows `msg-in` 4 px settle; Desk badge count updates with no animation | 180 ms | yes | none |
| Decision recorded | Allow / Deny 200 | completion | button label → "Saving…" → bar swaps to post-allow row; toast "Wording allowed" 2.4 s | 0 / 180 ms | n/a | same, no fade |
| Hold / miss | check returns miss | required attention | banner `panel-in`; hands chip colour + word change | 240 ms | yes | instant |
| Approval needed (Ask) | worker requests tool | handoff to human | composer takeover `pop-in`; card in transcript | 200 ms | yes | instant |
| Streaming text | tokens | activity | caret blink (step) | 1 s step | n/a | caret static |
| Offline | SSE error | state change | sidebar dot colour + "Reconnecting"; pulse card retitles | pulse 1.5 s on the dot | n/a | dot static (`motion-reduce:animate-none`, exists) |
| Setup step advances | server proves a fact | progress | `bud-step-in` 4 px settle on the new current step | 280 ms | yes | none (already gated) |

Rules: nothing loops except the spinner and the offline dot; no motion longer than 300 ms outside the mascot (mascot stays off the case canvas); no layout shift — header folds change on media query, not on interaction; all animations are CSS so they are interruptible by state change.

---

## 7. State matrix

Legend: **Copy** is user-facing wording; **Action** is the one control shown.

| State | Desk | Ask | Schedule | You / Bud |
|---|---|---|---|---|
| Loading (first paint) | "Loading desk…" spinner, or SSE snapshot painted instantly (`DeskPage.tsx:38–41`) | Thread from cache; chip "Checking Bud" | Loops list skeleton | Skeleton for Bud card (proposed; today "Checking Bud" text) |
| Empty | Morning empty: headline + one Recheck (only when never run) | "Tell Bud the outcome" + chips | "No runs yet" | Journey step 1 current |
| Active / working | Header progress line "Checking… Ns"; Recheck ignores second press; sidebar pulse "Checking" | Stream tail "Working for Ns" + Stop | Run chip "Running"; Run now disabled | Install job lines streamed; "Installing…" |
| Waiting for human | Queue Now rows; case DecisionBar 44 px | Composer takeover: what Bud wants, Allow once / for this task / Deny / Stop | "Plan needs approval" chip → You → Bud's jobs | Journey "Next" step with one button |
| Approval required (licensee) | Case says "For the licensee"; no bar; danger pill | Bud refuses statutory drafting by prompt | — | — |
| Partial | Hands chip **Held**; uncovered properties hold; brief "N checked · M held" | — | Run chip **Partly done** (`partial`) | Sources list shows per-source last-checked |
| Success | Toast "Wording allowed" + post-allow row "Copy, then send from the PMS" | Assistant message + proposed Desk card | "Finished · N on Desk" | "Ready" pills; hands ping time |
| Failure | Miss banner (plain reason, shipped) + hands Held; case facts keep last observed stamp | ErrorRow + Retry | Run chip Failed / Missed with receipt | Step "Needs attention" + repair action |
| Offline (local service) | Header guide "New checks and saves are paused. Your existing book stays on this Mac."; buttons disabled by `connected` | Composer strip "RealBud's local service is reconnecting…", no setup button (shipped) | Read-only | Read-only; sidebar "Reconnecting" |
| Retry | Try again on load error; Recheck again after miss | Retry on last message | Run now again | Check again / Repair |
| Cancellation | Edit → Cancel restores body; no case cancel (by design) | Stop turn (header + composer) | Pause loop (never mid-run stop) | Cancel install (proposed; today the job runs to its 10 min kill) |
| Recovery | `RecoveryNotice`: writes paused, "Open You to unlock" | — | Clock paused with the book | Recovery key → Unlock / Start again (typed confirm) |
| Stale | Evidence rail "stale" >12 h (`DeskEvidence.tsx:26–31`); proposed: chip on case header too | Brief headline shows last check time | Next-run line | Sources last-checked in agency timezone |
| Revision conflict | "This card changed — open it again" (409) | — | — | — |
| Low storage | 507 `storage-full`: "This Mac is out of space. Nothing was lost; the last good book is kept. Free space and try again." shown in the Desk error banner (hold tone); no quarantine; revision rolled back. The decision stays in memory and lands on the next successful write, so an immediate manual retry of the same Deny can answer "already decided" — honest, not lost. | Send fails with the same sentence | Clock writes fail the same way | Advanced: Copy diagnostics includes the data dir |

---

## 8. RealBud ↔ Hermes boundary

What exists (facts): pin `server/hermes-pin.ts` (v0.20.3 / v2026.8.16.2, profile `property`); pack `server/hermes-pack.ts`; status ladder `server/hermes-status.ts`; install/repair/uninstall jobs `server/hermes-bridge.ts` + `server/hermes-lifecycle.ts`; hands ping/ledger `server/hermes-hands.ts`; turns via ACP `server/drivers/acp/hermes.ts` (`hermes -p property acp`, hardened env, RealBud vault as workspace). HTTP: `GET/POST /api/hermes*` (`server/index.ts:2148–2285`). GUI consumes `HermesStatus` on demand and on window focus (`store.tsx:1399–1422`), install status by polling.

The boundary to keep:

| Concern | Rule | Where it lives |
|---|---|---|
| Installation | RealBud runs the pinned installer in-app with streamed lines; verifies `--version` against the pin before "done". Terminal never opens. | `hermes-bridge.ts` InstallJob; `BudSetupCard` poll |
| Configuration | RealBud writes only the `property` profile (pack files, `config.yaml` model block, `.env` key). It never edits Hermes source or the default profile. | `hermes-pack.ts`, `attachModel` |
| Version compatibility | One supported build (the pin). `matchesPin` false → "installed X, supported build is Y" + **Update Bud** (repair). A newer upstream is a canary in a separate home (`docs/NEXT-WAVE.md`), never an in-place update of the working profile. | `hermes-pin.ts`, `hermes-status.ts:87–107` |
| Health | Four proved facts, in order: CLI installed+pinned → pack manual approvals + workroom → model attached → hands ping OK. `ready` is the last one and is a persisted receipt (`hands-ping.json`). Reload never upgrades readiness. | `hermes-status.ts:26–47`, `hands-last.ts` |
| Reconnection | There is no long-lived Hermes connection to reconnect; each turn/ping spawns the CLI. "Reconnecting" in the GUI refers to RealBud's own local service (SSE). Keep these two words distinct in copy: *reconnecting* = local service; *not answering* = worker. | `store.tsx` SSE; `hermes-hands.ts` |
| Errors | Worker stdout/stderr never reaches user chrome raw. `workerMissReason()` maps provider failures to one plain line (key refused, billing, rate limit, no model, unreachable) and bounds unknown lines to 120 chars (shipped). The GUI additionally scrubs vocabulary with `budFacingCopy`. | `hermes-hands.ts`, `src/lib/bud-setup.ts:28–40` |
| Authoritative completion | A Desk decision is "done" only after the server responds 200 with the new snapshot; Recheck is "checked" only when rows parse; a loop is "completed" only from `loop.run` frames. The GUI never optimistically flips a card. | `DeskPage.run`, `routines.ts` |
| Preserve auth during GUI updates | Model keys live in the Hermes profile `.env`, not in RealBud's config; GUI updates and `desk.json` recovery do not touch them. `Remove Bud` is the only path that deletes them and it is a two-click confirm. | `hermes-bridge.ts:376–416`, `hermes-lifecycle.ts:36–53` |
| Unavailable / partially configured | Every status shape is renderable: not installed → Install; mismatch → Update; pack missing → Apply safeguards; no model → Connect a model; not verified → Run readiness check. Ask and live Recheck are blocked with that same one line. | `bud-setup.ts`, Ask composer strip |
| Safe recovery | Uninstall clears the ping receipts so `ready` cannot linger; Repair re-applies the pack; a miss during a loop writes `hands-last.json` and the loop settles `missed`, never `completed`. | `hermes-lifecycle.ts`, `routines.ts` |
| Portal work — fence | RealBud denies off-origin, password/OTP/MFA, Pay/Send/sign/statutory, fill without prefill, and ad-hoc browsing **before** any Allow card. Hermes source is untouched. The fence is RealBud's. | `server/portal-fence.ts`, `server/index.ts` `request.opened` |
| Portal work — Attach | Per-job acknowledgement `human-login-and-submit`. Editing origins clears it. Not a visit / `readyForLivePortal` gate. | `PATCH /api/recipes/:id { attach }`, `recipes.ts` |
| Portal work — Run beside me | Same ACP turn Ask uses, `computer: true`, attended prompt. Clock never launches a browser. Human signs in; Submit is opt-in (below). | `POST /api/recipes/:id/attend`, `attended-run.ts`, `PortalJobActions.tsx` |
| Portal work — site rules | Allow card third choice writes `portal:read:{origin}` / `portal:prefill:{origin}` (“Reading on {origin}” / “Prefill on {origin}”). You → Bud's rules shows a **Site rule** pill and Revoke. A rule never covers submit, pay, password, or another origin; a prefill rule cannot widen a read-only job. | `rules.ts`, `PendingApproval.tsx`, `YouPage.tsx` |
| Portal work — Submit asks | Opt-in per job: capability `portal-submit` + “Bud may press Submit” (`submitAcknowledgedAt`). Each press asks with “Bud wants to press '{label}' on {origin}. Check the form in the browser first.” Allow this Submit / Deny / Stop this turn — never session-scoped, never a rule. Money/statutory still denied. | `portal-fence.ts`, `PortalJobActions.tsx`, `PATCH /api/recipes/:id { submitAcknowledged }` |
| Portal work — Ready beside you | Clock enqueues attended `JobRun` `queued` (“Ready to run beside you — press Start when you are at the screen.”). Card/Desk Activity: **Ready beside you** + **Start beside me**. Survives restart; `missed` after 24 h (“Not started — waited a day”). | `job-runs.ts`, `index.ts` loop execute, `JobRunFeed.tsx` |
| Portal work — settle | `completed` only with a read-back that names an allowed origin; else `partial` (unknown). GUI never flips Done from a spinner. | `attendedSettleStatus`, `attendedRunLabel` |

Proposed adapter tidy-up (no behaviour change): move `hermesStatus`, `applyHandsReadiness`, install/repair/uninstall, `attachModel`, `tryHermesPing`, `tryHermesLedger` behind one `server/worker/` module with a versioned `WorkerStatus` type in `shared/contracts.ts`, so a future engine swap or v0.21 canary touches one folder. The HTTP paths stay.

---

## 9. Prioritised recommendations

### Shipped on this branch (quick wins, verified at 900×600)

1. **Compact Desk header** — `useMediaQuery` + `COMPACT_WINDOW_QUERY` (`src/lib/use-media-query.ts`); `MorningBrief` `collapsed`/`onToggle`; subtitle and keys hint hidden under 760 px; go-live strip hidden while a case is open in a short window. Header 420 → 190 px; wording visible above the decision bar.
2. **Case body density** — facts as one row via `@container` / `@md:grid-cols-4`; safeguards fold to "None in force" with a disclosure when nothing is in force; `revision …` moved to a `title`.
3. **Queue** — two-line clamp on row meta (full text on hover); filters fit one row in the 300 px drawer.
4. **Worker miss in plain language** — `workerMissReason()` in `server/hermes-hands.ts` with tests; scanner noise dropped; provider errors mapped; unknown lines bounded.
5. **Vocabulary** — "Hermes" removed from Schedule copy and the model sheet (Bud's login / Bud's catalogue).
6. **Ask blocked state** — one strip at the composer with the specific reason; top banner removed; composer blocked while the local service is offline; setup button hidden offline.
7. **Repeated clicks** — header Recheck is a no-op while a check is in flight (server already single-flights).
8. **Hung request** — `api()` accepts a `timeoutMs`; profile save uses 15 s so "Saving…" becomes a retryable error.
9. **A11y** — named dismiss buttons on `OptionCard` and `UpdateBanner`; reduced-motion spinner slowdown.

### Shipped in the second wave (same day; six parallel agents, integrated and re-verified at 900×600)

**Server (boundary and honesty)**
- `GET /api/hermes` carries `model: { attached, provider, model }` (never `keyHint`), so the GUI can tell "no model" from "readiness check not run".
- `POST /api/desk/drafts/:id/deny` accepts an optional `reason` (trimmed, ≤ 280); it lands on the property notes exactly like a phone deny ("no — too soon"), through one `denyDraft` path.
- Full disk (`ENOSPC`/`EDQUOT`) is a 507 `storage-full` with the sentence "This Mac is out of space. Nothing was lost; the last good book is kept. Free space and try again." The revision and in-memory book roll back; nothing is quarantined. The route catch now forwards `{ error, code }`.
- Restart bug fixed: licensee escalations lost their explanation on reload (V3 kept only the code, so the queue and case showed `statutory-clock`). `Case.detail` now round-trips; books written before it get a plain fallback sentence.

**Desk**
- One-row toolbar (Properties · Activity · Evidence · `Queue · N` · Recheck); count chips live in the queue header and still filter. Header ≈ 205 px with the miss banner, ≈ 190 px without.
- Case order: address → tenant line → why it is here → **Proposed wording** → facts row → Safeguards (folded when none) → Tenancies / People / Decisions as disclosures with counts. At 900×600 the wording is fully visible above the decision bar.
- Deny opens an inline reason strip ("Reason (optional)" · **Deny wording** · Cancel, Escape cancels, focus returns to Deny). Verified end-to-end: reason recorded in the property notes.
- Miss banner gets one derived action (`missAction`): Open model connection / Install Bud / Open Bud setup → You with the right hash.
- Stale chip on the case header (> 12 h) because the evidence rail is a drawer under 960 px.
- Queue listbox owns keyboard selection (`tabIndex=0`, `aria-activedescendant`, ↑↓ Home End Enter); window handler defers to it.
- Recheck removed from the empty state; agency name off Desk ("Name it on You"); phone chip only when paired; two-line row clamp; storage-full banner in hold tone.

**Ask**
- Blocked reason is precise: "Bud needs a model connection before Ask can run tool work." with **Connect a model** (opens `#attach-model`) in both the empty state and the composer strip; other blockers keep "Set up Bud".
- Retry is a no-op while a turn is in flight ("Retrying…"). Tool chips read as plain phrases (`toolLabel`), raw id in `title` only.
- Approvals lead with consequence and case ("For 12 Oak St · reading a file"); buttons: Allow once · Allow for this task · Deny · **Stop this turn**. Header chip reads "Waiting for you"; placeholder "Answer the request above to continue".
- The seeded greeting no longer doubles the empty state (client-side only; data untouched).

**You**
- Skeleton for the first 3 s of a status load; "Check again" only after 8 s. Bud section leads while not ready; Make/Research/Act folds under "What Bud can do" until ready.
- Visible focus restored on every input (no `focus:outline-none`). 15 s budgets on profile, office, agency, connected-apps, channel and law-watch saves; none on worker calls.
- **Copy diagnostics** in Advanced (no key material) with a polite live-region confirmation. `#you-recovery` opens Advanced and scrolls to the Recovery key card. Model sheet shows "Key saved · ends …" and the verify step is "Run readiness check".

**Schedule**
- Retune behind "Change time · Weekdays 7:30 am" (closed by default, stays open after Save). Planned loops render once as a footnote, not seven chips. One explanatory sentence under the title. `StatusLabel` replaces ad-hoc pills. Running loops show the Desk progress line.

**Shell**
- Onboarding fits 600 px (480 / 529 px cards, no scrollbar). Recovery escape sets `#you-recovery`. ⌘/Ctrl+1–4 switch doors, hinted in nav `title`s. Sidebar connection line is a polite live region. Update banner has text + icon per state. Pulse copy after a demo miss is honest: "Facts stay held" with **Run the sample morning** (what the button does) and the model fix named.

### Portal wave (2026-09-02)

- Ask no longer refuses "log in to … and complete the routine": shadow job + plan + "Run beside me" (`server/portal-job-intent.ts`). Weak targets ignored unless a login verb is present. Model down → honest fallback.
- Attach this site acknowledgement + Detach on Schedule recipe loops and You → Bud's jobs (`PortalJobActions.tsx`).
- Run beside me starts an attended ACP turn; Ask chips Open the job / Approve the plan / Stop.
- Fence in RealBud (`server/portal-fence.ts`): off-origin, password, Submit/Pay/Send, ad-hoc browse. Receipts "What Bud did · N actions" with denials. Done only with read-back.
- Hermes source untouched.

### Portal wave 2 (2026-09-02)

- Standing site rules for read/prefill (`portal:read:{origin}` / `portal:prefill:{origin}`); Allow card “Always allow reading on {origin}”; You → Bud's rules **Site rule** pill.
- Submit is a per-instance ask on jobs with **Bud may press Submit** (`portal-submit` + `submitAcknowledgedAt`). Summary: “Bud wants to press '{label}' on {origin}. Check the form in the browser first.” Pay/sign/notice/send stay denied.
- One-step **Approve and attach**; Ask chip **Run beside me now** when an approved+attached job matches “is already a saved job”.
- Clock never launches a browser: approved+attached portal jobs enqueue **Ready beside you** + **Start beside me**. Queued runs survive restart; `missed` after 24 h.
- Receipts tag **allowed by rule** and **Submit pressed with your approval**.
- Owner boundary: Submit is the one relaxation of the former hard line — opt-in per job, per instance, non-money only. Bank sites: read and export only.
- Gates: `pnpm typecheck` clean; `pnpm test` 123 files / 923 tests; `pnpm qa:e2e:quick` green.

### Remaining quick wins (each ≤ 1 file)

- Ask header chip should read "Model needed" (hold) rather than "Workroom ready" while `model.attached` is false.
- Case "why it is here" line repeats the tenant phone already in the header; drop the duplicate segment.
- Queue header wraps to two lines in the 300 px drawer when four count chips are present; drop "0 waiting"-style zero chips.
- `#attach-model` should scroll the sheet itself into view, not only the Bud card.
- App version in Copy diagnostics once `ConfigStatus` carries one; 15 s budget on law-watch schedule.

### Structural (one PR each)

- `Button`, `Disclosure`, `InlineNotice`, `Skeleton` primitives; migrate the ad-hoc buttons in DeskPage, YouPage, RoutinesPage, MorningBrief, OfficeCard, BudSetupCard, ChatView; swap the native `<details>` in Schedule and DeskCase for `Disclosure`.
- 5 s Undo after Deny (a new decision, never a rewrite) — needs a server route that reopens a denied draft under revision control.
- CSV review dialog Tab trap; skip-to-content link; `banner` landmark.

### Later refinements

- `server/worker/` adapter folder with versioned `WorkerStatus`; canary home for v0.21.
- Cancel for an in-flight install job.
- Token alias retirement (`accent`, `panel`, `hairline`, `ink-secondary`).
- Dark mode (only after aliases are retired).

---

## 10. Acceptance criteria (testable)

**Compact layout (900×600, Electron floor)**
- With ≥1 Now card selected, the proposed wording's first line and the DecisionBar are both within the viewport without scrolling the case body. (Verified: `desk-900x600-after.png`.)
- Desk header height ≤ 200 px when a case is open; ≤ 260 px on the empty state.
- Queue drawer shows ≥ 2 rows above the fold with filters on one line.
- Onboarding fits without a vertical scrollbar.

**Keyboard and focus**
- Every interactive control shows a ≥ 2 px outline under `:focus-visible` (automated check: focus each focusable element with `{focusVisible:true}`, assert `outline-width > 0` or `box-shadow`). Pass today on Desk and You.
- Escape closes the top-most drawer or dialog only; a second Escape does nothing harmful.
- `↑/↓` change the selected case; the case header updates within one frame; selection is announced (`aria-selected`).
- Tab order inside a dialog is trapped; focus returns to the opener on close (CSV dialog is the outstanding gap).

**Reduced motion**
- With `prefers-reduced-motion: reduce`: `.animate-view-in`, `.animate-panel-in`, `.animate-msg-in`, mascot motion resolve to `animation-name: none`; spinner duration ≥ 2 s; no content is hidden or delayed. (Verified via `Emulation.setEmulatedMedia`.)

**Animation performance**
- All shell animations use only `transform`/`opacity`; none exceeds 300 ms; no animation runs on layout properties; no long task > 50 ms attributable to animation during a door change (Performance panel).

**Interruption and resume**
- Kill the local service mid-session: sidebar shows "Reconnecting" within one SSE error; Ask composer is blocked with the offline reason; Desk buttons that write are disabled. Restart: `connected` flips back, snapshot reloads, no duplicate cards, in-flight profile save either completes or reports an error within its budget (15 s).
- Kill the app during Recheck: on relaunch, hands chip reflects `hands-last.json` (Missed or last observed), never "checked" without rows.
- Reload during onboarding step 2 resumes at step 2 with the typed name intact.

**Repeated actions**
- Double-press Recheck: exactly one `/api/desk/check` in flight (server single-flight; header button no-op while busy). One progress line.
- Double-press Allow: second request returns 409 "already decided"; UI shows the post-allow row once and no error toast (the 409 maps to "This card changed — open it again" only if the revision moved).
- Double-press Run now on a loop: one run record, one receipt.

**Failure recovery**
- Recheck with no model attached: banner reads a plain sentence naming the provider failure and the fix; contains no `Exception`, `Traceback`, `errno`, or scanner text; facts stay held; existing cards keep their stamps. (Verified: "The worker could not answer — the model provider refused Bud's key; check the model connection on You. Facts stay held.")
- Worker not installed: You → Bud shows "Bud on this Mac · Next" with a single Install button; Ask composer strip says Bud needs to be installed. (Verified with Hermes off PATH.)
- Version mismatch: You shows "Update Bud"; no other step is offered until the pin matches.
- Corrupt `desk.json`: recovery notice on Desk and You; writes refused; unlock restores the last good book; the training book is never substituted.
- Low storage: commit failure produces a recovery notice naming the cause; no quarantine; retry after freeing space succeeds without data loss (to implement).

**Usability**
- A new PM (sample book) completes: open app → Recheck → Allow one courtesy → Copy, in ≤ 5 clicks from launch with no scrolling at 900×600.
- Every screen has exactly one primary (agency-coloured) action visible at a time in the header region.
- No screen outside Advanced diagnostics contains "Hermes", "pin", "pack", "headless", "recipe", "revision", "ACP", "profile" (grep of rendered text in the e2e battery).

**Portal fence (2026-09-02)**
- Off-origin navigate/fill/click is denied with exactly `That site is not on this job.` No Allow card.
- Password / OTP / MFA fill is denied with exactly `You sign in yourself — Bud never types a password.`
- Pay / Send / transfer / sign / delete / statutory click is denied with exactly `Submit, Pay and Send stay with you.` (Wave 1 also denied every Submit/lodge click this way; wave 2 splits Submit — see below.)
- Ad-hoc Ask browsing with no fence context is denied with exactly `Only sites named in a saved job. Ask Bud to set the routine up as a job first.`
- Receipt is Done only when the turn is ok and the last assistant text names an allowed origin and a read-back word; otherwise Unknown — check the site yourself. Never done on a miss.

**Ask portal intake (2026-09-02)**
- "Log in to {named portal} and complete the routine" is not refused. Reply is a plan (or points at the existing job) plus Run beside me; human signs in and presses Submit/Pay.
- Weak targets (account / site / online / the routine) without a login verb do not create a job.

**Portal wave 2 (2026-09-02)**
- A site rule never covers submit, pay, password, or an origin off the job. A prefill rule does not widen a read-only job.
- Submit asks only when the job has `portal-submit` and “Bud may press Submit”. The card is never session-scoped and never offers a standing rule. Summary is exactly `Bud wants to press '{label}' on {origin}. Check the form in the browser first.`
- No fenced browser allow is ever session-scoped: a `scope: "session"` answer on a fenced request reaches the worker as `allow_once` (test: `attended-run.test.ts` "never lets a fenced browser allow become a session grant"), and the card hides "Allow for this task" when a fence is present. Allowed submits leave the evidence line "Submit pressed with your approval on {origin}."
- Without that opt-in, Submit is denied with exactly `This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.`
- The clock never launches a browser. An approved+attached portal job becomes **Ready beside you** + **Start beside me**.
- A queued attended run older than 24 h settles `missed` (“Not started — the run waited a day for someone at the screen.”; GUI “Not started — waited a day”).

---

## Verification log for this session

Second wave (after the six-agent integration):
- `pnpm typecheck` clean; `pnpm test` 120 files / 862 tests pass; `pnpm qa:e2e:quick` ALL GREEN.
- Live at 900×600: Desk header 205 px with the miss banner and the case wording fully visible; Deny with reason → property notes; ⌘1 switches doors; onboarding 480/529 px with no scrollbar; Ask empty state + composer both say "Connect a model" and land on `#attach-model`; You leads with Bud while not ready; Schedule shows the Planned footnote and retune disclosures; 28/28 focusable Desk controls show a ring; the queue listbox is focusable with `aria-activedescendant`; no door's visible text contains Hermes/headless/recipe/revision/ACP/cron; no horizontal overflow on any door.
- Found and fixed during the walk: licensee escalation detail lost on restart (raw `statutory-clock` shown); pulse button labelled "Recheck" while running the sample replay.

First wave:
- `pnpm typecheck` clean; `pnpm test` 118 files / 839 tests pass; `pnpm qa:e2e:quick` ALL GREEN.
- Live: isolated server on `OMB_PORT=18899`, `REALBUD_DATA_DIR=/tmp/realbud-audit`; Vite 5199; Chromium viewport emulated at 900×600.
- Walked: onboarding (2 steps, resume), Desk empty → Recheck miss → practice cards → keyboard selection → Escape, Ask blocked/offline, Schedule, You (ready and worker-uninstalled), service stop/restart, reduced-motion emulation, focus audit.
- Not reproducible here: `ENOSPC` (no handler exists — see §7), Electron-native SSE drop (the Vite proxy masks upstream loss; the `onerror → connected:false` path was exercised by dispatching `realbud:service-unavailable`).
