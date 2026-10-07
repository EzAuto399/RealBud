# Platform gaps plan — 7 October 2026

**What this does not establish:** this is a plan built from read-only source surveys, and no code from it is merged. There is no packaged, installed, live or customer evidence for any item. Competitor facts come from public docs and source as of 7 October (Gumloop docs, bops site and `nickvasilescu/bops` source). bops is FSL-licensed, so we take ideas from it, never code.

## Why

On 7 October the owner compared RealBud with Gumloop and bops. Five gaps came out of it, each with the owner's direction:

1. **Event triggers.** Use Composio's webhook feature.
2. **Evals.** Check them, move to the latest versions, and test and tune before trusting the results.
3. **Workflows defined in packs.** Fix and improve.
4. **Per-run cost.** Test and check it.
5. **Approval settings.** Do it, with the overall design and usage planned first.

**Keep (where we're ahead):**
- Runs survive restarts and requests are idempotent, with missed runs recorded. bops fails tasks and drops approvals on restart.
- Each risky action gets its own approval showing the real recipient and amount, with no classifier auto-approval.
- Credentials never pass through Bud.
- Packs are signed.
- Custom connectors are quarantined when their tools change.
- Data stays local, and the product goes deep on one industry.

**Don't copy:**
- Gumloop's flow canvas, which Gumloop itself now lists as "Workflows (Legacy)".
- bops' classifier approving actions.
- A cloud computer per bot.

## P1 — Per-run usage and cost (building)

**Design:**
- Both model relays (`server/ask-model-relay.ts` and the relay in `server/department-worker.ts`) record the Modelvia request ids from `X-Request-Id`, plus the call count.
- Token counts are recorded only when the body is unstreamed JSON.
- Usage is saved on `JobRun` and on the Ask history entry. A loop run shows the cost of its linked JobRun.
- When someone opens a run, a session-gated route reads `GET /v1/requests/{id}` receipts.
- Modelvia is the only price source:
  - `withheld` shows "not priced", never A$0.
  - An unsettled retail charge shows "pending".
  - Wholesale and margin are never shown.

**Known gaps:**
- Morning arrears has no JobRun.
- Usage from `batches.ts` and `recipe-distill.ts` is not counted.
- Streamed replies carry no token counts (ids only).
- Jev calls belong to no run.

## P2 — Golden evals and current versions (building)

**Versions on 7 October:**
- **Hermes:** 0.21.5 is the newest tag (v2026.9.24). Its own gates are still open (`HERMES-0.21.5-EVIDENCE.md`). Unreleased `main` carries security and usage fixes to take at the next tag.
- **Behind:**
  - electron 43.7.5 → 44.6.0
  - @trycua/cua-driver 0.19.3 → 0.34.0
  - react 19.3
  - pg (patch)
  - dev-tool majors: vite 8, vitest 5, @vitejs/plugin-react 6, TypeScript 7
- **Models:** `deepseek-v4.1-flash` and `claude-sonnet-5.5` are both current.

**Harness:** `scripts/eval-golden.mjs` runs at least six Austin tasks through the real server and worker.
- Deterministic graders run first.
- Hard safety checks: no unapproved effect or send, and no invented person or amount.
- Every trial uses a fresh scratch data dir and Hermes home.
- A fake-ACP control arm proves the graders score 100% on perfect output and 0% on bad output.
- The live arm needs `REALBUD_EVAL_MODEL_KEY`.

**Gate for any Hermes or model change:** pass all of the following over 3 trials, plus the existing ACP smoke, packaged-upgrade and Windows gates.
- zero safety failures
- deterministic pass rate at or above baseline and ≥ 90%
- no task drops by more than 1 of 3 trials
- cost per task ≤ 1.25× baseline

**Order:**
1. Harness.
2. Baseline on the current pin.
3. Upgrade one dependency at a time, each gated.

## P3 — Workflows defined in packs (steps 1–2 building)

1. **Step 1:** a signed pack recipe may carry a schedule. It imports as a shadow and waits for plan approval.
2. **Step 2:** `EVALUATOR_CATALOG` becomes the handler registry for all nine loops and `recipe`.
   - It replaces the if-chain in `server/index.ts`, checking each spec (including `mayLaunchCua`) before dispatch.
   - It also replaces the hard-coded id lists.
   - Behaviour is unchanged.
3. **Next:**
   - Declared loops in `office/settings.json`, which name an allowlisted `evaluatorId` and arrive off.
   - Recorded in the installation journal so rollback removes them.
   - A Bud `loop_schedule` settings target with `expectedRevision`.
   - The signature, arrive-off and `never` rules stay at the boundary.

## P4 — Event triggers through Composio (gateway side building)

**Facts:**
- One webhook subscription per Composio project, so one per office.
- Signature: HMAC-SHA256 over `id.timestamp.body`, with 300 s tolerance.
- Delivery is at-least-once.
- **Gmail triggers poll, with a 15-minute minimum on Composio-managed auth.** Faster polling needs our own Google OAuth client.

**Design:**
1. The gateway route `/v1/webhooks/composio/{companyId}` verifies each event and checks the trigger id against that office's registry. It stores ids only, never subject, sender or body.
2. The desktop pulls with `POST /v1/connectors/events {after}` about every 60 s and starts the mapped loop through `runNow`. The request id is derived from the webhook id, so a duplicate never runs twice.
3. The gateway alone creates and disables trigger instances.
4. The clock schedule stays the completeness guarantee; events only cut latency.
5. The desktop side follows P3, because both touch `server/index.ts`.

**Operator steps:**
- Deploy the gateway.
- Set the base URL.
- Create the per-office subscription.
- Read `GMAIL_NEW_GMAIL_MESSAGE` once, read-only, to confirm its config.
- Get the customer's go-ahead before any live Gmail trigger.

## P5 — Approval policy and design (decisions first)

**Today:**
- Connected-app reads run without a card; reviews get a card on every call.
- Direct connections card even reads.
- Connected-app cards are once-only.
- Browser pay, sign, send, notice and account-change actions are asked every time, with facts from the page.
- Site rules cover read, navigate, fill and download, but never submit.
- Custom connectors already have a per-tool policy.

**Approval fatigue:**
- one card per read on direct Gmail
- misclassified reads that can never be widened
- non-read-only browser tasks ask on every navigate
- cards that show raw JSON

**Proposal:**
- **Per tool or app group:** Allow, Ask, Ask for writes (recommended) or Deny.
  - A setting can always make a tool stricter.
  - It can widen to Allow only tools already classed as reads.
  - Read scopes are once, this task, or always (a revocable rule).
- **Always per instance:** pay, sign, send, notice, account change, Trash, upload, submit, memory writes, consequential custom tools, settings changes, scripts.

**UI:**
- Workspace → Approvals replaces "Bud's rules", with locked rows and "Reset to recommended".
- Scope buttons on the card.
- Bud gets an `approval_policy` settings target. It may propose anything stricter, but widens reads only, listing each tool.
- The right panel counts live tool cards.

## Owner decisions (answered 7 October)

1. **Who changes approval policy:** each person leads their own department, so policy is per department. Anyone with **edit** on a department sets that department's approval settings, reusing the existing read/edit/none department scope with no new role. The owner sees every department and can reset to recommended. Every change keeps a before/after receipt. On a single desktop with no departments, the owner sets it.
2. **Phone approvals: yes.**
   - Hermes has `/approve` (once, session or always) only in its own messaging gateway, which RealBud does not run, because Hermes stays headless.
   - RealBud's Telegram channel already sends Allow/Deny buttons for three Desk draft kinds (`server/remote-decisions.ts`). We extend that to live tool cards, borrowing Hermes' once/session pattern.
   - **v1 scope:** reads, in-app writes, and sends with the full message shown on the card. Pay, sign, notice, account change and policy changes stay desktop-only.
3. **Eval budget:** a capped dev Modelvia key at **US$150/month**. The owner issues it; the runner reads it from `REALBUD_EVAL_MODEL_KEY`.
4. **Gmail trigger speed:** 15 minutes on Composio-managed auth is fine. No own Google OAuth app.
5. **Still open:** retire `DESIGN.md:128` ("never offer always-allow"), which site rules already contradict.

## P6 — Approve from the phone (after P1 and P3 merge)

- Extend `server/remote-decisions.ts` and the channel adapters so live tool cards travel as buttons.
- Each card carries:
  - a fingerprint, so a stale card is refused;
  - one decision per card;
  - the paired-key check;
  - the full facts: tool, account, recipient and message text.
- Decisions come back through the same approval path as the desktop, never a side door.

## Sequencing against the 9 October showcase

- P1 and P2 are additive. Merge them after the local gate.
- Merge P3 step 2 (the dispatch refactor) and P4 only after the showcase, unless the full gate and a Windows targeted run pass first.
- Upgrades (Electron 44, cua-driver 0.34) wait until there is an eval baseline.
