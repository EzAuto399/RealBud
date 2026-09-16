# RealBud — complete goal prompt

Date: 2026-09-04 · architecture direction updated 2026-09-12

Repo: `EzAuto399/RealBud` (local: `/Users/yoda/projects/PropertyMe`)
Use: start with the current direction below and `docs/NEXT-WAVE.md`.

**15 September sharing decision:** staff retain private Desks, conversations, memory, files and individual app accounts. Share reviewed results, review requests or handoffs deliberately with named participants; a shared database is not permission to merge personal workspaces. Follow the [selective-sharing implementation sequence](REALBUD-SELECTIVE-SHARING-2026-09-15.md). Company/department work still needs durable ownership and continuity; sharing a result does not grant account access, worker execution or remote computer control. This is the approved product direction, not installed-platform acceptance.

**15 September coverage plan:** use the [two-device completion and acceptance plan](REALBUD-TWO-DEVICE-ACCEPTANCE-2026-09-15.md) for connection semantics, build order, departmental rehearsal and 40 installed acceptance cases. It records the current shared-workflow/managed-worker gaps and separate Mac/Windows proof gates; it is planning, not new test passes. The active 65-task register below remains authoritative.

**Latest physical two-Mac checkpoint (14 September):** two working desktops, two private profiles and one company PostgreSQL host passed 15 synthetic checks on the MacBook and Mac mini, including atomic initial sign-in, pinned TLS, invitation/username retry, private-scope denial, dormant plan import and host/peer restart. [Current kit, receipts and remaining work](../outputs/realbud-physical-macs-2026-09-14/README.md): 470 company tests passed; final kit v2.1 rendered on both Macs. This does not establish shared Desk/Ask/Schedule execution, Hermes/Composio/Cua, installed background services, Windows or live office readiness. Retain the host's admitted PostgreSQL directory during kit changes. A separate business brain remains optional.

**14 September implementation checkpoint:** execution is on `codex/company-core-foundation`. Use the [65-task active checklist](REALBUD-CORE-EXECUTION-2026-09-14.md), [initial foundation evidence](../outputs/realbud-core-implementation-2026-09-14/README.md) and [host setup/joining checkpoint](../outputs/realbud-host-orchestration-2026-09-14/README.md). Owned PostgreSQL setup, company-only pinned HTTPS joining and persistent member sign-in/recovery now have source and local integration proof (450 tests); the rendered source app also created a fresh host/company. Two Grok 4.6 xhigh workers completed; a third delivered partial authentication code that was independently completed and tested. Native installers/services, device identity, migration, confined workers, complete native integrations, managed billing and installed Windows/macOS acceptance remain open. Service administration cannot impersonate a member. Historical registers remain dated snapshots; the active register governs progress.

**14 September core-completion handoff:** the [self-contained GPT-6 Pro brief](REALBUD-GPT6-PRO-CORE-BRIEF-2026-09-14.md) consolidates the full company/QM/native-integration scope, current evidence, missing work and completion gates. Use the [build meta-prompt](REALBUD-GPT6-PRO-BUILD-META-PROMPT-2026-09-14.md) to obtain an execution prompt. The [update strategy](REALBUD-UPDATE-STRATEGY-2026-09-14.md) requires automatic discovery of stable releases, verified staging and owner-configured idle activation with durable recovery; no floating upstream main/latest. The 61 tasks remain planned. This handoff supersedes the older Pro audit scope, not current runtime safeguards.

**Architecture precedence:** [Computer-connected work and durable routines](REALBUD-COMPUTER-WORK-ARCHITECTURE-2026-09-12.md) is the current recommendation for source ownership, computer capabilities, operational memory and delivery order. It supersedes older portfolio-centred, permanently browser-only and single-person-only planning here. It does not declare those runtime changes implemented or relax existing action prohibitions. Dated build and rollout claims below are historical; verify current code and office evidence before reusing them.

**14 September company-platform planning:** the latest request requires all three proposal outcomes for each authorised member, easy Set up/Join/Move company, Windows and macOS desktops, a shared operational database and cooperating private Bud contexts. Follow [the company platform plan](REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md) and [61-task dependency register](REALBUD-COMPANY-PLATFORM-TASKS-2026-09-14.json). Recommended architecture: one RealBud service/Postgres authority and clock, isolated stock-Hermes workers, authenticated native companions, and selected QM patterns/code rather than the full QM runtime. One Bud identity means one product persona, not one globally shared private conversation. This supersedes older planning deferrals and the open-ended QM adoption assessment; it is not implemented team support or a changed customer quote. Existing action prohibitions remain.

**Native integration requirement:** Composio is the first-class tool/service connection provider; Cua Driver is the computer-use backend; Hermes browser/site-to-CLI and local utility capabilities are admitted behind RealBud authority. Follow [the native integration contract](REALBUD-NATIVE-INTEGRATIONS-2026-09-14.md) for account lifecycle, hard operation denial, device-owned cookie/session storage, driver/version compatibility and both-OS acceptance. Do not infer a secure browser route from safe mode or a native Hermes wrapper from the current Cua 0.19.3 pin.

**14 September post-meeting direction:** the user reports proceeding with RealBud and requests planning for two desktops, profiles and one main host. Follow [the two-desktop plan](AUSTIN-TWO-DESKTOP-PLAN-2026-09-14.md). This supersedes the Kevin-only deferral below for architecture planning, without claiming team implementation or an agreed additional-user price. CRM is undecided; RealBud and any CRM retainers remain under negotiation. Assess the identified QM candidate and confirm whether the PCs serve one or two people. Preserve one office clock, one Bud persona, private staff state and unmodified Hermes.

**Host preference:** one existing staff desktop hosts the office service while both PCs remain usable. No extra host hardware or mandatory cloud-server subscription in the baseline. Build repeatable Set up office / Join office / Move or restore office journeys; validate capacity and availability before promising a cadence. QM is now identified as yc-software/qm: use [the assessment](AUSTIN-QM-HOST-ASSESSMENT-2026-09-14.md) to evaluate reuse before building a fresh team layer. It is not an installed or approved engine migration; staff count and the particular host remain unconfirmed.

**13 September delivery checkpoint:** Kevin is the sole initial operator and reviewer; a second staff rollout is deferred. The local signed app now uses admitted stock Hermes **0.21.2**, with 0.21.0 retained for rollback. Installed Ask and one synthetic bill Prepare passed; selected four-stage source QA, earlier failures and remaining Windows/live-source acceptance are recorded in [the accounts QA handoff](AUSTIN-ACCOUNTS-WORKFLOW-QA-2026-09-13.md). Profiles and remote backends remain engine capabilities, not permission to add another office clock or promise shared-user access.

Related: `DESIGN.md`, `docs/OFFICE-DESIGN.md`, `docs/PRODUCT-DESIGN-PLAN.md`, `docs/NEXT-WAVE.md`, `docs/IDENTITY.md`, `docs/PRODUCT-BRIEF.md`, `docs/WORKFLOW-PLAN.md`, `docs/PILOT-CONTRACT.md`, `docs/APPROACH.md`, `pack/property/SOUL.md`, `CLAUDE.md`

---

**Later team direction:** RealBud is the command centre for work, permissions, one clock and results; staff may use private messaging or the app as entry points. Reusable packs and private customer configuration stay separate. Follow the [team contract](REALBUD-TEAM-USAGE-2026-09-13.md); current paired channels share one Bud thread and do not yet supply private staff access. Kevin-only delivery remains first.

## Paste block (short)

You are building **RealBud**, a local work assistant for an Australian property office. It uses the office's approved computer, files, apps and websites to complete work and repeat proven workflows.

**Wall line:** The PM talks to RealBud. RealBud does the routine work. It only reaches someone else when asked — and never sends a notice or moves trust.

RealBud owns the window (Desk · Ask · Schedule · You), durable jobs, permissions, receipts and the clock. Keep one Bud identity and the pinned headless Hermes worker. Start with one operator/device, but agency records and source access must have explicit ownership. PMS/bank/mail/files remain authoritative for their respective records. Bud retains source references, expected obligations, workflow state and decisions; it does not ask staff to maintain another portfolio. Use file/API/browser/native adapters through the same job boundary. Broader native actions and live-source schedules are a staged implementation target, not permission to bypass today's fence.

Hard gates: no send, no trust, no statutory draft, no invented legal clock, no Hermes.app, no Hermes source edits, no extra RealBud agents, no tenant-facing bot, no law crawler.

Current foundations include saved-source preparation, a job queue and clock, attended portal work, connected-app brokerage and checked bank-file preparation. These are distinct proof levels; templates and model summaries do not prove a live office workflow. Next: one source-bound REI/bills path without a mandatory portfolio import, durable bill observations, broader scoped computer adapters, then tested schedules. Keep sample properties for practice and preserve existing records during migration. See the architecture review for specific code gaps and acceptance tests.

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

**Start with one named staff operator.** Keep one Bud identity. Agency data belongs to the agency; later shared-source and CRM workflows require separate staff identities and explicit access. The interview does not justify making all records permanently personal to one PM.

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

## 3. Target topology (2026-09-12)

```
Named staff → Ask / Desk / Schedule / paired phone
                       │
             RealBud durable job controller
              ↔ jobs, decisions, evidence
                       │
             Bud worker → capability broker
                       │
          file / API / browser / native adapters
                       │
              existing agency systems
                       │
           verified results → Desk exceptions
```

| Store | Holds | May override |
|---|---|---|
| Existing PMS / financial systems | Current property/tenancy and financial records | Bud cannot silently replace their authority |
| RealBud operational state | Source index, expected obligations, jobs, decisions, evidence and policies | Only through validated operations and current authority |
| Existing `desk.json` / notes | Legacy records, drafts and preferences retained during migration | Notes cannot override source facts or evaluator rules |

The index is refreshable; obligations and operation receipts are durable. A selected-file job must not require a manually created property catalogue. Office-wide coverage still requires a complete, current source scope. The target adapters are not all implemented; preserve today's runtime restrictions until each is wired and verified.

**Hard rule:** `evaluateProperty` never reads the vault. Notes colour a draft. They do not change `draft` / `escalate` / `clear` / `skip` / `hold`.

Worker identity stays in `pack/property/SOUL.md` and the RealBud-owned Hermes home (`~/.realbud/hermes` in the intended product configuration). Verify every launch path resolves there; do not share the personal Hermes Desktop home. Operational records belong to RealBud, not hidden worker memory.

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
- **The user never touches Hermes.** No Terminal, no `hermes` CLI in any user flow, no Hermes vocabulary outside Advanced diagnostics. RealBud drives the worker programmatically — install, model/auth config, updates — and translates every result into RealBud UI.
- Law is a **refusal**, not a feature. No crawler, no national notice-period table. Quote a government page only if a human filed it with `source` + `retrieved` + `review_by`. Stale = do not use. SOP is the licensee’s or training partner’s; we author one page only: *no notices, no trust, escalate emergencies.*
- Serving a notice on WhatsApp is not reliable service. Courtesy + disclaimer, or escalate.

---

## 7. Stack (locked)

| Piece | Rule |
|---|---|
| Window | This repo (OpenMausBot MIT fork). We own chrome. |
| Worker | Admitted stock Hermes release from `server/hermes-releases.ts` and the runtime selector; local 13 September selection **0.21.2 / v2026.9.11**, prior 0.21.0 retained. `server/hermes-pin.ts` retains the older baseline. Profile `property`. Promote only after compatibility checks; never track `main`. |
| Models | `hermes -p property model`. Not RealBud agents. |
| Computer use | Bundled Cua, pin in `server/cua-bounded.ts` (0.19.3). macOS host for live. Bounded session + recipe. Linux/Windows: CSV + fake portal only until the contract says otherwise. |
| OpenMausBot upstream | Harness/safety only (PATH, ports, redact, stall watchdog, proxy paths, permission broker). Not iOS, extra engines, teams, plugins, model shop. |
| Install | RealBud.app + pinned Hermes + `pack/property`. Home screen says RealBud. Hands in You/Settings. |

Forking Hermes Desktop is rejected. Overlaying Hermes.app is rejected.

---

## 8. Where the software actually is (2026-08-29)

Shipped, not slides:

- Appliance chrome: Desk / Ask / Schedule / You. Warm Ledger tokens. Desk V3 book.
- Product mode: one Bud thread; denied bot/group/plugin/cloud-computer routes
- Desk book: add/edit/remove properties, options, locked `never`
- Morning evaluate + Allow/Deny/Edit/Copy; send 403
- CSV import matching by **address or property code** (`parsePmsExport`; identity-column aliases), freshness / unmatched / partial / reversed holds; ambiguous rows become row-level holds (batch-reject stays schema-only; zero-match imports never fake live)
- **Notes on the property card; vault seeded as Hermes cwd; Allow appends to the note + decisions log; evaluate never reads the vault (regression-tested)**
- **Ask → Desk: "Put on Desk" plus paste/drop intake that stages book cards for one Allow**
- In-app worker install, model attach, Test hands, recovery-key reveal/unlock
- Hermes pin, pack, fail-closed Recheck (spawn now also requires `approvals.mode: manual`)
- Gate hardening: product mode denies `autoApprove`/`alwaysAllow`/`chiefOfStaff` on bot PATCH, Bud rename and Bud delete; auto-answer of permissions is off in product mode
- Named loops with an editable clock (PATCH time/weekdays/enabled + revision, no backfill) and Schedule GUI chips
- Shared this-morning brief: Recheck lands every known address; seeded demo kinds stay on the book and do not count as Held; inbox stays not connected until a named office reads mail
- **Friday owner letter v0** (`server/owner-letter.ts`): one factual catch-up per property per week from Desk facts + Notes; Copy-only; Run now or the Friday clock lands it on Desk
- Bounded fake-portal prefill; Bud submit 403
- Attended live portal (“Run beside me”) behind per-job Attach; pay/sign/notice/send stay outside Bud (`docs/PORTAL-WORK.md`)
- Pilot contract still **demo** until You → This office is filled with a real shop (`agency: RealBud Demo Book` does not count)

Not shipped (see `docs/NEXT-WAVE.md`; W1–W5 are done):

- Ask proposing a Schedule change as a card (PR C — deferred until a named office asks)
- Inbound / emergency triage loop
- Named paying/pilot agency
- PropertyMe OAuth (read) — visit must confirm PMS + CSV pain
- PM pocket messaging
- Installer a graduate can double-click
- Unattended CUA / Submit standing rule / money·sign·notice Submit (never)

---

## 9. Beta bar (real-estate integration)

Beta is **not** more architecture. Beta is one PM and a **real book**.

**Door (must) — done at HEAD:**

1. ✅ Import **their** arrears/export (identity-column mapper; reject ambiguous batches today).
2. ✅ Match rows to Desk properties by **address or their property code**, not fixture ids.
3. ✅ Morning cards from those facts (still shop rules, still no send).
4. ✅ PM Copies into the PMS they already use.
5. ✅ Hands stay honest (Worker live or CSV live — never silently Demo; miss or uncovered property ⇒ hold).

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

W1–W5 and the morning brief in `docs/NEXT-WAVE.md` are shipped. Stop unless a named office in `docs/PILOT-CONTRACT.md` asks for one gated item. Do not fake an inbox read.

The visit still finishes the product. Fill the eight fields in `docs/PILOT-CONTRACT.md`. After a named agency: installer a graduate can double-click, then vendor-test portal prep.

Do not start a law shelf, a vault page, a second agent, Ask-proposes-clock-changes (PR C), inbound mail, or live CUA until the pilot contract names a real agency and it asks for one.
