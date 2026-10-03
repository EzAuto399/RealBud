# Office PA capabilities and Hermios integration — checkpoint, 2 October 2026

**What this does not establish:** no packaged build, installed device, live integration (Modelvia, Composio/Gmail/Outlook, Hermios, real websites or portals) or customer acceptance. Everything below is **source + local tests** unless marked. All changes are uncommitted in the shared checkout alongside other sessions' work.

Decisions: `docs/decisions/2026-10-02-bud-office-pa-access.md`. Plans: `docs/HERMIOS-ECOSYSTEM-PLAN-2026-10-01.md`, `docs/HERMIOS-PLANS-AND-CHECKOUT-2026-10-01.md`, `docs/UX-REDESIGN-BRIEF-2026-10-01.md`. Hermios side: `hermios-realbud-modules/docs/REALBUD-PARTNER-PROVISIONING-STATUS.md`.

## Built

| Area | What | Key files | Local tests |
|---|---|---|---|
| Model choice applies in Ask | Loopback relay injects `reasoning_effort`; office key no longer in the Ask worker; overlay tamper detection retires workers; `/models` passthrough keeps context length | `server/ask-model-relay.ts`, `server/drivers/acp/hermes.ts`, `server/hermes-runtime-env.ts` | relay + acp 178 passed / 3 gated skipped; native context check 3/3 |
| Long turns | Wrap-up notice at 75% of turn budget via Hermes `/steer` | `server/drivers/acp/core.ts`, `server/product-mode.ts` | 162 passed |
| Hermes worker settings | execution guidance, intent continuation, loop hard stop, compression, child timeout, curator off, direct todo/session_search/process tools, vision on Sonnet, 6 bundled + 5 staged skills | `pack/property/config.yaml`, `server/hermes-pack.ts`, `pack/property/skills/*` | 253 passed |
| Word/Excel/PDF | Hash-pinned libraries installed into Bud's runtime on setup/Repair; status `documentTools`; "needs Repair" line | `server/hermes-document-deps*.{ts,json}`, `server/hermes-status.ts`, `src/components/BudSetupCard.tsx` | 87 + 62 passed; real install in scratch venv on this Mac |
| Learning | Auto-keep short writing-style notes (closed vocabulary), off by default, admin switch outside worker storage, sticky Undo | `shared/learning-policy.ts`, `server/learning-auto-keep.ts`, `server/hermes-memory-review.ts`, `MemoryReviewPanel.tsx` | 320 passed |
| Mailbox | Full Gmail/Outlook toolkit; send/reply/forward/trash per-message card; draft re-read and cross-thread hold; shared mailbox read-only until owner grant | `shared/app-tool-policy.ts`, `server/connected-apps-broker.ts`, `managed-gateway/connectors.ts`, `managed-gateway/office-mailbox.ts` | 577 + gateway 368 + website 358 |
| Calendar | Reads free; create/update/move carded; delete/cancel/decline blocked | `shared/app-tool-policy.ts` | included above |
| Read a page | Person-pasted links only; SSRF pin; ports 80/443; untrusted markers | `server/web-research-broker.ts` | included in 445 below |
| Reminders | Desk reminders + Bud `set_reminder` | `server/reminders*.ts`, `src/components/desk/RemindersPanel.tsx` | 117 passed |
| Views via Bud | `views_*` tools with confirm card; sidebar refresh event | `server/workspace-views-broker.ts`, `src/lib/workspace-views-refresh.ts` | 199 passed |
| Browser tasks | Submit (consequential → card), download (private, executable refused), upload (this thread's attachments only, carded) | `server/native-browser-runtime.ts`, `server/browser-*.ts` | 293 passed / 5 Windows-only skipped |
| Hermios | Desk tab (isolated embedded web), native OAuth connection, read tools, reviewed writes (stage/status, note, task + link) with idempotency keys, `_meta` attribution, per-record workspace lease, modules v2 | `electron/hermios-view.mjs`, `src/components/desk/HermiosTab.tsx`, `server/hermios-*.ts`, `server/crm-record-lease.ts` | 445 passed |
| Hermios plans (paused, Square last) | Catalog (A$129 Office pack etc.), Square catalog setup script | `managed-gateway/hermios-*.{ts,json}` | 16 passed |

**Installed-device result (reported by the Workspace session, 2 Oct, owner's Mac, 0.1.28 over 0.1.27 after a backup):** on boot the automatic setup re-applied the pack through the reviewed repair path (`workroomReady` true, `documentTools` ready — the hash-pinned document libraries installed on the real runtime), ran the readiness check, and `GET /api/hermes` reported `ready: true`. Full source suite before that build: 7740/7740. This is installed-device evidence for the upgrade path and document tools only; the Ask relay, mailbox, Hermios and browser changes are not yet exercised live.

The server boots from source (`node --experimental-strip-types server/index.ts`, `/api/health` 200).

## Open

- Live proof: one Ask turn through the relay; connect Hermios; one reviewed CRM write; one self-addressed email.
- CRM write auto-resume after restart (receipts exist; resume not built). Cross-device record lease (company Postgres).
- Gmail send through RealBud's own Google client needs a restricted `gmail.send` scope (owner decision; Google review).
- Web search: deferred by owner.
- Hermios release gates (owner): AGPL §13 source offer before network deployment; isolated PostgreSQL and HTTP tests; production `IS_MULTIWORKSPACE_ENABLED=true`, `IS_BILLING_ENABLED=false`; partner credential via secret manager.
- Square subscriptions, webhooks and console checkout (paused by owner; design prototype in `outputs/hermios-plans-design-2026-10-01/`).
