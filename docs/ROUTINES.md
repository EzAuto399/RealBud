# Routines — product design (GUI + Ask, Hermes as hands)

Date: 2026-08-21  
Status: **design locked** — implement PR A–D below; do not skip to “create any routine”  
Related: `docs/GOAL-PROMPT.md` §5, `docs/WORKFLOW-PLAN.md`

Four reviews (code, usability, engineering, Hermes capability) agree: **PMs retune named loops. They do not author jobs.** Hermes fetches facts. RealBud is the clock, the cards, and Allow.

---

## Wall line

> Tell Ask to run the morning money check at eight — then Allow. That is enough magic.

---

## Shipped clock and calendar

Schedule can Pause / Resume / Run now on **Morning money** and **Friday owner letter**, and PATCH their time/weekdays/enabled with revision and no backfill. The Monday-first month calendar previews those typed recurring dates; selecting an occurrence focuses the same authoritative editor. Inbound stays Planned and is not promoted onto the calendar. Ask can now prepare a one-run or clock-change card for those same code-owned routines; the clock remains unchanged until Allow, and the pending card is visible in both Ask and Desk.

Every scheduled occurrence is admitted once under a durable key before source work starts. A crash may leave the clock bookmark behind, but startup finds the existing completed/interrupted occurrence and advances without replay. Overlap is recorded as missed rather than silently dropped. New runs persist a bounded PM-language receipt for readiness, source collection, evaluation and Desk staging; running steps become interrupted on restart. Existing v3 files and legacy runs require no migration and never receive invented history.

Morning money uses the latest structured PMS export already admitted to Desk. It does not spend a model call to re-read facts RealBud already holds, search for a newer file or claim it refreshed the PMS. Current `MoneyPosition` projection decides whether those facts are fresh/unique enough; unsafe rows hold. Manual Desk Recheck remains the explicit worker-assisted collection path.

An optional **Desktop reminders** connection in You can alert the PM once when a run fails, is missed/interrupted, or completes with linked held work. The shell owns generic notification copy; no property, person, balance, model text or outbound channel is involved. A durable `notifiedAt` receipt prevents reconnect/relaunch duplicates, and clicking opens Schedule or Desk. This is presentation of RealBud's existing clock state, not another scheduler.

Hermes Bot Mode cron is a competing product (stored prompt + unattended **delivery**). Copying it breaks send-403, the training-provider story, and gives two clocks.

---

## Four perspectives (locked together)

### Usability (graduate / trainer)

- **Schedule = the map.** Browse the clock. Always three cards. Never “create your first automation.”
- **Ask = the mouth.** Speak a change. Never PATCH the clock itself.
- Edit sheet: **four fields** — Kind (read-only), When (time + day chips), Which properties, On. Save / Cancel. Next preview in English.
- Ask clock-talk → **Change waiting** card (before/after of those four fields) → Allow / Deny. Same card on Desk. One Allow.
- Ban on screen: cron, bot, agent, vault, Hermes, YOLO, prompt, loop (say **routine**), `prop-oak`.
- Planned kinds look Planned. Friday must not look runnable then 409.
- Trainer pass line: *“I can see what it will do at 8:00, I allowed the change, and it cannot send.”*

### Capability (Hermes)

| Hermes may | Hermes must not |
|---|---|
| One-shot `hermes -p property chat -Q` for facts (JSON skill) | Own WHEN |
| ACP for Ask while the PM is looking | Store a prompt as a job |
| Pack skills as HOW | Gateway `/cron`, Bot Mode Routines, deliver to WhatsApp |
| Miss → hold | `cronjob` tool from Ask writing `jobs.json` |

Clock stays a code-owned one-shot source/evaluator path. Ask stays ACP. The same private worker may serve an explicitly selected source adapter, but the built structured-export clock does not require a model. `cron_mode: deny` stays. A `jobs.json` under the property home is a **gate failure**.

### Engineering

- Catalog owns: id, name, description, available, evaluator, `mayLaunchCua: false`.
- Persist in `loops.json` v3: enabled, time, weekdays, property scope, revision, proposals, deterministic occurrence key and optional bounded phase receipts.
- **Do not overload `Draft` or money `WorkItem`.** Own `LoopProposal` `{ kind: "schedule-change" }`. Allow on a courtesy must never move the clock.
- GUI PATCH applies immediately (the PM is looking at the form). Ask POST `/propose` does not apply; Allow does.
- Time/scope change: `handledThrough = now-1` so we **do not backfill** a missed old slot. Run now is explicit catch-up. Enable-only toggle keeps today’s 12h catch-up.
- Scope is a **loop** attribute. Desk Recheck stays the whole book.
- Invalid kind / catalog fields / empty weekday list / empty id list → 400. Planned enable/run → 409. Stale revision → 409.

### Product

Kinds are born in **code + skill + catalog**. Users instantiate them. “Add Friday letters at 4” is legal only after that kind is `available`. Until then Ask says Planned. Extra kinds from English are how you get a send routine.

---

## Honour speech without a prompt-runner

| They say | Product does |
|---|---|
| Check rent every morning | That **is** Morning money (already the default). Offer retune if they meant 8:00. |
| Run it at 8 | Change waiting: time 8:00. Allow. |
| Pause Oak | v2: scope book minus Oak. v1: say we can’t yet; don’t invent a second routine. |
| Text them every morning | Refuse send. Offer the money-check (drafts, not SMS). Clock unchanged. |
| Add Friday owner letters | If Planned: not built. If built: On + Friday 4:00. Never a prompt job. |
| Something with no kind | Note on the property. Not a routine. |

---

## Build order (do not jump)

**PR A — Clock PATCH (no new chrome)**  
Persist time/weekdays/enabled + revision. `PATCH /api/loops/:id`. Tests: no backfill; v2 migrate; planned still can’t enable.

**PR B — Schedule GUI**  
Time + weekday chips + Save on existing cards. Planned: can edit when, cannot Run/On. Kill Hermes/cron copy on the page.

**PR C — Ask propose + Allow**  
`POST /api/loops/:id/propose` → `LoopProposal`. Desk section **Schedule changes** (Allow/Deny, no Copy, no portal). Ask structured bar (not NLP). GUI PATCH supersedes a pending proposal.

**PR D — Property scope**  
`all` vs frozen id list. Morning evaluate/Hermes only those ids. Recheck stays full book.

**Not in these PRs:** owner-letter evaluator, NLP, pocket, launchd, Cua from the clock, “create any routine,” timezone editor.

**Amendment 2026-08-23 (CEO review, HOLD SCOPE):** ship PRs A then B, then build owner-letter v0 before PR C. Ask-proposes-a-clock-change (PR C) is chat plumbing for a clock no office has used yet — defer until a named office asks for it; PR D stays gated on a named book as written. **Status: done as amended** — PR A (clock PATCH + revision, no backfill), PR B (Schedule GUI chips), and owner-letter v0 (`server/owner-letter.ts`, Copy-only) shipped 2026-08-23.

**Amendment 2026-08-26 (calendar projection):** the month view is presentation and navigation only. It derives occurrences from the existing typed schedules and cannot create a one-off date, exception, new kind or prompt job. Paused/timezone-held entries remain visibly named; inaccessible planned kinds are absent. The time/weekdays/enabled PATCH remains the only GUI clock write.

**Amendment 2026-08-26 (conversational control plane):** an explicit product instruction activated the narrow PR C behavior through the shared Ask action broker. Bud returns one closed `run-routine` or `change-routine` request; RealBud resolves the named routine and revision, renders the before/after card in Ask and Desk, and only Allow calls the existing `runNow` or clock PATCH. The action id deduplicates a retried Run now. A stale same-routine edit fails closed. This does not add custom routine creation, prompts, property scope, another clock, or Hermes cron.

**Amendment 2026-08-26 (execution receipts + source methods):** Schedule now shows the code-owned dependencies for each typed routine and expandable durable phase receipts. Manual ids cannot cross routine boundaries; scheduled keys suppress restart duplicates; overlap is visible; error/detail text is bounded and secret-redacted. You shows one RealBud-owned source map: local PMS export active, and Direct API / restricted Composio / approved MCP only as collapsed pilot-gated implementation candidates. It is not the generic connector marketplace and exposes no connect/execute authority.

**Amendment 2026-08-27 (inbound interrupt foundation, clock still gated):** Desk can ingest one fixed, labelled Demo inbox batch through the bounded `realbud` contract described in ADR 0002. It deduplicates messages, collapses threads, stages operational reply wording and records Waiting/Close through the encrypted Desk owner. This does not make `inbound-triage` available on Schedule: there is no mailbox adapter, poller, OAuth grant, attachment reader or automatic follow-up run. Enabling the clock still requires the named-office gate and a code-owned evaluator/source path.

v2 scope after a named book (otherwise “Oak” is a fixture id). v3 Add is shipping a kind, not a settings page.

---

## Safety canary (must stay green)

- Send 403. No new send path from Allow-proposal.
- Clock executor `mayLaunchCua === false`.
- Catalog has no `prompt` / `botId`.
- Ask cannot write `loops.json` except via propose → Allow.
- Pack `cron_mode: deny`. No Hermes gateway started for routines.

---

## What this is not

Hermes.app Routines, Bot Mode roster, OpenMausBot MAUS + prompt, extra agents, Always-allow, user-authored skills as loops, two clocks.
