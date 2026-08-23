# RealBud — complete goal prompt

Date: 2026-08-23 (state synced to HEAD `bdb05ce` + gate hardening)  
Repo: `EzAuto399/RealBud` (local folder still `PropertyMe`)  
Use: paste this whole file into a new session, or point an agent at it. If a later idea fights this document, **this document wins**.

Related: `docs/IDENTITY.md`, `docs/PRODUCT-BRIEF.md`, `docs/WORKFLOW-PLAN.md`, `docs/PILOT-CONTRACT.md`, `docs/APPROACH.md`, `pack/property/SOUL.md`, `CLAUDE.md`

---

## Paste block (short)

You are building **RealBud**, a vertical Australian property-management desk. Not a PMS. Not Hermes. Not an agent OS.

**Wall line:** The PM talks to RealBud. RealBud does the routine work. It only reaches someone else when asked — and never sends a notice or moves trust.

RealBud owns the window (Desk · Ask · Schedule · You). Pinned Hermes profile `property` is the only worker, headless. Models attach on that profile. One user: the PM. One thread: Ask (and later the PM’s own WhatsApp/Telegram). Named loops on RealBud’s clock. Computer use is a trained portal adapter after Allow, not a playground. The book (`~/.realbud/vault`) is the only memory Hermes may use. `desk.json` is shop rules; evaluate never reads the book. PMS is the legal/money record; we operate it (CSV first, then API/click).

Hard gates: no send, no trust, no statutory draft, no invented legal clock, no Hermes.app, no Hermes source edits, no extra RealBud agents, no tenant-facing bot, no law crawler.

Current software is a training appliance (fixture book + CSV + fake portal) whose **beta door is done**: their export matches by address or their property code, morning cards land on Desk, the PM Copies into their PMS. Notes on the card, Ask→Desk proposals, editable loop times (PRs A/B), and Friday owner letter v0 also shipped. Next work waits on a named office in `docs/PILOT-CONTRACT.md`. Do not add surfaces. Do not rebuild PropertyMe.

---

## 1. What we are

A **supervised unregistered assistant** for Australian residential property managers, sold first through a **licence-training provider** to people who just passed.

We sit **on** the agency PMS (PropertyMe, Property Tree, Reapit PM — confirm on the visit; do not assume). We take hours off the PM: routine loops plus the odd interrupt. A licensed person still sends notices and still moves trust money.

We **operate their system** so we can cover the jobs AiMe-class tools already sell (courtesy arrears, log a job, draft a reply, owner update) **and** the week those tools do not run (inbound/emergency, a portal with no API, a file note AiMe never sees). Native AiMe will feel smoother *inside* PropertyMe. We win by working **any** PMS, across the book + mail + one trained click, for shops that have no AiMe.

**Sales line:** “It works the system you already have — and the requests that never land in AiMe.”  
**Not:** “We replaced PropertyMe.”

### What we are not

PMS, trust accountant, solicitor, Tapi, Hermes, OpenMausBot, OpenManus, Obsidian, a second brain, a tenant call-centre, a bot roster.

Do not ship under the names **PropertyMe**, **Hermes**, **OpenMausBot**, or **OpenManus**. Product name is **RealBud**. Data dir `~/.realbud`. App id `com.realbud.app`.

---

## 2. Who talks to it

**The PM is the only user.**

```
PM  ── Desk or Ask or (later) phone ──▶  RealBud.app
                                              │
                                              │  same property worker
                                              ▼
                                         Hermes `property` (headless)
                                              │
                         only if the PM asked, and after Allow
                                              ▼
                              tenant / owner / tradie / PMS click
```

Messaging is how the **PM** uses the desk from a pocket. It is not how tenants talk to an agent. Auto-texting a tenant is send. Forbidden unless the PM asked and tapped Allow.

When pocket exists: RealBud starts the `property` gateway, allowlist = that PM only. WhatsApp **Business Cloud API** on a dedicated path for the PM — not Baileys QR on a personal phone. No tenant channel. No full terminal on the chat adapter. No Hermes setup wizard. `cron_mode: deny` stays.

---

## 3. Topology (locked)

```
                 PM (only user)
          Desk app          phone later
               \                /
                ▼              ▼
           RealBud.app
           Desk · Ask · Schedule · You
                    │
                    │  ACP / CLI / trained CUA
                    ▼
           Hermes `property`   pin v0.20.3 / tag v2026.8.16.2
           SOUL · PM skills · model on the profile
           cwd = ~/.realbud/vault
           approvals.mode: manual   cron_mode: deny
                    │
         ┌──────────┼──────────────┐
         ▼          ▼              ▼
   desk.json      the book        PMS
   shop rules     notes/SOP       money + legal file
   evaluate       preferences     we read / operate
                  not law         human sends
```

| Store | Holds | May override |
|---|---|---|
| PMS | Money, legal file | Nothing we invent |
| `~/.realbud/desk.json` | Properties, options, drafts, ledger, evaluate | Notes cannot |
| `~/.realbud/vault` | Narrative: `properties/<id>.md`, later owners/, decisions/, empty sop/ + reference/ | Preferences only |

**Hard rule:** `evaluateProperty` never reads the vault. Notes colour a draft. They do not change `draft` / `escalate` / `clear` / `skip` / `hold`.

Worker identity stays in `pack/property/SOUL.md` → `~/.hermes/profiles/property/`. Do not put a second SOUL in the vault. Ignore Hermes `memories/`. Two brains is the failure mode.

---

## 4. Window (locked)

Four places. Nothing else on first paint.

| Nav | Job |
|---|---|
| **Desk** | The work. Drafts, escalations, holds, property cards, Notes. Allow / Deny / Copy. |
| **Ask** | One thread with the one worker (canonical id `bud`). “What’s waiting?”, “draft Friday for Oak”, “pipe burst.” Same Hermes ACP. |
| **Schedule** | Named loops on RealBud’s clock. Not Hermes cron. Not a prompt runner. |
| **You** | Name, Hands (pin + pack + test), later Pocket. |

Ask is not a second inbox. If Ask drafts a courtesy or a job, it becomes a **Desk** card. Approve once.

**Out of the default window:** Workshop, New assistant, New room, groups, Plugins, Computer playground, Chief of Staff, model shop, ⌘1–9 bot hopping, leftover Koda. Product mode already denies many of those routes — keep it that way. CUA is a **skill on a loop**, not a pane.

Onboarding: name → three rules → Desk. No engines, no mic, no WhatsApp setup.

---

## 5. Workflows (the only ones)

**Routine — clock.** Schedule (e.g. 7:30 morning arrears) → Hermes or CSV supplies ledger facts → Desk evaluate (shop rules, not law) → cards → PM Allow/Deny → Copy, or one trained PMS/portal click after Allow. Lid shut: catch-up on open. Nothing sends while nobody is looking.

**Routine — PM asks.** Ask or later phone → worker uses book + desk facts → answer, or a Desk card if something must leave the building.

**Reach someone else.** Only because the PM asked, and only after Allow. Never auto. Never statutory. Never trust.

**Here and there.** “Pipe burst at Oak” → classify, escalate card, spend-cap / after-hours from property options + note. Do not call the plumber. Do not pay.

**Operate their PMS.** Read API where it exists; CSV/export until then; trained computer use only for the click the API will not give (create job, comment, courtesy reminder). Train once → recipe → named loop. Bounded tools only (`navigate`, `read`, `fill`, `click_semantic`). Bud may prefill. Submit stays human. Fake portal already proves this; live portal waits on `docs/PILOT-CONTRACT.md`.

Loops (catalog, not agents):

| Loop | Status |
|---|---|
| Morning arrears / money | Built (fixture + CSV + Hermes fail-closed) |
| Friday owner letter | Built (v0: Desk facts + Notes, Copy-only) |
| Inbound / emergency triage | Declared |

Same worker. Different option sets on the property card. Not an emergency-bot / tenant-bot roster.

### Routines: editable, still RealBud’s clock

Full design (usability, eng, Hermes capability): `docs/ROUTINES.md`.

The PM must be able to **see, turn on/off, retiming, and (later) add** routines from **Schedule** and from **Ask**. That is not Hermes Bot Mode cron and not the old OpenMausBot “pick a bot + free-text prompt.”

| Piece | Owner | Hermes |
|---|---|---|
| When (7:30, Friday 4pm, weekdays) | RealBud Schedule | Never (`cron_mode: deny`) |
| What lands on Desk | RealBud evaluate | Facts / draft text only |
| How facts are read | Skill on `property` pack | `hermes -p property` |
| Edit UI | Schedule form + Ask propose | No cron UI, no skill hub |

**A routine is a typed loop, not a prompt.**

Each routine is: `kind` (from a small catalog) + `when` + `which properties` + `enabled`. Kind is one of: morning-money, owner-letter, inbound-triage. Adding a routine means picking a kind that already has an evaluator + Hermes skill — not inventing a new agent.

**GUI (Schedule)**  
- List: name, next run, last result, On/Paused, Run now.  
- Edit: time, weekdays, which properties (all vs this book vs one card).  
- Add: choose a **kind that exists**. If the kind is still declared (owner-letter), the card stays “Planned” until that loop is built. No blank prompt box.

**Ask (in-chat)**  
Same objects, different door. “Run money check at 8 instead of 7:30.” “Pause Oak on the morning loop.” “Add Friday owner letters at 4.” Ask does **not** start a cron. It **proposes a Schedule change** as a Desk/Schedule card. Allow applies it. Deny leaves the clock alone. Same pattern as courtesy drafts.

**Seamless with Hermes**  
- One worker, one book, one SOUL.  
- Clock tick → named skill → JSON/draft → Desk.  
- Editing “how” (which bank, which CSV) is property options + skill, not a new bot.  
- Lid shut: catch-up on open (already). Later launchd only writes a result file RealBud reads — still fail-closed, still no send.

**Forbidden (looks like “routines” but is the old OS)**  
- Free-text prompt saved as a job.  
- Hermes gateway cron / `/cron`.  
- “New assistant” per routine.  
- Always-allow. A routine may **never** send, pay, or issue a notice even if the PM typed that in Ask.  
- Ask applying a schedule change without Allow.

**Build order (do not jump)**  
1. Schedule edit of **existing** loops: time, weekdays, enable (GUI). Ask can propose those same fields.  
2. Property scope on a loop (“all” vs one property).  
3. Build owner-letter as a real kind, then it appears in Add.  
4. Do not build “create any routine from chat” until kinds 1–3 exist and a named office has used the clock.

---

## 6. Hard gates (never “be helpful”)

- No trust EFT, disbursement, recon, or “pay the levy from the receipt.”
- No draft or send of Form 11/12, NSW termination, VIC NTV, rent-increase, entry notices.
- Day counts on Desk are **shop reminder rules**, not state law. One early day voids insurance. Do not invent a legal clock.
- `POST /api/desk/drafts/:id/send` stays **403**. Courtesy disclaimer cannot be stripped.
- No Always-allow, `--yolo`, Hermes cron, Hermes.app, Hermes source edits.
- No TICA, lock changes, legal advice, inspection app, payments licence.
- No photos of tenant belongings published.
- No back-dating a maintenance request or a notice.
- Law is a **refusal**, not a feature. No crawler, no national notice-period table. Quote a government page only if a human filed it with `source` + `retrieved` + `review_by`. Stale = do not use. SOP is the licensee’s or training partner’s; we author one page only: *no notices, no trust, escalate emergencies.*
- Serving a notice on WhatsApp is not reliable service. Courtesy + disclaimer, or escalate.

---

## 7. Stack (locked)

| Piece | Rule |
|---|---|
| Window | This repo (OpenMausBot MIT fork). We own chrome. |
| Worker | Hermes Agent **v0.20.3** (`v2026.8.16.2`, commit in `server/hermes-pin.ts`). Profile `property`. Pin and bump when **we** choose. Do not track `main`. |
| Models | `hermes -p property model`. Not RealBud agents. |
| Computer use | Bundled Cua, pin in `server/cua-bounded.ts` (0.19.3). macOS host for live. Bounded session + recipe. Linux/Windows: CSV + fake portal only until the contract says otherwise. |
| OpenMausBot upstream | Harness/safety only (PATH, ports, redact, stall watchdog, proxy paths, permission broker). Not iOS, extra engines, teams, plugins, model shop. |
| Install | RealBud.app + pinned Hermes + `pack/property`. Home screen says RealBud. Hands in You/Settings. |

Forking Hermes Desktop is rejected. Overlaying Hermes.app is rejected.

---

## 8. Where the software actually is (2026-08-23)

Shipped, not slides:

- Appliance chrome: Desk / Ask / Schedule / You
- Product mode: one Bud thread; denied bot/group/plugin/cloud-computer routes
- Desk book: add/edit/remove properties, options, locked `never`
- Morning evaluate + Allow/Deny/Edit/Copy; send 403
- CSV import matching by **address or property code** (`parsePmsExport`; identity-column aliases), freshness / unmatched / partial / reversed holds; ambiguous rows become row-level holds (batch-reject stays schema-only; zero-match imports never fake live)
- **Notes on the property card; vault seeded as Hermes cwd; Allow appends to the note + decisions log; evaluate never reads the vault (regression-tested)**
- **Ask → Desk: "Put on Desk" creates a pending draft that needs the one Allow**
- Hermes pin, pack, fail-closed Recheck (spawn now also requires `approvals.mode: manual`)
- Gate hardening: product mode denies `autoApprove`/`alwaysAllow`/`chiefOfStaff` on bot PATCH, Bud rename and Bud delete; auto-answer of permissions is off in product mode
- Named loops with an editable clock (PATCH time/weekdays/enabled + revision, no backfill) and Schedule GUI chips
- **Friday owner letter v0** (`server/owner-letter.ts`): one factual catch-up per property per week from Desk facts + Notes; Copy-only; Run now or the Friday clock lands it on Desk
- Bounded fake-portal prefill; Bud submit 403
- Pilot contract still **demo** (`agency: RealBud Demo Book`)

Not shipped:

- Ask proposing a Schedule change as a card (PR C — deferred until a named office asks)
- Inbound / emergency triage loop
- Named paying/pilot agency
- Live portal / PropertyMe OAuth
- PM pocket messaging
- Installer a graduate can double-click

---

## 9. Beta bar (real-estate integration)

Beta is **not** more architecture. Beta is one PM and a **real book**.

**Door (must) — done at HEAD:**

1. ✅ Import **their** arrears/export (identity-column mapper; reject ambiguous batches today).
2. ✅ Match rows to Desk properties by **address or their property code**, not fixture ids.
3. ✅ Morning cards from those facts (still shop rules, still no send).
4. ✅ PM Copies into the PMS they already use.
5. ✅ Hands stay honest (Hermes live or CSV live — never silently Demo; miss ⇒ hold).

**Sells — all shipped at HEAD:**

6. ✅ Notes on the property card; Hermes cwd = vault; Allow appends to the note.
7. ✅ Ask writes Desk (one Allow place).
8. ✅ Friday owner letter v0 from Desk facts + Notes, Copy only (`server/owner-letter.ts`; clock or Run now).

**Also done:** ambiguous/unmatched CSV rows are row-level hold work items; batch-reject stays for broken schemas; zero-match imports keep the book's honest hands.

**After a named shop is in `docs/PILOT-CONTRACT.md`:**

9. One vendor-test portal, bounded CUA, human Submit.
10. Pocket: Telegram or WhatsApp Cloud, this PM only.
11. PropertyMe **read** API only if the visit says they are on PropertyMe **and** CSV is the pain.

**Not beta:** tenant WhatsApp, law crawler, trust, Form 11, Tapi, vault page, extra agents, Computer playground, “we replaced PropertyMe.”

Architecture is ahead of integration. Prefer **their file in, our ids out** over another workflow engine.

---

## 10. How to work in this repo

- Local path: `/Users/yoda/projects/PropertyMe`. GitHub: `EzAuto399/RealBud`.
- YAGNI. No unrequested abstractions. Tests for evaluate, gates, CSV parse, product-mode denials, send 403.
- First-run and Desk copy must not contain `Obsidian`, `vault`, or `second brain`. UI noun is **Notes**.
- Internal env `OMB_*` may stay for harness. User-facing strings say RealBud.
- If a change does not make the worker **more PM and less general agent**, it is out.
- Stop when a principal can say: “I can see what it used, it cannot send, and it did not invent a clock.”

### Next build if no other instruction

Code is ahead of the pilot. In order, when there is a reason:

1. `docs/PILOT-CONTRACT.md`: add required fields — PMS brand, named exporter, export cadence, office OS  
2. After a named agency signs: installer a graduate can double-click, then vendor-test portal prep (bounded CUA, human Submit)  

Do not start a law shelf, a vault page, a second agent, Ask-proposes-clock-changes (PR C), or live CUA until the pilot contract names a real agency and it asks for one.
