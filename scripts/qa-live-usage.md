# `qa-live-usage.mjs` — real-time usage, end to end, against a local Modelvia

    pnpm qa:live-usage

One command boots Modelvia from its own branch source, boots our managed
gateway against it, provisions a fictional installation, spends one request,
reads it back through the usage surface our desktop card uses, and revokes.
It writes `outputs/live-usage-<date>/receipt.json` and exits non-zero on the
first failed step, naming that step first.

## What it needs

- Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`). Run it with `pnpm`, not
  `npm`, so the repo's own script entry is used.
- A Modelvia checkout at `/Users/yoda/projects/modelvia` whose
  `managed-gateway/node_modules` is installed. The script never checks that
  repository out in place: it adds a **detached** worktree of
  `codex/neon-release` in a temp directory, symlinks the sibling checkout's
  `node_modules` into it, and removes the worktree when it finishes.
- Ports 18971 (Modelvia), 18972 (our gateway) and 18973 (the fictional Composio
  endpoint) free on loopback.

No network, no provider account, no database server, no built package.

## Environment overrides

| Variable | Default | Use |
|---|---|---|
| `REALBUD_QA_MODELVIA_REPO` | `/Users/yoda/projects/modelvia` | Modelvia checkout to take a worktree from |
| `REALBUD_QA_MODELVIA_BRANCH` | `codex/neon-release` | branch to check out detached |
| `REALBUD_QA_MODELVIA_WORKTREE` | *(unset)* | reuse an existing worktree instead of creating one; it is then **not** removed |
| `REALBUD_QA_MODELVIA_PORT` / `REALBUD_QA_GATEWAY_PORT` / `REALBUD_QA_COMPOSIO_PORT` | 18971 / 18972 / 18973 | loopback ports |
| `REALBUD_QA_OUT` | `outputs/live-usage-<today>` | receipt directory |

Re-runs are idempotent: each run uses a fresh temp workspace, a fresh SQLite
ledger for both gateways and a fresh `qa-<uuid>` installation id, and it
rewrites `receipt.json` in the dated output directory.

## The nine steps

1. **modelvia-worktree** — detached worktree of the branch; records the commit.
2. **modelvia-boot** — Modelvia's own `managed-gateway/server.ts`, SQLite
   ledger, `PLATFORM_ROUTING_MODE=fixed`, one reviewed route in an
   operator-written catalogue file.
3. **modelvia-seed** — through Modelvia's operator HTTP API only: billing
   account, rate card, rate acceptance, client `realbud-qa`, customer
   `fictional-office`, and one client integration key.
4. **fake-composio** — a loopback stand-in for the Composio organisation
   surface (`list` and `create` only).
5. **realbud-gateway-boot** — our `managed-gateway/server.ts` with
   `REALBUD_ENABLE_PROVIDER=1`, `REALBUD_MODELVIA_BASE_URL` pointed at the local
   Modelvia, a temp `REALBUD_GATEWAY_SECRETS_DIR` and a temp connector registry.
   Our ledger tenant is seeded first, because provisioning reads its caps.
6. **provision-installation** — `POST /v1/portal/installations/provision`.
   Asserts one `rbk_` key, that the Modelvia project `rb-qa-…` exists under the
   seeded customer with our ledger caps applied, and that a repeat call
   re-issues no secret.
7. **completion-no-idempotency-key** — `POST /v1/chat/completions`, `model:
   "auto"`, **no** `Idempotency-Key` header. A settled receipt is read back from
   `GET /v1/requests/<id>`. A documented provider-unavailable outcome is also
   accepted, but the request must still appear in the ledger.
8. **analytics-counts-the-request** — `GET
   /v1/client/customers/fictional-office/analytics` with the client key, then
   the same document through our own `website/lib/platform-analytics.ts`
   projection and `installationUsageSummary` reducer. Asserts the desktop card
   shape and that no wholesale field or key leaked into it.
9. **revoke-refuses-further-usage** — revoke through our gateway, then a second
   completion with the same key must be refused (401/403) and analytics must not
   grow.

## What a green run does not prove

Read `limits` in the receipt. In short: local Modelvia only (nothing hosted),
**no real model provider** — the pinned DeepSeek endpoint is answered in-process
by a fictional upstream module supplied on Modelvia's command line — a fake
Composio organisation, fictional identities throughout, no Hermes worker, no
desktop render, no money and no customer. A fictional provider is never evidence
that a real one was exercised.
