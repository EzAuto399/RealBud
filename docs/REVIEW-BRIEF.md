# RealBud — briefing for an outside review

Date: 2026-08-18  
Purpose: hand this to someone who was not in the build chat. We want a well-rounded plan, not a rubber stamp.  
Repo: [EzAuto399/RealBud](https://github.com/EzAuto399/RealBud) (private). Local folder is still `PropertyMe`.  
Product name: **RealBud**. Do not call it PropertyMe, Hermes, OpenMausBot, or OpenManus.

Please read this once, then answer the questions at the bottom. Challenge the stack and the wedge. Do not add features until those are stable.

---

## 1. What this is, in one paragraph

RealBud is a **supervised assistant for Australian residential property managers**. It sits **on top of** whatever PMS the office already uses (PropertyMe, Property Tree, Reapit PM). It reads, drafts, flags, and escalates. A licensed person still sends notices and still moves trust money. We sell first through a **licence-training provider** to people who have just passed their real-estate licence — software that feels like an agency desk, not a developer agent OS.

Legal metaphor: an **unregistered assistant**. Prepare and file. Do not sign, pay, or bind the agency.

---

## 2. Who pays, who uses, what we are not

| Role | Who |
|---|---|
| Day-one user | Newly licensed AU agent (sales / leasing / PM mix) |
| First buyer | Licence-training partner bundling seats, or the new licensee themselves |
| Later buyer | Principal / rent-roll owner |
| Not | DIY landlords, US multifamily, a PMS replacement, a trust-accounting company |

Incumbents already ate “check rent and send a reminder.” PropertyMe AiMe, Property Tree Alex, Tapi (maintenance), Claire/Propic (PM chat). A demo that only sends a late-rent SMS dies in the first vendor meeting.

Typical AU shop is two systems: a PM/trust PMS plus a separate sales CRM, plus REI Forms Live or Realworks, plus SMS/email. Do not assume PropertyMe until a visit confirms it. Public PropertyMe API is mostly **read-only**; payment notices still go through the portal.

---

## 3. What we decided (and why)

### Product

- **Wedge we first wrote:** owner-retention letters + exception inbox (weekly/monthly truth from the file, PM taps approve, logged).
- **Wedge we actually built first:** morning **arrears courtesy** on a training book — because it is one loop, easy to show, and it teaches the hard gates (no send, no statutory draft, no trust).
- Tension: owner letters may still be the better *sale*. Arrears courtesy is the better *fixture*. A reviewer should say which is the first paid loop.

Per-property **options** are the product, not the PMS brand: rent source, grace days, levy taken from rent, notify channel, never-rules. Portals get trained as a thin computer-use skill only when there is no API.

### Stack

```
RealBud app  = this repo (OpenMausBot fork, already rebranded)
Hermes       = pinned worker only, profile `property`
Claude/Codex/Grok = optional coding brains, not the licensee home screen
PMS          = system of record (read + human-gated send)
```

Hermes Agent (Nous Research, MIT) now ships **Bot Mode** inside Hermes Desktop: roster of named bots, avatars, routines, bot-to-bot. That ate the reason we originally wanted OpenMausBot (chats + approvals + routines as an OS).

**We are not forking Hermes Desktop and renaming it RealBud.** Pin a known release. Put RealBud on the outside. Strip general-agent chrome. Upgrade Hermes when *we* choose.

Pinned today:

| Field | Value |
|---|---|
| Product | Hermes Agent **v0.20.3** |
| Tag | `v2026.8.16.2` |
| Commit | `7339f5f160db5c96657a3bab60151227cc61f66c` |
| Released | 2026-08-17 |
| Profile | `hermes -p property` |
| Source of truth | `server/hermes-pin.ts` |

Local machine: pinned installer has been run — Hermes is on **v0.20.3** (`git` checkout at the pin commit), pack applied, approvals manual, model attached (`grok-4.5` via `xai-oauth`).

**Cannot ship under:** PropertyMe (PMS trademark), Hermes (Nous brand), OpenMausBot (upstream product), OpenManus (different project).

---

## 4. What has actually shipped (2026-08-17 → 18)

Working software, not slides.

**Desk (the product loop)**  
Sidebar **Desk**. Training book of six ACT properties. Morning check:

- Unpaid past grace → courtesy draft (Oak)
- Rent in, levy not marked paid → desk flag, not an SMS (Harbour)
- Already reminded this period → no second draft (Pine)
- Past shop courtesy window → escalate, **no draft** (King)
- Paid / still in grace → quiet

Actions: **Copy**, **Approve wording** / **Got it**, **Deny**, **Edit**. No Send. `POST /api/desk/drafts/:id/send` is **403**. Courtesy disclaimer cannot be edited off. Escalate copy says shop rule, **not** a legal clock. No Always-allow on notify.

**Book (property management, in the GUI)**  
The PM manages properties natively on Desk: **Add property** (address, tenant, phone, weekly rent → quiet day-0 facts), **Remove**, and full per-property options — rent source, notify channel, grace days, courtesy window, levy-from-rent. The `never` list is locked on every property. Each card shows what the hands reported (days late, rent in/out, levy paid, last reminder) tagged “from Hermes” or “sample book”. Server: `POST/DELETE /api/desk/properties`, snapshot includes the ledger rows.

**Hands strip (deep connect, still headless)**  
Desk header shows the live hands chip — **Hermes live** vs **Training book** — with **Test hands** (one headless `hermes -p property` turn; the answer or the provider's own error words, e.g. the xAI billing line, surface inline) and **Manage** (Settings → Connections). The Hands card there also has **Attach model** (opens `hermes -p property model` in Terminal) next to install/pack/check.

**Walkthrough**  
Welcome (name + optional office email) → three rules (draft only / no notices no trust / training book) → Desk. No engine shopping, no mic, no Plugins in the sidebar. App opens on Desk. Chat assistants are still in the list (workshop, not home).

**Schedule (named loops, RealBud's clock)**  
The OpenMausBot routine runner (pick a MAUS + free-text prompt + calendar) is **deleted**. Sidebar **Schedule** shows the product loops instead: **Morning arrears** (available; = the clock pressing Desk Recheck — Hermes facts → shop rules → cards), **Friday owner letter** and **Inbound triage** (declared, `available: false`, no run/toggle). Loops live in `server/routines.ts` + `/api/loops`; the desk check broadcast updates the open Desk page. No Hermes cron path (`cron_mode: deny` stays), no second agent, no send. Missed ticks mark a run as missed; the app catches up on the next tick while open.

**Hermes pin + live hands**  
`hermesAgent` driver: `hermes -p property acp`. The pinned worker is the only engine in the product fleet (`server/drivers/builtIn.ts`); Claude/Codex/Grok CLIs stay on disk for tests only. Settings → Connections has a **Hands** card: `GET /api/hermes` reports pin vs installed version, pack, and manual approvals; buttons open the pinned installer (`--commit <pin> --force-commit`) in Terminal, apply the `property` pack, and re-probe. Desk **Recheck** runs the morning check through `hermes --profile property chat` (never `--yolo`, never Desktop); any miss falls back to the training book and the Desk chip/banner says why. `POST /api/desk/drafts/:id/send` is still **403**.

**Identity**  
`com.realbud.app`, data `~/.realbud`, health `app: "realbud"`.

---

## 5. Alternatives we argued (steelman both)

### A — Current recommendation: RealBud shell + pinned Hermes worker

Keep this Electron/React app. Hermes is a subprocess. Strip leftover OpenMausBot OS. Desk stays.

- *For:* We already have Desk, gates, and a PM walkthrough. We do not own Nous’s velocity. We can sell RealBud without looking like a Hermes clone.
- *Against:* Two runtimes (our server + Hermes). Chat/bots still leak “agent OS.” We must maintain a fork of OpenMausBot that we are slowly gutting.

### B — Fork Hermes Desktop, strip it, name it RealBud

Clone `hermes-agent`, freeze v0.20.3, delete Bot Mode extras, force manual approvals, port Desk in.

- *For:* One OS. Skills, cron, site→CLI, Bot Mode already exist. “We don’t need their latest product updates” is true for pets/Telegram.
- *Against:* We still need *runtime* updates (model APIs, portal rot, security). We inherit a huge Python + Electron tree. Desk restarts inside `apps/desktop`. We look like Hermes with a sticker. Licence-provider story gets worse, not better.

### C — Abandon this repo; ship a Hermes plugin only

Write Desk as a Hermes Desktop plugin on top of Bot Mode.

- *For:* Smallest code. Rides their installer and updater.
- *Against:* We do not control YOLO / Always-allow / send paths. We cannot sell “install Hermes, then our plugin” to a newly licensed agent as professional PM software. Brand is theirs.

**Working position:** A, then maybe a Hermes plugin later if the shell becomes a burden. Not B as the company.

---

## 6. Hard gates (do not “be helpful”)

- No trust EFT, disbursement, or “pay the levy from the receipt.”
- No auto-send of Form 11/12, NSW termination, VIC NTV, rent-increase, entry notices.
- Day-7 on Desk is a **shop reminder rule**, not QLD/NSW/VIC law. NSW termination is often 14 days unpaid. ACT addresses must not teach QLD Form 11.
- No TICA, lock changes, legal advice, inspection app, payments licence, PMS replacement.
- Courtesy SMS is not service of a notice. Edit must not strip the disclaimer.

---

## 7. Proposed next plan (90 days, if A holds)

1. **Finish the appliance chrome** — hide assistant list on first-run (Workshop fold). Default fleet = pinned Hermes only. Claude/Codex/Grok remain for builders, not licensees.
2. **Install the pin for real** — `hermes -p property`, `approvals.mode: manual`, isolated from personal `~/.hermes` memory.
3. **One live skill behind Desk** — e.g. read a bank export or PMS CSV for “rent landed,” still draft-only. Keep the fixture book as demo fallback.
4. **Decide the paid loop** — arrears courtesy vs Friday owner letter. Do not build both.
5. **One office walk** — 30–60 min: fill options on their book, confirm PMS + how rent is receipted + where late-rent messages actually go. Train at most one portal notify path if there is no API.
6. **Packaging** — RealBud installer that does not mention OpenMausBot or Hermes on the home screen. Hermes is “hands,” in Settings.

Out of this window: live PropertyMe OAuth, Tapi-style tradie marketplace, statutory form filling, forking Hermes Desktop.

---

## 8. Open facts / risks the reviewer should poke

- First customer is not named. Training-partner vs one agency vs Dickson listing book (`/Users/yoda/projects/Property`) is unset.
- First PMS is unset. Fixture Desk does not prove a PropertyMe (or other) integration.
- PropertyMe AiMe may already do courtesy arrears on the offices we want. If so, the wedge must move to owner letters or inbound triage.
- Hermes Bot Mode (bundled ~17 Aug 2026) will keep eating “agent OS” features. That is an argument *for* pinning, not for racing them.
- We ran the morning check through the pinned Hermes CLI end-to-end: Desk Recheck spawns `hermes --profile property chat`, and the worker ran the `morning-arrears` skill. The only live blocker seen was the attached model's billing (`xAI 402` on `grok-4.5`), which Desk surfaces verbatim and falls back to the training book. The `acp` driver itself (settings/model picker) is still unproven on a live turn.
- Hermes cron and Hermes Desktop stay out of the product entirely: RealBud owns the clock (named loops) and Hermes stays `cron_mode: deny`. If the app is closed at 7:30, the loop catches up on the next open — fine for training; a launchd result-file job is the later answer, still fail-closed.
- Existing user data may still have a leftover starter bot (e.g. “Koda”). Workshop is collapsed on first paint; Desk is home. Do not seed another.
- PI / licence risk if a graduate treats “escalate at day 7” as authority to issue a notice.

---

## 9. Questions we want answered

Please answer in writing. A letter (A/B/C) plus one sentence is enough.

**Q1. Wedge.** First thing we should be able to charge for?  
A) Arrears courtesy (what Desk shows now)  
B) Friday owner letter (original brief)  
C) Inbound triage (repair vs rent vs access)  
D) Other: ___

**Q2. Shell.** Where should the PM live?  
A) This RealBud app + Hermes as a pinned worker  
B) Fork Hermes Desktop, strip, rebrand  
C) Hermes Desktop + our plugin only  

**Q3. Hermes updates.**  
A) Pin and bump on a calendar / when a skill breaks (current)  
B) Track upstream `main`  
C) Full freeze, never bump  

**Q4. First live data.**  
A) CSV / bank export, no PMS API  
B) PropertyMe read API  
C) Dickson listing portal we already have  
D) Sit in one named office and train one portal  

**Q5. What would make you say stop?**  
One sentence. (Examples: “If AiMe already drafts their courtesy SMS.” “If you fork Hermes Desktop.” “If send is ever not a human.”)

**Q6. What did we over-build?**  
One sentence. What should we delete before the next demo.

---

## 10. How to look at the software

```sh
git clone git@github.com:EzAuto399/RealBud.git
cd RealBud
nvm use          # Node 24
pnpm install
pnpm dev:server  # :8799
pnpm dev         # :5199
```

Clear `localStorage.omb-email-gate` to see first-run. Click **Open today’s desk**. Do not expect a live PMS. Hermes pin: `server/hermes-pin.ts`. Product rules: `docs/PRODUCT-BRIEF.md`, `docs/WORKFLOW-PLAN.md`, `docs/IDENTITY.md`.

If you only have 20 minutes: read §1, §3, §5, §9. Then argue with Q2. That is the decision that changes everything else.
