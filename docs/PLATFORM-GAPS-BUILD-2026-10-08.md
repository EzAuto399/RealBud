# Platform gaps build — 7–8 October 2026

**What this does not establish:**
- No real-model eval baseline: the dev key isn't issued yet.
- No live Composio webhook: the gateway isn't deployed.
- No real Telegram or Discord tap.
- No office-host or customer acceptance.
- No installed-device run of 0.1.37 yet.

Evidence below is local tests and fictional QA, plus a GitHub Windows runner for Electron 44, unless stated.

Plan and owner decisions: [Platform gaps plan](PLATFORM-GAPS-2026-10-07.md). Approval design: [Approval settings spec](APPROVAL-SETTINGS-SPEC-2026-10-07.md); its section 0 overrides the rest.

## What shipped to main

| PR | What now works |
|---|---|
| #145 | Every job run and Ask turn records its Modelvia request ids. Opening a run shows its cost from Modelvia receipts: withheld → "not priced", unsettled → "pending", partial → "cost unavailable". Wholesale is never shown. |
| #146 | One handler registry (`shared/workflow-catalog.ts`) replaces the per-loop if-chain. A signed pack recipe may carry a `{time, weekdays}` schedule; it installs as a shadow and waits for plan approval. |
| #147, #149 | Composio trigger webhooks. The gateway verifies the signature (UTF-8 secret, per-office hashed secret name), stores ids only, and lets devices pull through cursors scoped to the office. Morning priorities can also run when new mail arrives (usually within 15 min); the morning run still happens. |
| #148 | `scripts/eval-golden.mjs`: six Austin tasks with deterministic graders and hard safety checks. Fake control arm: perfect answers pass, bad answers fail with 7 named safety failures. |
| #150 | Bud proposes workflow schedule changes on a before → after card. It never switches a loop on, never moves the agency-setup clock, and a stale revision is refused. |
| #151 | Phone decisions are accepted only from the paired person in a private chat (Telegram, Discord, Slack). Group or legacy pairings get a view-only nudge. |
| #152, #156 | Per-department approval settings: storage, who may change them, enforcement wherever Bud acts, a Workspace → Approvals screen, card buttons, "Bud is waiting on you", Bud's approval card, and phone approval of live tool cards. |
| #153 | Electron 44.6.0, React 19.3.0, pg 8.23.1. cua-driver stays at 0.19.3. |
| #154 | Eight fixes from Astra's review: trigger replay, cursor binding, shared trigger, office ids, expired-Gmail switch, partial cost, eval gate, eval cleanup. |
| #155 | The bank QA scripts open the hidden-when-off job by deep link. |

## Approval contract as built

- With nothing saved, every decision equals today's. Table tests cover 880 to 2,160 decisions.
- Deny wins over saved rules and task grants.
- Pay, sign, send, notice, account change, delete, upload, submit, memory and scripts stay per-instance. Operations are classified by what the tool does.
- A website's "Read without asking" covers read-only actions only.
- Approved scheduled jobs ignore a site's "Ask every time" but obey "Don't use".
- Bud never widens an app or connector row.
- Phone: reads, Gmail drafts and labels, and full-message managed mail sends only. Everything else is desktop-only, with no amounts or recipients.
- An office desktop that can't verify department policy asks first, then refuses to dispatch after approval until the policy can be checked.
- Approving re-reads the settings first, so a "Don't use" saved meanwhile wins.

## Reviews

- Astra 6 Ultra reviewed the spec, then the code twice, then re-checked the fixes.
- Every P1 was reproduced with a failing test before it was fixed.
- The commit security reviews found two issues, both fixed: the shared webhook secret namespace and cross-office event counts in #147, and the approval-card scope mismatch in #156.

## Gates (outputs/gate-2026-10-08-batch1…6)

- **Final tree before the release bump:**
  - typecheck, server tsc and check:electron pass.
  - vitest: 9657 passed / 0 failed / 330 skipped. The skips are the Postgres-gated suites, which did not run.
  - Gateway: 425/425.
- **GUI sweep on main before the approvals merge:**
  - 21 scripts pass, including qa-austin-showcase 8/8, qa-rei-refresh 12/12 and chaos 14/14.
  - The 2 bank scripts were fixed in #155.
  - qa-shell-purpose was not run: no baseline exists.
- **qa-approvals:** 13/13 on the integration commit.

## Held, with reasons

- **cua-driver 0.34:** releases 0.25–0.33 change click delivery and AX targeting, which REI reads rely on. It needs its own live macOS run after the showcase.
- **Dev-tool majors** (vite 8, vitest 5, TypeScript 7): deferred until after the showcase.
- **Not yet counted in per-run cost:** morning arrears, batches, recipe-distill, and Jev calls.

## Needs the owner

1. Issue a capped Modelvia dev key (US$150/month) as a file only you can read. The baseline eval run follows.
2. Gateway deploy with `REALBUD_COMPOSIO_WEBHOOK_BASE_URL`, plus a per-office subscription. Only needed when live new-mail triggers are wanted.
3. Re-pair phones from a private chat to approve from the phone.
