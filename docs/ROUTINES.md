# Routines — product design (GUI + Ask, Hermes as hands)

Date: 2026-08-21  
Status: **design locked** — implement PR A–D below; do not skip to “create any routine”  
Related: `docs/GOAL-PROMPT.md` §5, `docs/WORKFLOW-PLAN.md`

Four reviews (code, usability, engineering, Hermes capability) agree: **PMs retune named loops. They do not author jobs.** Hermes fetches facts. RealBud is the clock, the cards, and Allow.

---

## Wall line

> Tell Ask to run the morning money check at eight — then Allow. That is enough magic.

---

## Today vs the hole

Schedule can Pause / Resume / Run now on **Morning money**. PATCH only accepts `enabled`. Time and days are catalog constants. Ask can put a **courtesy** on Desk, not a clock change. Friday letter and inbound stay Planned.

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

Clock stays CLI one-shot. Ask stays ACP. Same profile, different door. `cron_mode: deny` stays. A `jobs.json` under the property home is a **gate failure**.

### Engineering

- Catalog owns: id, name, description, available, evaluator, `mayLaunchCua: false`.
- Persist in `loops.json` v3: enabled, time, weekdays, property scope, revision, proposals.
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

**Amendment 2026-08-23 (CEO review, HOLD SCOPE):** ship PRs A then B, then build owner-letter v0 before PR C. Ask-proposes-a-clock-change (PR C) is chat plumbing for a clock no office has used yet — defer until a named office asks for it; PR D stays gated on a named book as written.

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
