# Portal work — Bud in the real browser

Date: 2026-09-01 · updated 2026-09-02
Status: architecture updated; the general prepare-only job engine is built locally.
Live portal attach still waits for the eight-field office in `docs/PILOT-CONTRACT.md` —
the infrastructure does not.

**2026-09-02:** owner decision — that visit gate is gone for portal work.
A PM who asks Bud to log in and complete a portal routine must not be
refused. Repeated portal routines are **attended saved-job runs**
("Run beside me") behind a per-job Attach. Inbound, Pocket, and the
graduate installer still wait on the visit. Do not rebuild `readyForLivePortal`
as an HTTP gate — it was never enforced on the wire.

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
- RealBud loops (`server/routines.ts`) — the canonical clock a job runs on.
- `JobRun` ledger (`server/job-runs.ts`) — immutable revision snapshot,
  idempotency, overlap control, restart recovery, evidence, and receipts.
- Desk Allow flow — where prepared facts land. Send stays 403 forever.

## Borrowed from grok-bot-0.18-reconstructed (reviewed 2026-08-30)

- **Per-surface modes** (`off` / `shadow` / `enforce`). We take `shadow`:
  Bud narrates what he *would* do without doing it — the learning mode for a
  new recipe before it earns trust.
- **Decision-time rules**: an approval card carries a proposed rule; approving
  can save “always allow reading propertyme.com.au” so that kind never asks again.
- **One pending approval at a time** — no approval pileup.

## The model

**Surfaces** (PM language, each with its own consequence): workroom files · web
research · guarded commands · portal reading · portal forms · portal submit ·
Desk writes. Send/pay is not a surface. It does not exist.

**2026-09-01 modes** (kept as history): `ask` · `rules` · `never`. Prepare-only
runs still never get send, pay/trust, signing, statutory notices, or PMS
mutation.

**Consequence ladder (2026-09-02)** — what each portal surface can become.
Guards from `auto-approve.ts` and `server/portal-fence.ts` run first; a rule
never covers submit, pay, passwords, or another site, and a prefill rule
cannot widen a read-only job.

| Surface | Default | Can become |
|---|---|---|
| Read / navigate | Ask | Standing site rule (`portal:read:{origin}`) |
| Prefill | Ask | Standing site rule (`portal:prefill:{origin}`) — only if the job has `portal-prefill` |
| Submit (non-money: submit / save / continue / next / confirm / lodge / create / update) | Never | Ask per instance, opt-in per job (`portal-submit` + `submitAcknowledgedAt`). Never a rule. Never session-scoped. |
| Pay / transfer / lodge payment / sign / send / delete / statutory (pay, payment, transfer, remit, bpay, direct debit, authorise, approve payment, sign, send, delete, remove, notice, terminate, evict) | Never | Never |
| Passwords / OTP / MFA | Never | Never |

**Standing rules** (`server/rules.ts`, `rules.json`, atomic):
`{ id, key, decision, label, createdAt, surface?, origin? }`. Portal keys are
`portal:read:{origin}` / `portal:prefill:{origin}`; labels “Reading on
{origin}” / “Prefill on {origin}”. Portal rules can only `allow` (400
“Portal rules can only allow.”). `POST /api/rules { surface, origin,
decision: "allow" }` — 400 if `surface` is anything other than
`portal-read` or `portal-prefill`. You → Bud’s rules lists them with a
“Site rule” pill and revokes them.

**Decision-time creation**: the Allow card’s third choice —
“Always allow reading on {origin}” / “Always allow prefill on {origin}”
(`PendingApproval.tsx`) — writes the rule via
`POST /api/threads/:id/respond { behavior: "allow", scope: "once",
rule: { surface, origin } }`. A submit ask never offers that choice.

## The workflow: teach Bud a job

1. **Describe** — In Ask: “Every Friday, check the arrears report, put anyone
   7+ days late on Desk, and prepare the follow-up for review.” Bud proposes an
   editable job card: ordered steps, safe capabilities, sources, completion
   evidence, run limits, and an optional schedule.
2. **Rehearse** — the first run is `shadow`. Bud explains what the plan would
   do and records a receipt without granting itself consequence authority.
3. **Approve one revision** — a person approves the exact current job revision.
   Any material edit increments the revision and clears that approval.
4. **Schedule or prepare now** — RealBud, not Hermes, owns the clock and starts
   one bounded attempt from an immutable revision snapshot. Duplicate triggers
   reuse the same idempotent receipt; overlapping execution is rejected. The
   pinned Hermes CLI receives only the per-run `file` and/or `web` toolsets the
   approved card needs—never terminal, browser, memory, delegation, or cron.
5. **Receipt and hold** — the result lands as a durable `JobRun` on Desk with
   evidence, outputs, failure/recovery state, and any consequential next steps
   held for the PM. The hold records what the person must do; a prepare-only
   run never grants Bud permission to send, submit, sign, pay, or mutate the
   PMS. (2026-09-02: attended Submit is the one opt-in exception — see
   Hard boundaries.)
6. **Attach later, source by source** — real Chrome/PMS attachment remains a
   named-office proof gate. RealBud never copies the password or cookie, and an
   origin outside the approved source stops the run.

   **2026-09-02:** Attach is now a per-job acknowledgement on this Mac
   (`PATCH /api/recipes/:id { attach: true }`, acknowledged
   `human-login-and-submit`). It no longer waits on the eight office fields.
   Editing `allowedOrigins` clears it, same as plan approval.

## Run beside me — shipped 2026-09-02

Do not rebuild. Lifecycle:

1. **Describe** — Ask ("log in to … and complete the routine") or Schedule →
   Give Bud any recurring job. Imperative portal sentences create a shadow
   job via the recipe-draft path (`server/portal-job-intent.ts`, pre-model;
   parser yields to ask-book and connection intents). Reply names the plan
   and: "You sign in yourself, I read and prefill, and Submit, Pay and Send
   stay with you. Approve the plan on {Schedule | You → Bud's jobs}, then
   press Run beside me." Existing job → "is already a saved job for {site}.
   Open {place} and press Run beside me…". Weak targets (account / site /
   online / the routine) count only with a login verb. Model down → honest
   fallback. Do not refuse.
2. **Approve one revision** — same as the prepare-only engine.
3. **Attach this site** — GUI acknowledgement (`PortalJobActions.tsx` on
   Schedule recipe loops and You → Bud's jobs `#you-jobs`): you sign in;
   Bud reads and prefills; Submit, Pay and Send stay with you. 409:
   "Add the portal site and a portal capability before attaching it."
   One-step **Approve and attach** when the plan is still unapproved.
   Opt-in **Bud may press Submit** (`PATCH /api/recipes/:id
   { submitAcknowledged: true|false }`) — 409 if the job lacks
   `portal-submit` ("Add 'Bud may press Submit' only on a job with the
   portal-submit capability."). Editing origins or capabilities clears
   the acknowledgement. `portal-submit` requires `portal-prefill` and
   ≥1 origin ("Add prefill before Bud may press Submit.").
4. **Run beside me** — `POST /api/recipes/:id/attend` → 202 `{ run }`.
   Same ACP turn Ask uses, `computer: true`, attended-job prompt block.
   409s in order: "Approve the plan first." / "Attach this site first: you
   sign in, Bud reads and prefills, Submit and Pay stay with you." /
   "Add the portal site to this job before running it beside you." /
   "Bud can drive a browser only on this Mac with RealBud's desktop helper
   running." / "This job already has work waiting or running." /
   "Bud is busy with another turn. Stop it or wait, then run again."
   Ask chip **Run beside me now** when an approved+attached job matches
   Bud's "is already a saved job" reply.
5. **Ready beside you (2026-09-02)** — the clock never launches a
   browser. For an approved+attached portal job it enqueues an attended
   `JobRun` `status: "queued"` with detail "Ready to run beside you —
   press Start when you are at the screen." and emits `job.run`. The
   card and Desk Activity show **Ready beside you** + **Start beside me**
   → `POST /api/recipes/:id/attend { runId }`. Not attached/approved →
   skip with "Attach the site and approve the plan to run this beside
   you." Queued attended runs survive restart; after 24 h they settle
   `missed` ("Not started — the run waited a day for someone at the
   screen."; GUI "Not started — waited a day"). `JobRunStatus` includes
   `missed`.
6. **Cards + fence** — `server/portal-fence.ts` before any Allow card.
   On-origin read/navigate → the normal card (Allow once / Allow for this
   task) plus “Always allow reading on {origin}” when a rule can be
   saved. Submit (opt-in) → Allow this Submit / Deny / Stop this turn —
   never session-scoped, never a rule. Evidence per fenced request.
   SSE `{ kind: "job.run", run }`. `GET /api/job-runs`.
7. **Receipt** — `attendedRunLabel`: Ready beside you / Running beside
   you / Done · read back from {site} / Unknown — check the site
   yourself / Stopped / Not started — waited a day. Receipts:
   "What Bud did · N actions" with fence denials, tagged **allowed by
   rule** and **Submit pressed with your approval**. Ask chips: Open the
   job / Approve the plan / Run beside me now / Stop.

**Fence** (`server/portal-fence.ts` — RealBud's, not Hermes):

| Request | Decision |
|---|---|
| Tool outside navigate / read / fill / click_semantic | Deny — "Bud can only open, read, fill and click on this job's site." |
| Host not an allowed origin or its subdomain | Deny — "That site is not on this job." |
| Navigate / fill / click with unreadable params | Deny — "Bud could not confirm which site or control this touches." |
| Fill password / OTP / MFA | Deny — "You sign in yourself — Bud never types a password." |
| Fill without `portal-prefill` | Deny — "This job is read-only. Add prefill on Schedule if Bud should fill forms." |
| Click labelled pay / payment / transfer / remit / bpay / direct debit / authorise / approve payment / sign / send / delete / remove / notice / terminate / evict | Deny — "Submit, Pay and Send stay with you." |
| Click labelled submit / save / continue / next / confirm / lodge / create / update without `portal-submit` + acknowledgement | Deny — "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should." |
| Same submit labels with capability + acknowledgement | Ask — "Bud wants to press '{label}' on {origin}. Check the form in the browser first." Allow this Submit / Deny / Stop this turn. Never a rule. |
| Read / navigate on-origin | Ask — Allow once, or "Always allow reading on {origin}" (site rule); or already allowed by a `portal:read:{origin}` rule |
| Prefill on-origin with `portal-prefill` | Ask — Allow once / site rule; or already allowed by `portal:prefill:{origin}` |

Every fenced browser allow is **once**. A task-wide ("session") grant would tell the worker to stop asking for that tool, and the fence only sees what the worker asks — so the server coerces `scope: "session"` to `once` on fenced requests and the card does not offer it (2026-09-02). Site rules are the honest "don't ask again": the fence re-checks them on every request.
| Ad-hoc Ask browsing (no fence context) | Deny — "Only sites named in a saved job. Ask Bud to set the routine up as a job first." |

(2026-09-02: the old row that denied every submit/pay/lodge/send/sign click is split — money and statutory stay denied; non-money Submit can ask when the job opted in.)

**Settle:** `completed` only if the turn is ok **and** the last assistant
text names an allowed origin **and** contains a read-back word (observed /
read back / shows / shown / found / balance / status / due / paid /
outstanding). Else `partial`. `failed` / `interrupted` on error / stop.
A missed read-back is unknown, never done.

Capabilities: `portal-read`, `portal-prefill` (prefill implies read),
`portal-submit` (requires prefill + origins; fence only sees it when
`submitAcknowledgedAt` is set). Portal capability requires ≥1
`allowedOrigins`. No pay / sign / notice / send / delete / PMS-mutation
capability. Cookies and passwords never leave Chrome. Bank sites: read
and export only.

**Still not built**

- Unattended Submit, session-scoped Submit, or a Submit standing rule — **never**.
- Pay / transfer / sign / send / delete / statutory by Bud — **never**.
- General desktop apps beyond the browser — later (fence is browser-typed today).
- Clock launching a browser — **never**. Scheduled portal jobs queue
  “Ready beside you” (shipped 2026-09-02).

## Stages

- **Built locally — describe → editable job → shadow → exact-revision approval
  → manual/scheduled prepare → durable receipt.** Includes migration,
  idempotency, overlap rejection, bounded execution, redaction, and interrupted
  restart recovery.
- **Named-office proof next — attach + read-only runs.** Chrome attach, allowed-origin
  enforcement, evidence on the case, weekly payment check live against the
  real PMS with the owner watching.
- **2026-09-02 — attended attach shipped (did not wait on named-office proof).**
  Describe → shadow → approve one revision → Attach this site → Run beside me
  → cards + fence → receipt. Clock prepare stays as built; the clock still
  never opens Chrome.
- **2026-09-02 — portal wave 2 (same day).** Standing site rules for
  read/prefill; Submit as a per-instance ask on jobs with “Bud may press
  Submit”; clock enqueues Ready beside you + Start beside me (`missed`
  after 24 h). Owner boundary: Submit is the one relaxation of the former
  hard “never submit” line — opt-in per job, per instance, non-money only.
- **After proof — broader sources and team governance.** Each source, permission
  boundary, cost limit, and support/recovery path earns separate evidence.
  Inbound, Pocket, and the graduate installer still wait on the visit.

## Hard boundaries (never relax)

- No pay / transfer / trust / sign / legal-notice / send / delete /
  PMS-mutation job capability. Payments, transfers, trust, signatures,
  notices, sends, and deletes stay outside Bud. Bank sites: read and
  export only.
- **Submit exception (2026-09-02):** the one relaxation of the former
  hard “never submit” line. Non-money forms only (submit / save /
  continue / next / confirm / lodge / create / update). Opt-in per job
  (`portal-submit` + “Bud may press Submit”). Asked every time. Never a
  standing rule. Never session-scoped. Without the capability and
  acknowledgement the fence still says “This job cannot press Submit…”
  Money and statutory labels still say “Submit, Pay and Send stay with
  you.”
- Cookies and passwords never leave Chrome.
- A rule can never approve what the guards forbid (destructive, sensitive,
  submit, pay, passwords, or another origin). A prefill rule cannot widen
  a read-only job.
- A missed read-back leaves the case “unknown”, never “done”.
- Hermes reasons and uses tools; RealBud owns schedule, scope, approval,
  idempotency, concurrency, the portal fence, and durable receipts.
  2026-09-02: fence is RealBud's (`server/portal-fence.ts`). Hermes source
  stays untouched.
- The word for the browser is the user’s own Chrome — no container detour
  unless they ask for it.
- The clock never launches a browser.
