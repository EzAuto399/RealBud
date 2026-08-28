# RealBud — complete goal prompt

Date: 2026-08-28 (state synced through durable Ask/config/model recovery, fail-closed local-state recovery and isolated four-surface/recovery QA)
Repo: `EzAuto399/RealBud` (local folder still `PropertyMe`)  
Use: paste this whole file into a new session, or point an agent at it. If a later idea fights this document, **this document wins**.

Related: `DESIGN.md`, `docs/PRODUCT-DESIGN-PLAN.md`, `docs/IDENTITY.md`, `docs/PRODUCT-BRIEF.md`, `docs/WORKFLOW-PLAN.md`, `docs/PILOT-CONTRACT.md`, `docs/APPROACH.md`, `pack/property/SOUL.md`, `CLAUDE.md`

---

## Paste block (short)

You are building **RealBud**, a vertical Australian property-management desk. Not a PMS. Not Hermes. Not an agent OS.

**Wall line:** The PM talks to RealBud. RealBud does the routine work. It only reaches someone else when asked — and never sends a notice or moves trust.

RealBud owns the window (Desk · Ask · Schedule · You). Pinned Hermes profile `property` is the only worker, headless. Models attach on that profile inside RealBud's dedicated worker home (`~/.realbud/worker` by default). The engine and launcher also live under `~/.realbud/worker/runtime`; every Bud process uses that absolute launcher plus a private `HOME`. RealBud never discovers, launches, updates, downgrades, reads or writes the user's personal Hermes executable or `~/.hermes` profiles. One user: the PM. One thread: Ask, optionally projected to that named PM's private Pocket channels. Named loops on RealBud’s clock. Computer use is a trained portal adapter after Allow, not a playground. The book (`~/.realbud/vault`) is the only memory Hermes may use. `desk.json` is shop rules; evaluate never reads the book. PMS is the legal/money record; we operate it (CSV first, then API/click).

Hard gates: no send, no trust, no statutory draft, no invented legal clock, no Hermes.app, no Hermes source edits, no extra RealBud agents, no tenant-facing bot, no law crawler.

Current software has a strong **source-proved beta foundation**, not a completed real-office beta: fixture/CSV intake, morning cards, Ask→Desk proposals, editable loop times, Friday owner letter v0, Demo inbox, durable Ask/config/model recovery and bounded portal/bank/CUA proofs exist. The dependency-ordered exit plan is `docs/BETA-CONVERGENCE-PLAN.md`. Bounded portfolio lifecycle, typed live collectors, product execution bridges, installed release proof and named-office validation remain explicit gates. Live accounts and adapters still wait on a named office in `docs/PILOT-CONTRACT.md`. Do not add surfaces. Do not rebuild PropertyMe.

External agency and vendor research stays in `docs/research/` and never enters the runtime as a customer, connection or authority claim. You → General reads a session-gated `realbud.pilot-discovery.v1` projection only from the code-owned pilot contract, so Demo remains agency-neutral at 0/8 operational fields until the office confirms the named PM, PMS, exporter, cadence, identity, OS, jurisdictions and vendor test account. The projection groups the Australian ecosystem into seven portable system families and prefers structured export/API → restricted named connector → bounded browser/CUA. A partially named office remains visibly incomplete.

---

## 1. What we are

A **supervised unregistered assistant** for Australian residential property managers, sold first through a **licence-training provider** to people who just passed.

We sit **on** the agency PMS (PropertyMe, Property Tree, Reapit PM — confirm on the visit; do not assume). We take hours off the PM: routine loops plus the odd interrupt. A licensed person still sends notices and still moves trust money.

We **operate their system** so we can cover the jobs AiMe-class tools already sell (courtesy arrears, log a job, draft a reply, owner update) **and** the week those tools do not run (inbound/emergency, a portal with no API, a file note AiMe never sees). Native AiMe will feel smoother *inside* PropertyMe. We win by working **any** PMS, across the book + mail + one trained click, for shops that have no AiMe.

**Sales line:** “It works the system you already have — and the requests that never land in AiMe.”  
**Not:** “We replaced PropertyMe.”

### Load-off contract (locked)

RealBud is the **operational layer between the PM and the systems the agency already uses**. Its purpose is not to maximise tool calls, autonomous time or the number of workflows it can claim. It succeeds when the PM opens fewer systems, manually checks fewer records, remembers fewer follow-ups and receives a smaller, more accurate exception queue.

```text
existing PMS / bank evidence / inbox / calendar / portal
→ observe through an admitted read path
→ correlate facts and keep waiting work moving
→ prepare the exact draft, checklist or bounded next step
→ show only exceptions and consequences on Desk
→ PM Allow / Deny / Not now
→ Copy or prefill; licensed human Submit in the PMS
```

**Agentic at intent; deterministic at effect.** Ask may understand any safe PM outcome and decompose the whole job. Repeated work becomes a typed, versioned source adapter, evaluator and routine with receipts, retry rules and a recovery state. Technical ability to reach a website is not a product claim: a live site is supported only after its account, identity, origin, login/MFA, session behaviour, read-back and failure path are tested. CUA remains a bounded case adapter or recovery path, never ambient permission to roam the PM's computer.

The default work states are **Bud is handling it**, **Needs you**, and **Waiting on someone**. Reads, matching, classification, evidence gathering, diagnostics and draft preparation do not wait for approval. Only the exact consequential object waits for Allow. Review memory may compress familiar presentation; it never learns authority, law, source facts, auto-approval or permission to send.

Capability claims use four distinct evidence labels: **fixture/source proved**, **installed proved**, **pilot-gated**, and **named-office proved**. A simulator, source test, marketing page or slide deck must never upgrade one label into another. “Drafted” and “prefilled” never mean “sent,” “paid” or “completed externally.”

The default Desk response is a bounded active queue. It may carry the active property index needed for navigation, but it never carries portfolio Notes, contact/tenancy history or terminal case history. Opening one case or property fetches only that detail. A source-wide outage is one incident with an affected count; ambiguous source identities stay held until the PM explicitly links or rejects them; Waiting work always names its operational next check and closes with a receipt. These are ordinary reminders, never statutory clocks.

### What we are not

PMS, trust accountant, solicitor, Tapi, Hermes, OpenMausBot, OpenManus, Obsidian, a second brain, a tenant call-centre, a bot roster.

Do not ship under the names **PropertyMe**, **Hermes**, **OpenMausBot**, or **OpenManus**. Product name is **RealBud**. Data dir `~/.realbud`. App id `com.realbud.app`.

---

## 2. Who talks to it

**The PM is the only user.**

```
PM  ── Desk or Ask or pilot Pocket ──▶  RealBud.app
                                              │
                                              │  same property worker
                                              ▼
                                         Hermes `property` (headless)
                                              │
                         only if the PM asked, and after Allow
                                              ▼
                              tenant / owner / tradie / PMS click
```

Messaging is how the **PM** uses the same Ask thread from a pocket. It is not a fifth surface, a second worker, or how tenants talk to an agent. Auto-texting a tenant is send and remains forbidden.

Pocket is a RealBud-owned adapter hub, never the worker's general messaging gateway. Telegram long polling and WhatsApp **Business Cloud API** are the two source-built transports; both may project the same named PM into canonical Ask without creating another session or worker. Telegram is outbound-only. WhatsApp uses a loopback-only signed Meta webhook behind an agency-approved HTTPS tunnel, a dedicated business number and the exact PM number; personal-phone QR/Baileys automation is forbidden. Mobile **Allow once** or **Not now** calls the same server-owned decision as the desktop card. Channel credentials are encrypted; bounded delivery ledgers keep only ids/digests, states and times. Claims persist before work, cross-channel Ask turns and decisions serialize through one bounded queue, configuration generations cancel queued old-channel work, interrupted requests are not replayed, and uncertain replies stay `effect-unknown`. WhatsApp handshake truth is bound to the saved number/signing configuration so stale verification cannot make changed credentials look connected. No group chat, tenant channel, raw terminal, model/update command or credential-in-chat path exists. Both connectors remain network-off until `docs/PILOT-CONTRACT.md` names a real agency and PM. `cron_mode: deny` stays.

---

## 3. Topology (locked)

```
                 PM (only user)
          Desk app       pilot-gated Pocket
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

Worker identity stays in `pack/property/SOUL.md` → RealBud's dedicated worker home at `~/.realbud/worker/profiles/property/`; the pinned executable stays under `~/.realbud/worker/runtime/` and is addressed by absolute path. Do not import or reuse a personal executable or `~/.hermes` profile, put a second SOUL in the vault, or use Hermes `memories/`. Two brains is the failure mode.

### Local-first execution routing (locked ownership; adapters staged)

Cloud is an optional accelerator, never a functionality or onboarding gate. RealBud chooses a typed route before work starts:

```text
structured export/API → one deterministic portfolio batch
typed DOM recipe      → one scripted loop for the same PMS account
selected documents    → bounded stateless analysis contexts
independent accounts  → at most two RealBud-owned isolated browsers
visible desktop/CUA   → one serial shared-computer lease
```

One PM and one visible Bud remain. An ephemeral analysis context is not another RealBud agent: it has no name, thread, channel, schedule, memory or authority. It may use only a supported interface of RealBud's pinned external worker runtime. RealBud never vendors, patches or forks Hermes to create a lane; if the pin cannot supply the supported seam, that lane stays unavailable.

Browser lanes use separate RealBud-owned Chromium processes/profiles and never inspect or share the PM's personal browser, tabs, cookies or credentials. The same PMS account serializes under one opaque concurrency key even in accelerated mode. A second local browser lane requires an independent account/workload, an available private-browser adapter and a CPU/memory check. CUA that drives the visible screen is always one-at-a-time.

The PM may save one non-authoritative route preference in You → General: **Automatic** (recommended), **Steady on this Mac**, **Faster on this Mac**, or **Cloud when connected**. The canonical first launch remains name → rules → Desk, so this choice never blocks onboarding; Automatic is the safe default until the PM chooses. The preference is a planner hint only: readiness, resource gates, same-account serialization, fallback and exact Allow remain code-owned. It cannot install or connect a route. A stale window cannot overwrite a newer saved choice. Upstream Hermes may offer “real profile” browsing, but RealBud does not enable it: copying a personal browser's cookies/logins conflicts with the separate RealBud-owned browser boundary above.

Every newly admitted executable item also has an immutable `realbud.work-plan.v1`. It binds the exact input digests, data classes, account-serialization digest, recipe, origins, route chain, adapter version/configuration/freshness receipt and the authority that allowed the work. A direct PM request or named scheduled occurrence may authorize only bounded local read/classify/draft work. Possible external work and any cloud data transfer or spend require the exact one-time Allow decision. A local plan can never add cloud as an undisclosed fallback. Read-only cloud work may move only forward to a local route disclosed in the same plan, with a new fence; possible-effect work never changes route after its boundary. Configured credentials or a planner preference never count as adapter readiness.

The shipped `realbud.work-routing.v1` projection reports the current mode, one-batch portfolio count, selected concurrency, fallback reason and whether timing is measured. Before launch it falls back to Local standard without dropping work when the requested accelerator is unavailable. It never invents a duration; timing appears only after route-specific measured runs. The durable receipt broker now owns the real structured PMS-import path as well as the offline topology simulator: every new receipt carries the work-plan/authority binding, while legacy v1 receipts remain recovery-readable. A digest-bound source marker lands in the same encrypted Desk commit, so restart can finish broker reconciliation without duplicating evidence or drafts. The fake-bank proofs cover both a deterministic read-only scripted-browser receipt and the intended local topology: a disposable RealBud-owned browser profile performs fixture login/credit reading while pinned CUA validates that exact browser PID and DevTools endpoint under an exact-origin policy. Native policy tests deny generic desktop capture, ambient window enumeration and off-origin navigation; transfer/payee paths remain unavailable and only digest-bound typed observations reach Desk. This is fixture/source proof, not a named-bank connection, bundled private Chromium pool, packaged recipe bridge, installed permission result, live account or cloud-adapter claim. The fake-portal broker now admits the same typed fixture recipe through a digest-only, exact-Allow-bound durable receipt, binds its exact loopback origin and marks the possible-effect boundary immediately before prefill; cancellation, expiry, fencing, bounded retry and ambiguous no-replay behavior are covered while Submit remains absent from the runner. Full decision, lifecycle and rollout: `docs/adr/0001-realbud-owned-work-routing.md`.

---

## 4. Window (locked)

Four places. Nothing else on first paint.

| Nav | Job |
|---|---|
| **Desk** | The work. Drafts, escalations, holds, property cards, Notes. Allow / Deny / Copy. |
| **Ask** | One thread with the one worker (canonical id `bud`). “What’s waiting?”, “draft Friday for Oak”, “pipe burst.” Same Hermes ACP. |
| **Schedule** | Named loops on RealBud’s clock. Not Hermes cron. Not a prompt runner. |
| **You** | Name, Hands (pin + pack + test), reminders and the pilot-gated Pocket connections. |

Ask is not a second inbox. If Ask drafts a courtesy or a job, it becomes a **Desk** card. Approve once.

Ask is the PM's **universal command surface**, not merely a Q&A box or a menu of six phrases. Bud should accept any safe property-management outcome, understand the whole job, and reduce it to the smallest useful evidence check, answer, Desk change, routine change, bounded handoff or exact setup step. The closed capability catalog constrains **execution**, not comprehension. Bud never gains ambient shell, browser, credential or channel authority; a safe outcome with no current adapter is named honestly and the supported parts are still prepared.

**Out of the default window:** Workshop, New assistant, New room, groups, Plugins, Computer playground, Chief of Staff, model shop, ⌘1–9 bot hopping, leftover Koda. Product mode already denies many of those routes — keep it that way. CUA is a **skill on a loop**, not a pane.

Onboarding: name → three rules → focused setup. While setup is pending it owns the window; the four-place operational shell is not mounted behind it. A restrained three-segment progress line exposes only the current PM decision in order: **Prepare Bud → connect a model securely → bring in the portfolio**. A visible **Use the practice desk first** action keeps Desk usable and makes setup reversible from You. One deliberate Prepare Bud action owns the private install/update and applies or repairs the code-owned safety pack automatically; before staging, both the API preflight and the installer boundary require 3.0 GB free, and low or unverifiable capacity stops with one plain retry message while changing no runtime slot. Repair internals remain in You, never in the first-run error state. The secure provider/model/key form is the only credential pause, and Save & test performs the live hands check. Portfolio intake then returns to Ask's ranked PMS export / selected files and images / paste / named read-only connection routes. The current screen is derived from server-owned worker, book and recovery truth, so an interrupted first run resumes without repeating a completed action. Recovery replaces setup progress with one protected-state owner and the exact book-key repair when needed; it never opens the agency, routing, connection or pilot dashboard underneath. Local preference stores only whether to reopen the guide; it never marks Bud, a model or a book ready. Agency details, private computer use, recovery-key reveal, desktop reminders and pilot connections stay out of first run and remain in You. Merely viewing the guide never installs, connects or requests an OS permission. No engine list, mic setup, connection catalog or WhatsApp setup enters the focused journey.

---

## 5. Workflows (the only ones)

**Routine — clock.** Schedule (e.g. 7:30 morning arrears) → a code-owned source adapter supplies facts → Desk evaluate (shop rules, not law) → cards → PM Allow/Deny → Copy, or one trained PMS/portal click after Allow. The built morning clock re-evaluates the latest structured PMS export already admitted to Desk without spending a model call; freshness/conflict projection holds it when it is no longer safe, and it never scans for a newer file. Lid shut: catch-up on open. Nothing sends while nobody is looking.

**Routine — PM asks.** Ask or later phone → worker uses book + desk facts → answer, or a Desk card if something must leave the building.

**Reach someone else.** Only because the PM asked, and only after Allow. Never auto. Never statutory. Never trust.

**Here and there.** “Pipe burst at Oak” → classify, escalate card, spend-cap / after-hours from property options + note. Do not call the plumber. Do not pay.

**Operate their PMS.** Read API where it exists; CSV/export until then; trained computer use only for the click the API will not give (create job, comment, courtesy reminder). Train once → recipe → named loop. Bounded tools only (`navigate`, `read`, `fill`, `click_semantic`). From Ask, Bud may prepare an exact approved handoff card; Allow consumes its one-use case authorization and the adapter may prefill. Submit stays human. Fake portal already proves this; live portal waits on `docs/PILOT-CONTRACT.md`.

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
- Calendar: Monday-first month projection of the built typed routines. Select an occurrence or legend item to focus that routine's authoritative controls. A date cell is not a prompt, exception rule or new schedule shape.
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
| Worker | Hermes Agent **v0.20.3** (`v2026.8.16.2`, commit in `server/hermes-pin.ts`). Profile `property`. Pin and bump when **we** choose. Do not track `main`. |
| Models | `hermes -p property model`. Not RealBud agents. |
| Computer use | Bundled Cua 0.19.3. Idle setup host admits only permission checks; each work host requires a version-2 exact-origin policy, isolated profile, exact typed browser tools and bounded lifetime. Generic desktop/input, clipboard, files and ambient window enumeration are excluded. Bud never receives the raw driver surface. macOS is the first live host; Linux/Windows remain CSV + fixture only until the contract says otherwise. |
| OpenMausBot upstream | Harness/safety only (PATH, ports, redact, stall watchdog, proxy paths, permission broker). Not iOS, extra engines, teams, plugins, model shop. |
| Install | RealBud.app + pinned Hermes + `pack/property`. Home screen says RealBud. Hands in You/Settings. |

Forking Hermes Desktop is rejected. Overlaying Hermes.app is rejected.

---

## 8. Where the software actually is (2026-08-28)

Shipped, not slides:

- Appliance chrome: Desk / Ask / Schedule / You
- First-run path: PM name → the three permanent safety rules → Desk; the framing now makes the operating split explicit: Bud performs admitted-source checks, scheduled routines, classification and draft preparation without waiting, while only the exact consequential card waits for the PM. Completion is a local UI preference and never an authority grant
- Progressive live-readiness checklist on Desk and You: Bud may stage a property book from selected spreadsheets, PDFs, documents, screenshots or photos, while a matched current PMS export remains the authoritative live-balance gate; exact pinned worker/model/hands-test fingerprint and optional agency name stay separate. The checklist cannot send, pay, approve or change clocks
- CSV drop anywhere on Desk is type/size bounded and opens a no-change import review before any ledger mutation; Book → Import remains available. The review shows only detected column names and aggregate matched/held/conflict/missing counts, never tenant, property, amount, source-row or local-path content. Explicit **Import** is bound to the reviewed Desk revision, observation time and exact selected bytes; a changed export or Desk revision must be reviewed again
- Product mode: one Bud thread; denied bot/group/plugin/cloud-computer routes
- Desk book: add/edit/remove properties, options, locked `never`
- Morning evaluate + Allow/Deny/Edit/Copy; send 403
- CSV import matching by **address or property code** (`parsePmsExport`; identity-column aliases), freshness / unmatched / partial / reversed holds; ambiguous rows become row-level holds (batch-reject stays schema-only; zero-match imports never fake live). Before commit, the read-only preview runs the same parser and resolver against the authoritative Desk revision and exposes detected mappings plus aggregate impact; explicit Import supplies the same observation time and a digest of the reviewed bytes. Every accepted live import records portfolio coverage for every active property: missing rows and duplicate/conflicting mappings hold, and last-row-wins is forbidden. The HTTP import is admitted through the durable structured-batch broker and uses an encrypted digest-bound Desk source as its exactly-once reconciliation marker.
- **Current-evidence decision gate:** live money evaluation consumes the V3 `MoneyPosition`, not the compatibility ledger. Only fresh PMS-authoritative evidence can create wording; Hermes- or browser-produced balance rows remain `legacy-unverified`. A newer paid/missing/conflicting/stale PMS snapshot supersedes pending wording, while a later exact read-only credit observation that says paid when the PMS says unpaid can only veto wording and create a discrepancy hold. It never promotes evidence to PMS authority. Allow revalidates the exact evidence, classification, rent period and recipient before recording a decision.
- **Read-only bank observation foundation:** the typed adapter accepts only one account fingerprint plus bounded credit records (transaction digest, booked time, positive amount and reference); credential-shaped/unknown fields, negative amounts, duplicate ids and stale windows fail before admission. Matching is deterministic and uses only an exact configured property code plus the configured weekly or fortnightly amount. Raw references are used in memory then discarded; unmatched, ambiguous, amount-mismatched and multi-credit records become redacted Desk holds. Transaction ids deduplicate retries, same-account work serializes in one scripted-browser lane, and the bank may never transfer, add payees, pay, allocate trust money or perform reconciliation. The hybrid fixture proves a disposable browser process/profile, exact CUA PID/endpoint validation, native ambient-window refusal and typed Desk reconciliation. PM login/MFA, a named-bank read-only account, the packaged recipe bridge and installed permission evidence remain pilot gates.
- **Source-safe inbox interrupt foundation:** a labelled Demo inbox now passes a bounded envelope through deterministic classification, exact property matching and digest-only message/thread identities. One encrypted Desk case absorbs a same-thread burst; immutable mail Evidence stores no raw body, provider id, attachment name or attachment bytes. Maintenance, tradie, owner, payment and BDM categories may prepare operational reply wording, while statutory language, untrusted secret/instruction content, ambiguous properties and do-not-contact safeguards hold without a draft. Exact Allow still does not send. The PM separately records that they sent outside RealBud, which moves the case to Waiting with an explicitly non-legal shop follow-up, then closes it when resolved. Replay, stale revision, restart and live-book refusal are tested. This is a fixed fixture path, not inbox OAuth, polling, attachment processing or live mail truth; see `docs/adr/0002-bounded-inbound-interrupt-pipeline.md`.
- **Review memory without learned authority:** Desk derives a read-only review aid from existing immutable ProposalRevisions plus explicit Allow Decisions. For a pending card it compares only the same property and draft kind, names whether current PMS evidence, recipient, channel and a conservatively masked wording pattern are familiar or changed, and may collapse exact wording and prior context only for a clean repeated pattern. The familiar view names unchanged fields, compresses four clear safeguard rows into one checked result, keeps the source and why-this-is-here explanation visible, and places “this exact version; nothing is sent” beside Allow. Any active safeguard is expanded. Denials, another property/kind, a current edit, stale/missing evidence and levy/trust-boundary work cannot produce the shortened state. There is no new memory store or model call; every card still needs its exact revision-bound Allow, and the aid can never approve, send, pay, change evidence or teach law.
- **Notes on the property card; vault seeded as Hermes cwd; Allow appends to the note + decisions log; evaluate never reads the vault (regression-tested)**
- **Ask → Desk: "Put on Desk" creates a pending draft that needs the one Allow**
- **Ask portfolio controls:** courtesy targeting uses a keyboard-safe searchable property picker (address, tenant or property id) rather than a native select, so the same flow works beyond 20 properties. Common-file intake is the primary path; deterministic one-property-per-line quick paste remains available without a model. Both deterministic and worker-produced property rows are field-bounded before proposal or encrypted-book mutation; malformed escaped rows stay in “needs attention” and a mixed batch cannot smuggle oversized text into the book. A successful quick paste names staged/skipped rows and offers one explicit **Review on Desk** route; it never auto-applies or auto-navigates.
- **Ranked property intake:** Ask asks where the portfolio lives and exposes four real routes without adding a surface: current PMS export, selected files/images, paste/manual entry and a named read-only connection. Desk Book makes the verified PMS CSV refresh prominent and routes other formats to Ask. Selected evidence and pasted rows create Desk proposals only; the matched current structured PMS export remains the sole active live-money authority. Direct PMS API and private PMS browser routes remain pilot-gated. Every working button routes to an existing owner; no cosmetic Connect or universal-format claim is allowed.
- **Ask selected-evidence bridge:** the PM can choose or drop up to 10 selected spreadsheets, PDFs, documents, screenshots, photos or other regular files; the server re-resolves them, enforces 50 MB per file and 100 MB per turn, then copies only those selections into a mode-0700 short-lived RealBud workspace as mode-0600 files. A RealBud-owned serial analysis adapter admits the review through the durable broker and runs the pinned worker from a fresh per-task profile containing only the verified property pack and reconstructed non-secret model fields; sessions, memory, channels, schedules, browser state and credential files do not cross. The selected credential is decrypted from RealBud's long-lived encrypted store only into that child process. All tool permissions are denied, time/output are bounded and only exact `realbud.selected-file-analysis.v1` JSON is accepted; raw JSON, provider sessions, errors and tool events never enter Ask. The authenticated result is encrypted before broker completion, replayable after a crash and reconciled only after the Desk proposal lands, then the artifact and workspace are removed before Bud becomes idle. The PM's originals are never changed, a typed path is never file authority and the book still changes only through Allow. Bud never scans the device. OS-enforced CPU/memory/network isolation, a measured optional second lane and the 100-property document benchmark remain R2 work.
- **Ask setup handoff:** if Bud's private setup, model or live check is missing, Ask names the one missing step and takes the PM to You, which immediately opens the same focused setup journey. A missing model opens the secure form in that journey; a missing private runtime still waits for the PM's explicit Prepare Bud click. That one action resumes or installs the pinned runtime, applies/repairs the property pack and advances to model setup without exposing separate install/pack/test chores. Quick paste and Desk proposals remain available, the unfinished Ask draft is preserved, and the PM may return to Ask or the practice Desk at any time; setup never becomes a fifth place or an authority grant. The latest bounded action requests and settled receipts remain reviewable in Ask while new model-dependent chat is paused, so View conversation never hides a pending Allow behind setup.
- **Ask/Bud identity and Pocket setup handoff:** the four-place navigation keeps the action label **Ask**, while the thread heading says **Ask Bud** and the composer says exactly who receives the message. An explicit PM request to connect WhatsApp Business, Telegram or Pocket is resolved by a narrow code-owned shortcut into the same pending `open-setup` card, so it still works when a model provider is unavailable. Opening that card only navigates to You → Connections; it never saves a credential, enables a transport or claims success. Credential-shaped Ask sends and edits are rejected before transcript persistence or worker dispatch and direct the PM to the write-only fields in You.
- **Four-place continuity:** a genuinely new RealBud window remains Desk-first. An in-window refresh or local harness bounce preserves whether the PM was on Desk, Ask, Schedule or You through session-only storage; invalid or unavailable storage fails back to Desk and no longer-term navigation history is retained.
- **PM profile boundary:** first-run and You save only the trimmed PM name plus optional normalized office email through one narrow, session-gated endpoint. Unknown fields, invalid email, missing session and cross-origin calls fail closed; errors remain visible in place and a successful edit survives reload. General provider, Pocket and credential settings remain on their separate validated owners.
- **Ask reply recovery:** a successful send immediately folds the server's authoritative user-message/working projection into the window. If the local server restarts, the event stream refreshes its rotated session token with bounded retry and rehydrates the transcript. If the pinned ACP worker reports an empty missing-session load, RealBud opens a fresh session and replays only the bounded active transcript; any remaining non-success stop produces a visible retriable error instead of silently swallowing the PM's message.
- **Ask durable request lifecycle:** every accepted turn persists `admitted → dispatching → settled/held` before the corresponding transition is presented. On restart, one text-only leaf may resume exactly once; selected-file work is held for explicit reselection and partial/possibly-effectful activity is never replayed. The transcript shows saved, working, completed or the exact hold instead of fabricating a response.
- **Local-state and model recovery:** config, encrypted settings, routine clocks and transcripts distinguish missing state from corrupt or incompatible bytes. A verified previous generation is restored; otherwise the original is preserved, mutations and worker actions pause, You opens the exact local recovery owner and Schedule disables every mutation. Public config plus encrypted settings commit through a ciphertext-only journal; legacy plaintext credentials are encrypted and verified before both public config generations are scrubbed. A candidate model is not selected until its live ping succeeds; failure or restart restores the exact prior model and encrypted credential.
- **Ask response presentation:** assistant prose is a readable Warm Ledger document block with restrained Markdown hierarchy and a visible source/time footer. Provider tool identifiers are translated through a closed PM-language activity map; unknown tools degrade to a generic no-change check, and only RealBud-owned state may claim that a connection or action succeeded. A code-derived Suggested next row surfaces up to three current recovery/routine/hold/draft/live-book actions and can only navigate to Desk/Schedule/You or start an ordinary Ask turn.
- **Ask as the universal conversational control plane:** Bud reasons over any safe PM outcome while RealBud supplies a small authoritative capability snapshot for the current turn: what is ready, practice-only, setup-required, pilot-gated or unavailable. Bud may emit exactly one `realbud.propose-action.v1` envelope for a supported operation: run or retune a named routine, add one property, change bounded property shop options, rename the agency, open a human-owned setup section, or prepare one already-approved case-bound portal handoff. RealBud strictly decodes it, resolves canonical ids/revisions/one-use authorization and persists a server-authored diff card in Ask that is also visible on Desk. Nothing applies until the PM presses Allow. Owner commands revalidate the current target, deduplicate retries, reject competing edits as stale, and update Desk/Schedule/You through their existing state owners. A handoff is training-only while the pilot contract is Demo; its adapter may prefill but cannot Submit. Interrupted or ambiguously acknowledged preparation is durably `effect-unknown` and is never replayed. Unknown fields, arbitrary shell/browser tools, send/pay/notice requests and user-authored routines remain unreachable from this protocol.
- **One-time approval experience:** every pending action card states why Bud is asking, the exact one-time permission, where the work must stop, the visible diff, request freshness and any admitted route before the Allow button. While running it names the allowed step; success shows a completion receipt, denial says nothing ran, and stale/unknown outcomes say Bud stopped safely with a recovery instruction. Prior explicit Allows may shorten a future exact-match review, but no card or setting offers Always approve, automatic approval or inherited authority. Pocket uses the same meanings and authoritative owner.
- **Memory + reminders:** property Notes remain Bud's only durable memory and are named as such in Ask; chat never becomes a hidden second store. The optional Desktop reminders connection in You emits one generic, privacy-safe OS alert only for an unseen failed/missed/interrupted routine or a completed routine with linked held work. The banner contains no property, tenant, balance or model text, opens the authoritative Desk/Schedule surface, and persists an idempotent `notifiedAt` receipt. It does not message tenants, owners or tradies.
- **Computer History boundary:** the pinned stable CUA Driver 0.19.3 has no admitted history tools, so History is not a release blocker and no preview runtime is installed. The code-owned adapter admission/status foundation is built and truthfully reports the stable runtime unavailable. A later stable-pin implementation may read only opt-in encrypted metadata for the exact RealBud CUA session/case/time window to reconstruct an interrupted handoff. It is untrusted evidence, never Notes, `evaluateProperty` input, ambient PM surveillance, automatic replay or action authority; paused, dropped, stale or corrupt intervals remain unknown. Detailed trajectory capture is explicit vendor-test/QA evidence only.
- **Pocket adapter hub (source-built, live enrollment pilot-gated):** You contains independent Telegram and official WhatsApp Business Cloud connection cards that may both project the exact named PM into the same Ask thread. Telegram uses outbound-only long polling; WhatsApp uses a loopback-only signed Meta webhook behind an agency-approved HTTPS tunnel and stays at **Finish setup** until Meta performs the Verify Token handshake. Every credential is write-only/encrypted, identities and business-number routing are exact, request bodies and queues are bounded, cross-channel turns plus manual decisions serialize, and provider messages are durably claimed before work or acknowledgement. Reconfiguration invalidates queued old-channel work and stale webhook verification. Native **Allow once** / **Not now** buttons call the identical revision-checked Desk/Schedule/You action owner; the request carries Why / Permission / Stops at and the result returns an explicit completion or nothing-ran receipt. Restarts never silently replay a request, delivery ambiguity is visible, and groups/other identities/attachments/credentials plus general engine commands are rejected. In Demo, each locked channel now has a keyboard/screen-reader-visible **View requirements** disclosure with its real named-PM, privacy and infrastructure prerequisites; it exposes no credential field or cosmetic Connect action and does not contact a provider. The checked-in Demo contract keeps both adapters network-off until a real agency and named PM are recorded.
- **Bulk book intake: Allow all is revision-bound, validates the complete visible proposal set, and adds it with one encrypted Desk commit; pre-replace failures restore the book, proposals and new Notes/audit files, while a fully landed replace with uncertain final durability stays visible and pauses further writes until restart**
- **Local-first route planner:** You projects the current portfolio as one local structured batch and keeps cloud optional. You → General also stores one closed plain-language route preference through a narrow session-gated owner; Automatic remains the non-blocking default and a preference never grants readiness. The versioned server-owned plan enforces one same-account browser lane, at most two independent isolated browser lanes after a resource check and one visible CUA lane; unavailable acceleration falls back before launch and timing remains unavailable until measured. The projection contains no credentials, account keys, personal paths, raw tools or execution grant. This is routing-contract/source proof, not a live parallel worker, browser-pool or cloud claim.
- **Transactional V3 authority:** every ordinary Desk save now builds and strictly validates one V3 candidate from the last committed authority, applies retention, encrypts it and uses a classified atomic replace. A proven pre-replace failure restores the exact committed working state and is safe to retry; a landed-but-not-confirmed outcome keeps the exact candidate visible and makes Desk, schedules and browser work read-only until restart. The temporary V2-shaped reducer remains an implementation bridge, not a second durable authority.
- **Support evidence boundary:** Advanced diagnostics shows the exact app version, optional build id, source/packaged runtime label and separate source/installed/named-office evidence states. Its downloadable support report is deliberately lossy: categorical health, recovery states and aggregate counts only. It cannot contain a person, address, property, Note, message, prompt, source body, account identifier, credential or host path, and it cannot prove a verifier run, successful install, notarization or live office workflow.
- **Private local state:** the server owns one PID-checked data-directory lock, recovers only a provably stale lock and refuses a concurrent writer. Packaged Electron wraps the Desk and secret-store keys with OS credential storage; provider/integration and worker credentials live only in encrypted stores, are injected into the one spawned process that needs them and are scrubbed from the packaged server's ambient environment. Production refuses to create plaintext fallback keys. A direct source-server launch also refuses any data directory containing the desktop's OS-protected key record before it can generate development keys or quarantine a valid encrypted Desk; source QA must use an isolated `REALBUD_DATA_DIR`.
- **Retention and installed QA:** retention runs on open and commit, protects Evidence referenced by open Cases/Decisions/Handoffs and bounds encrypted backups. The isolated installed-app smoke covers two launches with encrypted-key/model persistence, private Bud-vs-personal-Hermes/CUA sentinels and clean server/lock shutdown. A fresh 2026-08-27 arm64 directory build after the computer-use onboarding changes is locally Developer-ID signed; package verification passed its resources, exact pinned CUA version/architecture, hardened signature and entitlements, its bundled runtime returned a real frame, and the two-launch smoke stayed green. It was built from the dirty shared working tree with an explicitly smoke-only mock Keychain, was not notarized or installed outside the repo, and is not an immutable release candidate, a real-Keychain/TCC first launch, a paid-model test or permission to distribute.
- **Private computer-use runtime:** macOS packaging carries the exact pinned CUA Driver 0.19.3 executable and matching native SDK inside `RealBud.app`. Installed RealBud resolves only that resource: `CUA_DRIVER_PATH`, `/Applications/CuaDriver.app` and personal CUA permissions are ignored. The You → Computer use row shows Included/Ready/permission/repair state; the first explicit setup starts a short-lived policy that admits only `check_permissions`. An admitted work item must replace it with a private version-2 policy bound to exact origins, one isolated profile, seven typed browser tools, work/recipe ids and expiry/idle limits. The packaged server accepts only the exact bundled executable plus a private, regular, byte/digest-verified policy descriptor from the RealBud-owned embedded host; symlinks, redirected binaries, public files, generic desktop tools, ambient window enumeration and raw MCP access are rejected. The descriptor is revoked before host stop/replacement so teardown failure cannot leave a stale grant trusted. Package verification checks the executable version, architecture and enclosing signature. The source boundary and native fixture proof are complete; the packaged recipe-to-Electron start bridge, installed TCC exercise and named vendor adapter remain open and cannot be inferred from setup status.
- **Computer-use permission onboarding:** the same You row expands into one flat three-step checklist: RealBud's private runtime, Accessibility, and Screen & System Audio Recording. It opens only those fixed macOS Privacy & Security panes, identifies RealBud as the grant owner, says that App Management and separate personal automation helpers are not part of setup, and offers a bounded Check again path after the PM changes a grant. Duplicate setup requests serialize at the Electron owner. Denial, missing permission or native-start failure leaves Desk/Ask/Schedule available, and a green setup check still grants no case, origin, browser workflow, background action or Submit authority.
- Hermes pin, pack, fail-closed Recheck (spawn now also requires `approvals.mode: manual`). RealBud is the control plane around Bud rather than a transparent Hermes skin: every desktop/Pocket request enters the same identity, closed capability, persistence, receipt and manual-approval owners before the worker receives a bounded turn. The PM-facing Prepare Bud owner sequences the existing private install/update and idempotent pack repair, resumes safely after a partial setup and stops at the secure model form; it never silently downloads on app open. Install/update runs with a private RealBud `HOME`, Node, Python and install tree; the bootstrap script and checkout must both match the immutable pinned commit. A read-only storage probe requires 3.0 GB free before the API admits preparation and is repeated immediately before staging, closing both ordinary low-space failure and the preflight-to-spawn race without changing the active worker. All probes, Desk hands and Ask turns use the absolute RealBud-owned launcher and ignore a PATH/personal install. The installer blocks host package-manager and personal-SSH use, and skips Hermes' generic browser/CUA bootstrap because RealBud's bounded, case-scoped CUA driver is the only computer-use authority. One exclusive server lease covers Ask/Pocket, live and scheduled Desk hands, diagnostics, model/pack changes and update preflight; a conflict starts no second process and makes no partial conversational write. Updates are transactional: build in the inactive stable A/B slot, verify the exact pin, atomically switch RealBud's active link, retain one previous runtime and roll back if the active-path probe fails. Boot recovery restores only an unambiguously previous runtime or isolates an unverified first install; it never auto-upgrades, trusts partial state, resets the profile or touches personal Hermes.
- The worker model sheet uses a shared, card-based catalog for ten pinned BYOK adapters (Anthropic, OpenAI, Google, xAI, OpenRouter, DeepSeek, Kimi, Z.AI, MiniMax and Ollama Cloud). Provider and model cards are native keyboard radio groups; selecting a provider shows RealBud's short compatible choices plus bounded worker-cache discoveries, with an explicit custom-ID fallback. Keys remain write-only and provider/model changes require a live hands test
- Bud's durable SOUL and per-turn prompt make it a personalised Australian PM operations specialist with fact/inference/missing-evidence discipline. It is law-aware for risk spotting only: no legal advice, statutory drafting, model-memory law or invented clocks; formal matters escalate to the licensed person.
- Gate hardening: product mode denies `autoApprove`/`alwaysAllow`/`chiefOfStaff` on bot PATCH, Bud rename and Bud delete; auto-answer of permissions is off in product mode
- Named routines with an editable clock (revision-bound PATCH time/weekdays/enabled, no backfill), unambiguous weekday controls, visible saved/run/pause confirmations and an accessible Monday-first month preview that navigates to those same controls. Stale editors receive a conflict and reload the authoritative clock.
- **Routine execution receipts:** each scheduled occurrence has one durable code-owned key, so a completed/interrupted run cannot replay when a crash leaves the clock bookmark behind. Manual request ids are bound to one routine, overlapping occurrences become visible missed runs, and every new run persists bounded preflight/source/evaluation/Desk phase receipts with secret redaction. Schedule shows each routine's real source dependencies and expands those receipts into PM-language recovery; the clock still cannot launch CUA, send, pay or Submit.
- **Governed capability and control hub:** You has one compact General / Worker / Connections / Recovery in-page navigator plus bounded search and category filters over exactly seven approved capability rows. The seventh is a collapsed, read-only **Advanced work methods** status row for the code-owned adapter foundations; it cannot install, configure or execute anything. General retains Agency/Profile and contains the nested General / Usage & costs / Updates control centre: authoritative book timezone, **Manual Allow · locked**, case-scoped local work, a private rolling seven-day model meter that stores no content and never invents spend, and distinct RealBud-app/Bud-runtime update owners. This borrows settings and discovery convenience without reopening automatic approval or the dormant generic connector marketplace: search cannot discover/install/grant a tool, status remains app-owned, empty results reset locally and every executable button routes to an existing RealBud owner. Structured PMS export is the only active live-money book source; selected evidence and paste/manual entry are active proposal-only intake methods. Direct read APIs, a private PMS browser recipe, a restricted one-account Composio session and an approved one-server MCP adapter remain pilot-gated until an exact named adapter supplies a fresh runtime receipt; there is no URL, credential, raw-tool, connect or execute field in that API/UI contract.
- **Honest commercial boundary:** Usage & costs distinguishes provider-billed BYOK use, currently unpriced local RealBud work and unconnected optional acceleration. The current build has no checkout, subscription or RealBud usage charge. Future pricing must be simple at signup and use PM-recognisable, receipt-backed work such as records checked or portal checks completed—not opaque model tokens—with an exact cap shown before any metered run. Prices wait for named-pilot willingness-to-pay and measured costs.
- **Friday owner letter v0** (`server/owner-letter.ts`): one factual catch-up per property per week from Desk facts + Notes; Copy-only; Run now or the Friday clock lands it on Desk
- Bounded fake-portal prefill now has a real accessible browser task as well as the HTTP state-machine double. A repeatable Agent Browser QA walk fills the exact approved wording across normal, reordered and delayed layouts, revokes Bud, proves both visible and server-side Submit refusal, then lets a separate PM session Submit exactly once. Runtime preparation enforces the exact credential-free origin including port, rejects redirects/mismatched recipe versions/invalid wording before I/O, times out each step and never probes Submit itself. This is simulator proof, not a live vendor/CUA claim; a runtime with no configured practice portal now fails visibly instead of fabricating `handoff-ready`.
- Pilot contract still **demo** (`agency: RealBud Demo Book`)

Not shipped:

- Arbitrary/user-authored routines, multi-step plans, generic tool calling, raw host CLI, or arbitrary computer control. Ask can launch only the exact post-Allow practice handoff above; the Agent Browser CLI is QA-only and is never given to Bud. The pinned CUA binary now has a native exact-origin bounded-session source boundary, but RealBud does not hand its raw MCP surface to Bud; production recipe dispatch and every live account remain vendor-test/pilot-gated
- Live inbound / emergency triage loop (the fixed Demo interrupt path is source-built; no mailbox clock or provider read exists)
- Named paying/pilot agency
- Live portal / PropertyMe OAuth
- Live named-PM Pocket enrollment and delivery proof, a stable agency-approved WhatsApp HTTPS tunnel, mobile file/photo/voice intake, proactive mobile alerts and offline background service (both text/approval adapters are source-built but the checked-in Demo contract keeps them network-off)
- Read-only mail/source adapter (You now shows the honest pilot-gated source card and the Demo contract exercises classification/cases, but there is still no inbox OAuth, connected account, provider read, calendar write or live mail truth)
- Pilot-gated distributable installer: the local QA package exists, but real-Keychain first launch, Apple notarization/stapling, macOS x64, signed Windows and a supported Windows worker story are not yet release-proven
- CUA Computer History runtime: the admission/status contract is built, but the official feature is still absent from the pinned stable Driver; activation requires a stable pin, PM opt-in and a named case-reconstruction need
- Local stateless analysis fan-out, the RealBud-owned Chromium pool and cloud acceleration. Their versioned route/receipt design and offline broker/crash simulation are source-built, but executable adapters, Desk reconciliation, measured timing and pilot/vendor evidence remain unshipped

---

## 9. Beta bar (real-estate integration)

Beta is **not** more architecture. Beta is one PM and a **real book**.

**Door (must) — done at HEAD:**

1. ✅ Import **their** arrears/export (identity-column mapper; schema failures reject while ambiguous rows hold for review).
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
10. `[source-built / live-gated]` Enrol the named PM on the dedicated Telegram Pocket adapter; add WhatsApp Business Cloud only when the pilot proves that transport is needed.
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

1. Fill the eight required fields in `docs/PILOT-CONTRACT.md` on a real visit (agency + PM, PMS brand, named exporter, export cadence, identity column, office OS, jurisdictions, vendor test account)  
2. After a named agency signs: installer a graduate can double-click, then vendor-test portal prep (bounded CUA, human Submit)  

Do not start a law shelf, a vault page, a second agent, arbitrary routine authoring, generic tool access, or live CUA until the pilot contract names a real agency and it asks for one.
