# How we approach the locked-engine plan

Date: 2026-08-18  
Status: phases 1–3 executed — RealBud window, Hermes headless only, no Hermes source edits  
Related: `docs/REVIEW-BRIEF.md`, `server/hermes-pin.ts`

The careful minimum you wrote is right as a **product contract**. It is two jobs, not one:

1. **Lock the engine** (Hermes pin + one profile + no YOLO).
2. **Lock the window** (only Desk, Copy/Approve, tiny settings).

Those jobs do not live on the same seam.

---

## The seam (read this first)

Hermes Desktop plugins (`~/.hermes/desktop-plugins/`, or bundled under `apps/desktop/src/plugins/`) can:

- add a sidebar route / pane (we could add **Desk**)
- talk to the gateway (`host.request` — profiles, cron, config)
- toast, palette commands, statusbar

They **cannot** hide or lock:

- Pets / PetDex / New Agent / free bot creation
- Model picker / YOLO / Always-allow
- Full Settings, Skills Hub, Plugins marketplace
- Terminal, file browser, group chats

Their own desktop notes say the shell registries are **not** a public ABI for rewriting chrome. Bot Mode is now **built into** Desktop. An overlay cannot strip it.

So: “pin Hermes Desktop + overlay RealBud, no fork” **locks the engine**. It does **not** complete your strip list if the licensee is looking at `Hermes.app`.

---

## How we interpret “keep Desktop + Bot Mode as locked engine”

**Engine, not window.**

The PM never launches Hermes Desktop. We pin that stack (Desktop code + Bot Mode + CLI + gateway) at v0.20.3 and drive it headless:

- `hermes -p property` — one locked bot
- `hermes acp` / `hermes serve` — chat/streaming when we need it
- cron — morning arrears later
- Bot Mode roster = that one pre-seeded profile, not a UI they browse

The **window** is RealBud (this repo). We already control Desk, Copy/Approve, walkthrough, and we can hide Koda / Plugins / engine shopping.

That is the only “no fork” path that can actually deliver the strip list.

If someone later insists the *pixel window* must be official Hermes Desktop, that is a **small patch series** on their renderer (hide nav items). Call it a patch, not a product fork — and only after the engine pack works. Do not start there.

---

## Three layers

```
┌─────────────────────────────────────────────┐
│  RealBud window (this repo)                 │
│  Walkthrough · Desk · Copy/Approve          │
│  Settings: PMS / tone / account only        │
│  No pets, no New Agent, no YOLO, no Koda    │
└──────────────────┬──────────────────────────┘
                   │ ACP / CLI / cron
┌──────────────────▼──────────────────────────┐
│  Locked Hermes engine (pinned, not latest)  │
│  Profile `property` · SOUL · three rules    │
│  approvals.mode: manual                     │
│  skills: arrears only                       │
│  memory scoped to this profile              │
└─────────────────────────────────────────────┘
```

Installer (later) drops both: RealBud.app + pinned Hermes checkout + config pack. Home screen says RealBud.

---

## Map your keep / strip list to work

| You said | Where it lives | How |
|---|---|---|
| Desktop shell + chat/streaming | RealBud already has a shell; Hermes ACP for the stream | Keep ours. Don’t open their chrome. |
| Bot Mode roster, pre-seeded only | Hermes **profile**, not their roster UI | One profile: `property`. No second bot. |
| 1 locked bot “RealBud” | `~/.hermes/profiles/property/` | SOUL.md + three rules + pinned model + no create-profile in our UI |
| Routines (morning arrears) | Desk now; Hermes cron later | Fixture check first. Cron when the skill is real. |
| Copy + Approve only | Desk (done) | Never add Always-allow / send. |
| Minimal settings | New small panel | PMS, tone, account. Not their Settings tree. |
| Pets, New Agent, model shop, YOLO, voice, plugins, groups, terminal, Koda | Their Desktop + our leftover OS | **Don’t show their app.** Hide ours (Workshop fold / delete starter bot). |

---

## Phases (careful minimum)

### Phase 0 — Honesty spike (half day)

Confirm on pinned Desktop: a runtime plugin cannot remove New Agent. Write the result in this file. Stops the overlay fantasy.

### Phase 1 — Engine pack (this repo)

Add `pack/property/` we can drop into a Hermes home:

- `SOUL.md` — unregistered assistant, three rules, no send, no trust
- `config.yaml` — `approvals.mode: manual`, model pin, no YOLO
- skill allowlist: arrears / draft only
- install script: checkout `HERMES_PIN.commit`, `hermes -p property` once

No UI work. Test: profile exists, `hermes -p property -q "what are you?"` recites the rules, cannot run `approvals.mode: off` from that profile without us.

### Phase 2 — Appliance chrome (this repo)

Already started. Finish:

- Hide assistant list on first-run (Workshop)
- Default fleet = `hermesAgent` only
- Kill leftover Koda / onboarding quiz as the identity
- One settings surface: PMS / tone / account

### Phase 3 — Wire Desk to the pack

Morning check calls `hermes -p property` (or ACP) for rent/levy facts when a fixture flag is off. Fail closed to the training book. Copy/Approve unchanged.

### Phase 4 — Package

One installer: RealBud + pinned Hermes + pack. Do not put Hermes.app on the Dock. Settings can say “Hands: Hermes 0.20.3” in small type.

### Not in the minimum

- Fork or rebase Hermes Desktop
- Shipping Hermes.app to licensees
- Live PropertyMe OAuth
- Multi-bot “team”
- Skills Hub, MCP shop, voice

---

## What we do not do, even if it is tempting

- **CSS overlay on Hermes.app** — breaks on the next pin bump. Looks like a hack in a training-provider demo.
- **Track `main`** — contradicts the pin.
- **Rebrand their binary as RealBud** — trademark/clone problem we already rejected.
- **Keep Bot Mode UI “but locked”** — their UI is built to create bots. Locking it is fighting the product. Lock the **profile** instead.

---

## Order of attack this week

1. Phase 1 pack — `pack/property/` + `scripts/install-property-pack.sh` + boot `applyPropertyPack()`. Done.  
2. Phase 2 chrome — Desk home, Workshop fold, no starter bot, fleet defaults to `hermesAgent`. Done.  
3. Phase 3 Desk → Hermes — `runMorningCheckLive()` / `tryHermesLedger()`. Fail closed to the training book. Done.

Phase 4 (installer, no Hermes.app on the Dock) is not this week.

If a reviewer still wants the PM inside Hermes.app, they are asking for a **Desktop patch set**. That is a different project. Do not mix it into the pack.
