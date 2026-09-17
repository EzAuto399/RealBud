# Agentic weekday — Bud runs it, the PM judges

Date: 2026-09-04  
Canonical: `docs/GOAL-PROMPT.md` wins. Coverage: `docs/PM-COVERAGE.md`. Soul: `pack/property/SOUL.md`.

This kills the ChatGPT posture. RealBud is not a prompt box that advises a property manager. **Hermes `property` is the hands. RealBud is the clock, the cards, and Allow.** The PM does not start the work. The clock does.

## Wrong vs right

| ChatGPT (forbidden default) | Agentic RealBud |
|---|---|
| PM types “what should I do about Oak?” | 7:30 fires. Bud already checked Oak. |
| Bud replies with a paragraph | Desk has one card. Phone buzzes. |
| PM copies advice into PropertyMe by hand, from memory | Allow (or Deny/Edit). Copy is the PMS send step, not the thinking step. |
| PM has to be at the keyboard to start a check | Recheck / morning loop / Friday letter run with the app in the background |
| Ask is a chat log | Ask is an interrupt: “put courtesy on Oak”, “this outcome, you handle the steps” |
| Portal is “here’s how you click” | Run beside me: Bud reads and prefills; they Submit |

**Takeover means:** repeated prepare-and-queue work happens without a prompt.  
**Takeover does not mean:** Bud sends, pays, lodges a bond, or issues a notice. That is the licence. A 10-second Allow is the product, not a cop-out.

## Three doors Hermes actually has

All headless. Never Hermes.app. Pin stays `HERMES_PIN` until an isolated canary.

| Door | When | What Bud does | PM |
|---|---|---|---|
| **Hands** `hermes -p property chat -Q` + skill | Clock / Recheck | Fetch ledger JSON. No chat. | Nothing until cards land |
| **Ask** `hermes -p property acp` | Interrupt while looking | Turn an outcome into Desk work or a saved job | One sentence, then Allow |
| **Portal** bounded CUA | Saved job, Attach, Run beside me | Read / prefill on their login | Sign in, Submit, Pay |

If Hands is dead (pin mismatch, no model, no pack), the weekday is **not** agentic — it is a training appliance on CSV/fixtures. That is the live hole. Do not paper over it with more chat UI.

## Takeover ladder (same window)

1. **Bud works the shift** — morning money + Friday letter fire on the clock. Hermes fills facts. Evaluate drafts cards. Pulse the phone. *Shipped if the worker answers.*
2. **PM judges in 10 seconds** — Allow / Deny / Edit on Desk or phone. Licensee cards never leave Desk. *Shipped.*
3. **Bud does it in their system** — attended portal: prefill the message / form they would have typed. They press Send/Submit **in the PMS**. *Shipped behind Attach.*
4. **Bud sends for them** — **never.** 403. Insurance.

New repeated work (inbound, inspection-week, renewals) is a **new kind on the same clock**, using the same three doors — not a chatbot skill and not a second agent.

## What “replace the day” looks like for a non-technical PM

They do **not** learn prompts. They do this:

1. Leave RealBud running (or the clock in the desktop app).
2. At 7:30, phone: “Morning money — 12 checked · 3 need you.”
3. Between inspections, tap Allow on courtesy. Open Desk only for licensee / Edit.
4. Friday, Copy the owner letter into the portal they already use — or Run beside me and let Bud prefill it.
5. Once: Schedule → Give Bud a recurring job. Name what, when, which site or bank, and whether Bud only prepares Desk cards, reads, or prefills. Approve. Attach if it opens a site. After that Bud queues **Ready beside you**.

If they are still typing “check rent for me” into Ask every morning, we failed. That morning already has a named loop.

## Hard rules (do not relax to look more agentic)

- No `--yolo`, no Always-allow, no unattended Submit on money / sign / notice
- No second Bud, no tenant bot, no Hermes Desktop
- `cron_mode: deny` — RealBud owns WHEN
- Evaluate never reads Notes
- Pin bump only via isolated canary + rollback to v0.20.3

## Pickup (engineering, not a visit)

The agentic product is already specified. Live Hands is not: machine Hermes is v0.21, pin is v0.20.3, so Recheck honestly says the worker is not answering. Next agentic proof is an **isolated v0.21 canary** (new `HERMES_HOME` + profile), then a named CSV so Hands has facts. Do not add a chat feature to fake takeover.
