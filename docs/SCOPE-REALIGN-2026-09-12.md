# Scope realignment — 2026-09-12

Initial cut after live QA + transcript review. Continued in
[Computer-connected work and durable routines](REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md),
which adds direct meeting evidence, operational memory beyond a thin property
index, native-app/file capability, and a staged execution plan. That review
takes precedence on architecture; runtime changes remain to be implemented.

Related: `docs/GOAL-PROMPT.md`, `docs/PORTAL-WORK.md`, `docs/NEXT-WAVE.md`,
`docs/PRODUCT-BRIEF.md`

---

## North star (one sentence)

**RealBud is a supervised work queue + fence for an agentic worker that
operates the office’s real systems (PMS, REI Cloud, bank, mail) — not a
property portfolio app and not Hermes Desktop with a green skin.**

---

## Where we drifted (honest)

| Drift | Why it’s wrong |
|---|---|
| Desk as a hand-maintained building catalogue | Second PMS. Loses to PropertyMe/AiMe. Training fixture leaked into product identity. |
| Polish sample-book / Teach Bud / month calendar while model auth + isolation were broken | EOL cosmetics before the hands work. Wrong order. |
| Mixing Bud with Desktop Hermes (`~/.hermes`) | Product failure mode. Fixed direction: `~/.realbud/hermes` only. |
| “Just use Codex instead of RealBud” | Codex builds software; it is not the PM trust surface (Allow, never-send, portal fence, phone). |
| “Collect cookies into RealBud / website→CLI vault” | Credential jar. Fight `PORTAL-WORK`: use the PM’s real Chrome session via Attach. |
| Shipping more Desk CRUD / import packs before one live morning path | Architecture ahead of the office (same miss NEXT-WAVE already named). |

The original GOAL was already clear: **PMS is money/legal SoT; we operate it;
desk holds shop rules + drafts.** The demo book was a **training appliance**.
Treating it as the long-term product was the mistake.

---

## What “capable like Hermes” means (and does not)

**Means (keep / invest)**

- One pinned hands profile, headless, model-attached, isolated home
- Computer use on the real Mac / real Chrome (sessions stay in the browser)
- Ask + Schedule jobs that name an outcome; Bud reads/prefills/navigates
- Site rules that learn (read/prefill) without becoming YOLO
- Telegram as the PM’s remote Allow — same Bud, not a second agent
- Works **any named site the job needs** (capability); first proof can be REI Cloud / one PMS

**Does not mean (refuse)**

- Hermes.app, pets, New Agent, YOLO, free roam as default
- Editing Hermes agent source
- Unattended pay/sign/notice/send
- A second agent roster inside RealBud
- Replacing RealBud with raw Codex/ChatGPT

---

## Atomic keep / kill / reshape

### Keep (load-bearing)

1. RealBud window: Desk · Ask · Schedule · You  
2. Needs you / Allow–Deny / Copy — **never send, never trust**  
3. Portal fence + Attach / Run beside me (`docs/PORTAL-WORK.md`)  
4. RealBud clock + named loops (Hermes `cron_mode: deny`)  
5. Isolated Bud hands (`~/.realbud/hermes`, profile `property`)  
6. Telegram remote decisions for the paired PM only  
7. Shop rules / locked `never` (policy, not a portfolio)  
8. Job runs + evidence receipts  

### Reshape (do not delete blindly)

| Today | Tomorrow |
|---|---|
| Demo / local property catalogue as SoT | Thin **index/cache**: address ↔ PMS id, never-rules, last-seen — refreshed from export or portal list job |
| Morning from fixture book | Morning from **live export or portal read** → Desk cards |
| Sample book UI primary | Practice mode only; demote once a live source is attached |
| “Add property” as core Desk craft | Intake from Ask/CSV/portal match; manual add is escape hatch |
| Month calendar / Teach Bud polish | Secondary until live morning + Attach path is boring |

### Kill or freeze (not necessary for the north star)

- Growing Desk into a mini rent-roll CRM  
- Cookie / password vault inside `~/.realbud`  
- Per-building vanity management as a product pillar  
- Import-pack sprawl before one live office path works  
- Inbound / Pocket / graduate installer until named office (already gated)  
- Unattended always-on portal login  

---

## Correct architecture (SoT)

```
PMS / REI Cloud / bank / mail     ← system of record (live)
        ▲
        │  Attach + CUA / export (PM signed in)
        │
RealBud Desk                      ← decisions, drafts, never-rules, receipts
        │
Bud hands (Hermes property)       ← agentic worker, not the product window
```

Properties on Desk are **pointers + policy**, not the portfolio of record.

---

## Build order (brutal priority)

1. **Hands work** — model attach (ChatGPT/Codex or xAI) stays green; isolation stays true  
2. **One live morning** — export **or** Attach portal → Needs you (no demo catalogue required)  
3. **One site recipe** — REI Cloud or agency PMS: learn → map → saved job  
4. **Telegram Allow** on that path only (`@realbud…`, not Desktop “bud”)  
5. Then QOL (calendars, Teach Bud, empty states)

Anything that grows the local portfolio or polish without serving 1–4 is out of order.

---

## Explicit re-alignment statements

1. We were **wrong** to keep investing identity in “the book of buildings.”  
2. We were **right** to keep RealBud (not bare Codex) as the supervised desk.  
3. We were **right** that Bud must feel Hermes-capable as **hands**, fenced.  
4. We were **wrong** if we treat cookie farming as the login strategy.  
5. Demo book stays for practice/QA — **not** the commercial spine.

---

## Documentation continuation

- GOAL-PROMPT now leads with source-owned records and operational job memory, with an updated target topology.
- NEXT-WAVE now leads with the source-bound preparation, bill-state, adapter and scheduling sequence.
- The follow-up review challenges both a full portfolio and an insufficiently stateful thin-index design. Neither these edits nor the earlier keep/kill list constitutes installed or live-office proof.
