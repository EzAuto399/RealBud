# Portal work — Bud in the real browser

Date: 2026-08-30
Status: approved direction from the owner; staged build. Stage 1 (rules) builds now.
Live portal attach still waits for the eight-field office in `docs/PILOT-CONTRACT.md` —
the infrastructure does not.

The owner’s ask: Bud uses computer-use in the user’s real Chrome (their sessions,
their cookies — never copied into RealBud), runs the weekly payment check against
the real PMS, and escalates toward portal actions (a notice), all described in
plain words. Friction stays low through standing rules; anything consequential
escalates once, and the user sets the rule at that moment.

## What already exists (do not rebuild)

- `electron/cua.mjs` — macOS computer-use via the cua-driver daemon. Embedded mode
  (packaged: TCC grants attribute to RealBud) and standalone (dev). This drives
  the host Mac — including the user’s real Chrome profile.
- `server/auto-approve.ts` — guards-first auto-decisions: destructive/sensitive
  never auto; `alwaysAllow` grants one program, not the whole shell.
- ACP permission broker (`server/drivers/acp/core.ts`) — fail-closed cards,
  Allow/Deny, 15-minute timeout, product mode never auto-approves.
- `server/product-mode.ts` — the fence: Bud cannot be given `autoApprove` /
  `alwaysAllow` today (403 “RealBud never runs unattended”). Stage 1 opens this
  deliberately, through rules, not through the raw flag.
- Loops (`server/routines.ts`) — the clock a recipe runs on.
- Desk Allow flow — where recipe-produced facts land. Send stays 403 forever.

## Borrowed from grok-bot-0.18-reconstructed (reviewed 2026-08-30)

- **Per-surface modes** (`off` / `shadow` / `enforce`). We take `shadow`:
  Bud narrates what he *would* do without doing it — the learning mode for a
  new recipe before it earns trust.
- **Decision-time rules**: an approval card carries a proposed rule; approving
  can save “always allow reading propertyme.com.au” so that kind never asks again.
- **One pending approval at a time** — no approval pileup.

## The model

**Surfaces** (PM language, each with its own mode): workroom files · web
research · guarded commands · portal reading · portal forms · portal submit ·
Desk writes. Send/pay is not a surface. It does not exist.

**Modes per surface**: `ask` (default) · `rules` (standing rules decide) ·
`never`. Portal submit defaults to `ask` and can never be `never`-overridden
into silence — a statutory moment always has a human in it unless a per-case
lease says otherwise.

**Standing rules** (`server/rules.ts`, `rules.json`, atomic): `{ surface,
match, decision: allow|ask|deny, createdFrom, at }`. `match` is scoped the way
`approvalKey` scopes: tool + program, or portal + origin. Guards from
`auto-approve.ts` run before any rule is consulted; a rule can never widen
into destructive or sensitive.

**Decision-time creation**: the permission card gains a third choice —
“Always allow this on propertyme.com.au” — which writes the rule. You →
“Bud’s rules” lists and revokes them.

## The workflow: teach Bud a job

1. **Describe** — In Ask: “Every Friday, open my PropertyMe, check the arrears
   report, put anyone 7+ days late on Desk.” Bud answers with a **recipe card**:
   ordered steps, allowed origins, the evidence each run captures. Nothing runs
   until the card is allowed.
2. **Recipe** — saved on the book (`recipes.json`): steps, `allowedOrigins`,
   evidence spec, the loop it hangs on (or manual). First run is `shadow`:
   Bud narrates each step against the live page without clicking anything.
3. **Attach** — CUA drives the user’s real Chrome. The user logs into the PMS
   themselves, once, in Chrome. RealBud never sees the password; the session
   cookie never leaves Chrome. Every navigation is checked against
   `allowedOrigins`; anything else stops the run and tells the user.
4. **Run with evidence** — on the clock or from the case. Each step writes
   read-back evidence (URL + snapshot stamp) onto the case. Facts land as Desk
   cards through the same Allow flow a CSV import uses.
5. **Escalate, bounded** — for a notice: Bud opens the portal, fills the form,
   stops before submit. The case reads “Ready — review and submit.” A per-case
   “Allow Bud to submit this once” lease (origin-locked, expiring, evidenced)
   is the only way over that line, and it is a later stage, not this one.

## Stages

- **Stage 1 — rules foundation (this wave).** `server/rules.ts` + card
  rule-creation + You → Bud’s rules. Works for today’s Ask (workroom files,
  web research, guarded commands). No CUA yet.
- **Stage 2 — describe → recipe.** Ask produces the recipe card; recipes
  persist; shadow mode narrates.
- **Stage 3 — attach + read-only runs.** Chrome attach, allowed-origin
  enforcement, evidence on the case, weekly payment check live against the
  real PMS with the owner watching.
- **Stage 4 — bounded escalation.** The per-case submit lease. Only after
  Stage 3 has evidence history.

## Hard boundaries (never relax)

- No send/pay surface. Ever.
- Cookies and passwords never leave Chrome.
- A rule can never approve what the guards forbid (destructive, sensitive).
- A missed read-back leaves the case “unknown”, never “done”.
- The word for the browser is the user’s own Chrome — no container detour
  unless they ask for it.
