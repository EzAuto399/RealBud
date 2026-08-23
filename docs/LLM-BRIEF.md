# RealBud — LLM briefing

Date: 2026-08-23
Repo: EzAuto399/RealBud (local folder still /Users/yoda/projects/PropertyMe)
Canonical spec: **docs/GOAL-PROMPT.md wins on conflict** with this file. Related: docs/PRODUCT-BRIEF.md, docs/WORKFLOW-PLAN.md, docs/ROUTINES.md, docs/APPROACH.md, docs/IDENTITY.md, pack/property/SOUL.md

You are planning or reviewing RealBud. Do not invent a PMS, a Hermes fork, a bot roster, or a 50-hour unsupervised agent. If a change does not make the worker more PM and less general agent, it is out.

---

## 1. The idea

RealBud is a supervised unregistered assistant for Australian residential property managers. It sits on the agency's existing PMS (PropertyMe / Property Tree / Reapit PM — confirm on the visit; do not assume). It takes hours off the PM: routine loops plus the odd interrupt. A licensed person still sends notices and still moves trust money.

Wall line: The PM talks to RealBud. RealBud does the routine work. It only reaches someone else when asked — and never sends a notice or moves trust.

Sales line: "It works the system you already have — and the requests that never land in AiMe."
Not: "We replaced PropertyMe."

Legal metaphor that drives the UX: the product is an unregistered assistant. It may prepare, remind, draft, file, and escalate. It may not sign, pay, or bind the agency.

Who: newly licensed AU agent (or their first desk). First GTM is a licence-training provider. Later buyer is a principal / rent-roll owner. Not DIY landlords, not US multifamily, not a trust-accounting company.

Why this exists: PropertyMe AiMe, Property Tree Alex, Tapi, Claire/Propic already ate "check rent and send a reminder." Native AiMe will feel smoother inside PropertyMe. We win by working any PMS, across the book + mail + one trained click, for shops that have no AiMe. The week that destroys a PM is interrupts, not the happy-path automations the PMS already sells.

The product is per-property options, not a PMS brand: rent source, due rule, grace, levy taken from rent, late path, notify channel, tradie/spend cap, owner-update cadence, locked never rules. Those differ by building, lease, and state.

Do not ship under the names PropertyMe, Hermes, OpenMausBot, or OpenManus. Product name is RealBud. Data dir ~/.realbud. App id com.realbud.app.

## 2. Topology (locked)

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
           cwd = ~/.realbud/vault   (shipped)
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
| `~/.realbud/vault` | Narrative: properties/<id>.md | Preferences only |

Hard rule: evaluateProperty never reads the vault. Notes colour a draft. They do not change draft / escalate / clear / skip / hold. Regression-tested in server/desk.test.ts ("Just send the Form 11 today" note changes nothing).

Worker identity stays in pack/property/SOUL.md → ~/.hermes/profiles/property/. Do not put a second SOUL in the vault. Ignore Hermes memories/. Two brains is the failure mode.

Hermes is hands, headless. Never launch Hermes.app. Never edit Hermes source. Models attach on `hermes -p property`. Claude/Codex/Grok are not RealBud agents. OpenMausBot upstream: harness/safety only (PATH, ports, redact, stall watchdog, proxy paths, permission broker) — not iOS, extra engines, teams, plugins, or their model shop.

## 3. Window (locked)

Four places. Nothing else on first paint: Desk (work; Allow/Deny/Copy), Ask (one thread, canonical id `bud`; anything that must leave becomes a Desk card), Schedule (named loops on RealBud's clock — not Hermes cron, not a prompt runner), You (name, Hands pin+pack+test, later Pocket).

Out of the default window: Workshop, New assistant, New room, groups, Plugins, Computer playground, Chief of Staff, model shop, leftover Koda. CUA is a skill on a loop, not a pane. Onboarding: name → three rules → Desk.

The PM is the only user. Tenants never talk to a bot. Auto-texting a tenant is send.

## 4. Workflows (the only ones)

Routine — clock. Schedule → Hermes or CSV supplies ledger facts → Desk evaluate (shop rules, not law) → cards → PM Allow/Deny → Copy, or one trained PMS/portal click after Allow. Nothing sends while nobody is looking.
Routine — PM asks. Ask or later phone → worker uses book + desk facts → answer, or a Desk card if something must leave the building.
Reach someone else. Only because the PM asked, and only after Allow. Never auto. Never statutory. Never trust.
Here and there. "Pipe burst at Oak" → classify, escalate card, spend-cap / after-hours from property options + note. Do not call the plumber. Do not pay.
Operate their PMS. Read API where it exists; CSV/export until then; trained computer use only for the click the API will not give. Bud may prefill. Submit stays human.

A routine is a typed loop, not a prompt: kind (morning-money, owner-letter, inbound-triage) + when + which properties + enabled. Adding a routine means picking an existing kind — not inventing a new agent.

| Loop | Status |
|---|---|
| Morning arrears / money | Built (fixture + CSV + Hermes fail-closed) |
| Friday owner letter | Built (v0: Desk facts + Notes, Copy-only) |
| Inbound / emergency triage | Declared |

Same worker. Different option sets on the property card. Not a roster. Ask does not PATCH the clock; it proposes a Schedule change as a card → Allow applies it (PR C, deferred).

## 5. Hard gates (never "be helpful")

• No trust EFT, disbursement, recon, or "pay the levy from the receipt."
• No draft or send of Form 11/12, NSW termination, VIC NTV, rent-increase, entry notices.
• Day counts on Desk are shop reminder rules, not state law. One early day voids insurance. Do not invent a legal clock.
• POST /api/desk/drafts/:id/send stays 403. Courtesy disclaimer cannot be stripped.
• No Always-allow — denied at the API since 2026-08-23 (bot PATCH rejects autoApprove/alwaysAllow/chiefOfStaff; Bud cannot be renamed or deleted; product mode never auto-answers a permission).
• No Always-allow, --yolo, Hermes cron, Hermes.app, Hermes source edits.
• Recheck spawn requires pack + version pin + approvals.mode manual; any miss ⇒ hold, never partial facts.
• No TICA, lock changes, legal advice, inspection app, payments licence.
• No photos of tenant belongings published. No back-dating a maintenance request or a notice.
• Law is a refusal, not a feature. No crawler, no national notice-period table.
• Serving a notice on WhatsApp is not reliable service. Courtesy + disclaimer, or escalate.

SOUL three rules: draft only / no notices no trust / do not invent a legal clock.

Stop when a principal can say: "I can see what it used, it cannot send, and it did not invent a clock."

## 6. Software as of 2026-08-23 (shipped, not slides)

Training appliance. Pilot contract still demo (agency: RealBud Demo Book). Architecture is ahead of integration.

Shipped
• Appliance chrome: Desk / Ask / Schedule / You
• Product mode: one Bud thread; denied bot/group/plugin/cloud-computer routes; API-level gate hardening (no unattended-approval flips, Bud undeletable/unrenamable)
• Desk book: add/edit/remove properties, full per-property options, locked never
• Morning evaluate + Allow/Deny/Edit/Copy; send always 403
• CSV import matched by address or property code; freshness / unmatched / partial / reversed holds; ambiguous rows become row-level holds (batch-reject schema-only; zero-match imports never fake live)
• Notes on the card; vault seeded as Hermes cwd; Allow appends to note + decisions log; evaluate never reads the vault (regression-tested)
• Ask → Desk: "Put on Desk" creates a pending draft needing the one Allow
• Hermes pin (server/hermes-pin.ts v0.20.3 / v2026.8.16.2), pack/property/, fail-closed Recheck incl. manual-approvals spawn gate
• Named loops with an editable clock: PATCH time/weekdays/enabled + revision, no backfill (server/routines.ts); Schedule GUI time + weekday chips
• Friday owner letter v0 (server/owner-letter.ts): factual weekly catch-up per property from Desk facts + Notes, Copy-only, via Run now or the Friday clock
• Bounded fake-portal prefill; Bud submit 403
• Hands chip: Hermes live vs training book; miss surfaces why and falls back

Not shipped
• Ask proposing a Schedule change as a card (PR C, deferred until a named office asks)
• Inbound / emergency triage loop
• Named paying/pilot agency · Live portal / PropertyMe OAuth · PM pocket messaging
• Installer a graduate can double-click

Key code
• Desk: server/desk.ts + /api/desk; evaluate: server/desk-evaluate.ts (pure; imports crypto + contracts only)
• Loops: server/routines.ts + /api/loops (PATCH enabled only today)
• Hands: server/hermes-hands.ts, server/hermes-pack.ts, server/hermes-pin.ts
• Gates: server/product-mode.ts (+ denials), server/gates.test.ts canary
• Bounded CUA pin: server/cua-bounded.ts (0.19.3); live macOS only after the pilot contract names an office

## 7. Doctrine (from the two 2026-08-22 posts)

We do not take Hermes Bot Mode (roster, avatars, bot-to-bot DMs). Pinning is the answer; do not track main. We steal Pi harness-v2's discipline, not its harness:

Many bots coordinating → one worker; loops are kinds, not teammates.
Unattended wake-up → RealBud clock; lid shut ⇒ catch-up on open; nothing sends unsupervised.
Long-running context → Hermes is one-shot for facts; book is files; context disposable.
Lossy prune → miss ⇒ fail closed to the training book; evaluate never invents a balance.
Spill to disk → ledger in desk.json; notes in vault; PMS is the legal file.
Intent then result → clock → skill JSON → shop evaluate → Desk card. Allow = commit. Send = 403.
Crash mid-tool → dead Recheck = hold + "hands missed," never a half-sent notice.
Hard boundaries → Ask = conversation; desk.json/loops.json = runtime; Desk = UI; pack = how; plugins denied.
Model glued to harness → models attach on `property`; shop rules are TypeScript.

Growth rule: more kinds on one worker, not more agents. Desk Recheck, a named loop, and Ask are three doors onto one book.

Forbidden even if Hermes ships it tomorrow: roster (arrears/owner/emergency/tenant bots); bot-to-bot DMs; tracking main; a 50-hour unsupervised run that "remembers the book" in context; plugin marketplace; copying Pi's session tree/lanes/SQLite log into this repo.

## 8. Plan (do not jump)

The beta door (1–5) and all three sells items are done at HEAD, plus clock retune (PRs A/B) and owner-letter v0. Code is now ahead of the pilot; the next moves are commercial, not architectural:

1. `docs/PILOT-CONTRACT.md`: required fields — PMS brand, named exporter, export cadence, office OS.
2. After a named agency signs: installer a graduate can double-click.
3. One vendor-test portal, bounded CUA, human Submit.
4. Pocket: Telegram or WhatsApp Cloud, this PM only.
5. PropertyMe read API only if the visit says they are on PropertyMe and CSV is the pain.
6. Lid-shut later: launchd writes a result file only; RealBud reads on open. Still fail-closed. Still no send.
7. Ask-proposes-clock-changes (PR C) only when a named office asks for it.

Not beta / do not start: tenant WhatsApp, law crawler, trust, Form 11, Tapi, vault page, extra agents, Computer playground, "create any routine from English," forking Hermes Desktop, overlaying Hermes.app, racing message_agent, replacing PropertyMe.

## 9. How to work in this repo

• YAGNI. No unrequested abstractions. Tests for evaluate, gates, CSV parse, product-mode denials, send 403.
• First-run and Desk copy must not contain Obsidian, vault, or second brain. UI noun is Notes.
• Internal env OMB_* may stay for harness. User-facing strings say RealBud.
• A loop is never a bot turn, a prompt, or a second agent.
• If the next instruction is missing, follow §8's numbered order.
