# QA and live debug

Date: 2026-08-31  
Canonical constraints: `docs/GOAL-PROMPT.md` wins.  
Weekday map: `docs/PM-DAY.md`. Pickup list: `docs/NEXT-WAVE.md`.

RealBud is in a **QA and live-debug phase**. The graduate path is walking the
same book as a morning — not adding surfaces ahead of a named office.

---

## Daily regression (no worker, no mail, ~3 min)

Run before any Desk UI change or before a visit demo:

```bash
pnpm typecheck
pnpm test
node scripts/qa-e2e.mjs
```

Quick gate (desk + exceptions only, ~1 min):

```bash
node scripts/qa-e2e.mjs --quick
```

Individual suites (each uses its own temp home and port):

| Script | What it proves |
|--------|----------------|
| `scripts/e2e-desk.mjs` | Desk CRUD, send 403, loops, hands status |
| `scripts/e2e-pm-day.mjs` | Happy weekday: clock, practice Allow, Ask→Desk, Friday letter, CSV, office fields |
| `scripts/e2e-pm-exceptions.mjs` | Messy day: Deny/Edit/stale Allow, evaluate matrix, money holds, notes isolation, pause, recipe gate, rules, law watch flag |
| `scripts/e2e-walkthrough.mjs` | Partner demo + fake portal + recovery |

CI runs the full battery on Ubuntu after unit tests.

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

---

## Gates we do not open in QA

These need eight real fields on **You → This office** (`docs/PILOT-CONTRACT.md`):

- Inbound mail (IMAP / Graph)
- Live portal / PropertyMe API / Pocket
- Ask proposes clock change (PR C)
- Graduate double-click installer (Windows stays CSV-only until bundled)

QA proves the **training appliance** is honest. The visit unlocks the next wave.

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
```

Do not rebuild shipped rows listed in `docs/NEXT-WAVE.md`.
