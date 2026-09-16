# QA and live debug

Date: 2026-08-31 · updated 2026-09-02  
Canonical constraints: `docs/GOAL-PROMPT.md` wins.  
Weekday map: `docs/PM-DAY.md`. Pickup list: `docs/NEXT-WAVE.md`.

RealBud is in a **QA and live-debug phase**. The graduate path is walking the
same book as a morning — not adding surfaces ahead of a named office.

---

## Daily regression (no worker, no mail, ~3 min)

Run before any Desk UI change or before a visit demo:

```bash
pnpm qa                          # typecheck + vitest + e2e battery
pnpm qa:scale                    # 20/50/80/100 property timings
pnpm qa:live-worker              # real Hermes ping + Recheck (needs model on PATH)
```

Quick gate (desk + exceptions only, ~1 min):

```bash
pnpm qa:e2e:quick
```

Live worker needs pinned Hermes, property pack, and attached model. Skip billing
ping when credits are down: `QA_LIVE_SKIP_PING=1 pnpm qa:live-worker`.

Individual suites (each uses its own temp home and port):

| Script | What it proves |
|--------|----------------|
| `scripts/e2e-desk.mjs` | Desk CRUD, send 403, loops, hands status |
| `scripts/e2e-pm-day.mjs` | Happy weekday: clock, practice Allow, Ask→Desk, Friday letter, CSV, office fields |
| `scripts/e2e-pm-exceptions.mjs` | Messy day: Deny/Edit/stale Allow, evaluate matrix, money holds, notes isolation, pause, recipe gate, rules, law watch flag |
| `scripts/e2e-portal-jobs.mjs` | Portal jobs journey: Ask intake, recipe validation, fence/rules, fake-worker attended runs, ready-beside-you clock, receipts, Composio connect, recovery |
| `scripts/e2e-walkthrough.mjs` | Partner demo + fake portal + recovery |
| `scripts/qa-live-worker.mjs` | Real worker: Test hands ping, live Recheck, CSV, send 403 |
| `scripts/simulate-scale.mjs` | Book at 20–100 properties; desk/import latency |

CI runs the full e2e battery on Ubuntu after unit tests.

Packaged Mac smoke (renderer preload + embedded harness + clean exit):

```bash
pnpm package:mac
pnpm smoke:mac
```

Notarized release build (needs keychain profile `realbud-notary` — see
`docs/GRADUATE-RELEASE.md`):

```bash
pnpm package:mac:release
OMB_SMOKE_EXECUTABLE=release/mac-arm64/RealBud.app/Contents/MacOS/RealBud pnpm smoke:mac
```

Same hook as Linux CI (`OMB_SMOKE_TEST=1` in `electron/main.mjs`). Override the
binary with `OMB_SMOKE_EXECUTABLE=...` when testing a stapled copy outside
`release/mac-arm64/`.

Graduate release (notarize, strata Stage-0, Windows signing, bundled worker):
`docs/GRADUATE-RELEASE.md`.

---

## Scale check (optional, pre-visit)

Book at 20 / 50 / 80 / 100 properties through the real intake path:

```bash
node --experimental-strip-types scripts/simulate-scale.mjs
node --experimental-strip-types scripts/simulate-scale.mjs 100   # one size only
```

Watch desk snapshot latency and CSV import time. Regressions here show up before
a PM feels slowness on a real book.

---

## Live debug — desktop app (needs worker)

HTTP scripts do **not** replace this. Launch RealBud (`pnpm dev:desktop` or the
packaged build) and walk one real morning with the pinned worker attached.

### Before you start

1. Wipe or use a dedicated profile: `REALBUD_DATA_DIR` or a fresh user account.
2. **You → Attach model** — key on You only, never in Ask chat.
3. **Test hands** — `ready` stays false until ping OK (`hands-ping.json`).
4. Confirm pack: manual approvals, workroom-ready, pin matches installed worker.

### Happy path (15 min)

| Step | Where | Pass criteria |
|------|-------|----------------|
| 1 | Desk | Training book loads; Held chip honest |
| 2 | You → Recheck | Worker returns ledger JSON or honest miss; no fixture bleed into live |
| 3 | Desk | Morning cards land after evaluate; Copy works; **Send 403** |
| 4 | Desk | Allow one courtesy → disclaimer sticks; Deny removes card |
| 5 | Ask | “Put courtesy on Oak” → staged card on Desk; Allow fills book |
| 6 | Schedule | Morning routine uses same Recheck door as Desk (not a bot turn) |
| 7 | You | Eight office fields save; **Demo Book name does not turn green** |

### Exception path (10 min)

Replay what `e2e-pm-exceptions.mjs` covers in the UI:

- **Edit** after Allow — disclaimer still on card
- **Stale Allow** — second Allow on old revision → 409
- **Notes** — hostile note cannot change evaluate or unlock `never`
- **Money holds** — partial / unmatched CSV row stays held
- **Pause loop** — morning routine stops firing until resumed
- **Recipe** — shadow card needs plan approval before clock runs it

### Run beside me — live smoke (needs macOS, desktop helper, attached model)

HTTP scripts do **not** replace this. Packaged or `pnpm dev:desktop`.

1. Create a saved job — Schedule → Give Bud any recurring job, or say it in Ask ("log in to … and complete the routine").
2. Approve the plan (Schedule or You → Bud's jobs).
3. **Attach this site** — acknowledge: you sign in; Bud reads and prefills; Submit, Pay and Send stay with you.
4. Press **Run beside me**. Ask opens. Sign in when the page asks.
5. Answer Allow cards (Allow once / Allow for this task).
6. Save a site rule from the card — third choice **Always allow reading on {origin}**. Confirm the next on-origin read does not ask (receipt tags **allowed by rule**).
7. Try a password field — fence must say exactly: `You sign in yourself — Bud never types a password.`
8. Try a Pay button — fence must say exactly: `Submit, Pay and Send stay with you.`
9. With **Bud may press Submit** still off, a Submit click must say exactly: `This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.`
10. Turn on **Bud may press Submit** on the job card. A Save/Submit click must ask with exactly: `Bud wants to press '{label}' on {origin}. Check the form in the browser first.` Buttons: Allow this Submit / Deny / Stop this turn — no “Allow for this task”, no site-rule choice. A Pay click is still denied with `Submit, Pay and Send stay with you.`
11. Finish. Receipt says **Done · read back from {site}** only when the last assistant text names an allowed origin and a read-back word. Otherwise **Unknown — check the site yourself**. Never "done" on a miss. Allowed Submit lines tag **Submit pressed with your approval**.
12. Schedule the job. The clock must produce **Ready beside you** + **Start beside me** (detail `Ready to run beside you — press Start when you are at the screen.`) instead of launching a browser. Start calls `POST /api/recipes/:id/attend { runId }`. Not attached/approved: `Attach the site and approve the plan to run this beside you.`

Off-origin navigate must say `That site is not on this job.` Ad-hoc Ask browsing with no saved job: `Only sites named in a saved job. Ask Bud to set the routine up as a job first.`

### What to log when something breaks

Capture (no secrets in tickets):

- Exact button / card / property id
- Visible detail line (worker miss, hold reason)
- `GET /api/hermes` body: `cli`, `pack`, `ready`, `detail`
- `GET /api/desk` revision + one draft id
- Whether Recheck or routine triggered the worker
- OS, worker version, model provider (not the key)

Data dir (if safe to share): `~/.realbud/desk.json`, `hands-last.json`,
`hands-ping.json` — redact tenant phone and draft body.

---

## Worker failure matrix

Plain language the PM should see — if UI shows a stack trace or raw errno, file a bug.

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Recheck → “CLI not found” | Worker not on PATH (Finder launch) | Install pinned worker; restart app |
| “installed X, pin is Y” | Version mismatch | Reinstall pinned commit from You |
| “pack is missing” / not manual approvals | Property pack not applied | You → apply pack |
| “Worker took too long” | Model slow or billing | Retry; check provider credits |
| “Billing or credits exhausted” | Provider 402 | Top up or swap model on You |
| Partial ledger, properties held | Worker omitted ids | Honest hold — do not copy Demo values |
| `ready: false` after install | Test hands not run | You → Test hands until OK |
| Demo Recheck looks “finished” with miss | Bug — should say Missed | See worker honesty tests |
| Attend 409 `Approve the plan first.` | Plan not approved on this revision | Approve the plan, then retry |
| Attend 409 `Attach this site first: you sign in, Bud reads and prefills, Submit, Pay and Send stay with you.` | No Attach acknowledgement | Attach this site on the job card |
| Attend 409 `Add the portal site to this job before running it beside you.` | No origin or no portal capability | Name the site and a portal capability |
| Attend 409 `Bud can drive a browser only on this Mac with RealBud's desktop helper running.` | Not darwin, or helper down | macOS + desktop helper |
| Attend 409 `This job already has work waiting or running.` | Overlap | Wait or Stop, then retry |
| Attend 409 `Bud is busy with another turn. Stop it or wait, then run again.` | Ask turn in flight | Stop, then Run beside me |
| Attach 409 `Add the portal site and a portal capability before attaching it.` | Bare job | Add origin + `portal-read` / `portal-prefill` |
| Submit click `This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.` | Job has no `portal-submit` acknowledgement | Open the job card disclosure and turn it on (needs the capability) |
| Submit PATCH 409 `Add 'Bud may press Submit' only on a job with the portal-submit capability.` | Acknowledgement without capability | Add `portal-prefill` + `portal-submit` (and an origin) first |
| Rules POST 400 `Portal rules can only allow.` | Deny posted as a portal rule | Portal rules are allow-only; revoke instead |
| Rules POST 400 `surface must be portal-read or portal-prefill` | Submit / other surface posted as a rule | Submit is never a rule |
| Clock skip `Attach the site and approve the plan to run this beside you.` | Scheduled portal job not attached or not approved | Approve + Attach, then wait for the next tick |
| Activity **Ready beside you** / Start beside me | Clock queued an attended run | Press Start beside me at the screen — do not expect Chrome to open by itself |
| Activity **Not started — waited a day** / detail `Not started — the run waited a day for someone at the screen.` | Queued attended run older than 24 h | Start a new run; the missed receipt stays |

---

## Phone channel smoke (Telegram / Discord / Slack)

Not Pocket. Same Bud, same book — remote Allow/Deny for courtesy wording only.

1. **You → Phone** — compact Available roster: connect Telegram, Discord, or Slack
   (bot token; Slack may also take an optional `xapp` Socket Mode token). DM the
   bot once to pair. Later rows (WhatsApp / Teams / SMS) stay non-interactive.
2. Desk chrome shows `Phone · Telegram` (or Discord / Slack) when paired.
3. Recheck so a courtesy card lands in Now.
4. On the phone: reply `allow` (or Discord button). Desk toast / case footer shows
   `Allowed via …`.
5. Copy still happens on Desk; RealBud never sends.
6. Licensee cards must not get phone buttons — open Desk when at a screen.

Unit coverage: `server/remote-decisions.test.ts`, `server/channels-telegram.test.ts`, `server/pulses.test.ts`, `src/lib/phone-label.test.ts`.

---

## Gates we do not open in QA

These need eight real fields on **You → This office** (`docs/PILOT-CONTRACT.md`):

- Inbound mail (IMAP / Graph)
- PropertyMe API / Pocket
- Ask proposes clock change (PR C)
- Graduate double-click installer (Windows stays CSV-only until bundled)

**2026-09-02:** live portal is no longer in this list. Attended saved-job
runs ("Run beside me") need plan approval + Attach on this Mac with the
desktop helper — smoke above. Do not rebuild a visit gate for them.

QA proves the **training appliance** is honest. The visit unlocks inbound,
Pocket, and the installer.

---

## After a visit (when office is named)

1. Re-run full battery on a profile with real agency name typed.
2. Vendor-test portal — human Submit once before any live CUA.
3. Retention / privacy (`T15`) if disk comes up on the visit.
4. Only then: inbound triage or installer — one item, one PR, tests first.

---

## Related tests (unit focus)

When changing gate or persist code, run targeted vitest first:

```bash
pnpm exec vitest run server/gates.test.ts server/desk.test.ts server/desk-v3-matrix.test.ts
pnpm exec vitest run server/hermes-hands.test.ts server/hermes-status.test.ts
pnpm exec vitest run server/channels-telegram.test.ts server/channels-discord.test.ts
pnpm exec vitest run server/import-inspect.test.ts server/law-watch.test.ts
pnpm exec vitest run server/portal-fence.test.ts server/attended-run.test.ts server/portal-job-intent.test.ts server/recipes.test.ts
pnpm exec vitest run src/lib/job-run.test.ts src/lib/ask-next.test.ts
```

Do not rebuild shipped rows listed in `docs/NEXT-WAVE.md`.
