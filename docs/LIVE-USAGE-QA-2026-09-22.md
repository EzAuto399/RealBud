# Live usage QA against a local Modelvia branch — 22 September 2026

Proof layer: **`local-modelvia-branch`**. Everything below ran on loopback from
source. No hosted Modelvia, no real model provider, no customer.

Command: `pnpm qa:live-usage` (Node 24; `source ~/.nvm/nvm.sh && nvm use 24`).
Script and how-to: `scripts/qa-live-usage.mjs`, `scripts/qa-live-usage.md`.
Receipt: `outputs/live-usage-2026-09-22/receipt.json`.

## What was proven

A RealBud installation can be provisioned at Modelvia, spend a real request
through the served OpenAI-compatible endpoint, have that spend appear in the
customer usage surface our desktop card reads, and lose access on revocation —
with our gateway's own `managed-gateway/server.ts` talking to Modelvia's own
`managed-gateway/server.ts` over HTTP.

| Step | Outcome |
|---|---|
| `modelvia-worktree` | detached worktree of `codex/neon-release` |
| `modelvia-boot` | Modelvia's own server, SQLite ledger, fixed routing, one reviewed route |
| `modelvia-seed` | billing account, rate card + acceptance, client `realbud-qa`, customer `fictional-office`, client key — all through its operator HTTP API |
| `fake-composio` | loopback stand-in for the Composio organisation surface |
| `realbud-gateway-boot` | our gateway, `REALBUD_ENABLE_PROVIDER=1`, provisioning composed |
| `provision-installation` | project `rb-qa-…` exists under `fictional-office` with our ledger caps; one `rbk_` key issued once; repeat call re-issued nothing |
| `completion-no-idempotency-key` | `POST /v1/chat/completions`, `model: "auto"`, **no** `Idempotency-Key` header → 200, receipt `settled` |
| `analytics-counts-the-request` | client-key analytics counted it; `installationUsageSummary` produced the desktop card shape with no wholesale field or key in it |
| `revoke-refuses-further-usage` | revoke → next completion 401 `key_revoked`, analytics unchanged |

Two things the branch carries that this run confirms in practice:

- `Idempotency-Key` really is optional on `/v1/chat/completions`. Without the
  header Modelvia derives one from the caller's key and the canonical body
  inside a 15-minute bucket, so an SDK resend returns the original receipt
  rather than dispatching a second paid request.
- Caps live on the Modelvia **project**, not on the key. The project our
  gateway creates carries the ledger tenant's monthly and per-request caps, so
  revoking a key leaves the billing history and its ceilings in place.

## Limits — what a green run does not prove

- **No hosted Modelvia.** It ran from a detached git worktree on loopback.
  Nothing was deployed and `api.modelvia.dev` was never contacted.
- **No real model provider.** Modelvia pins its direct-provider endpoints in
  source, so the run supplies a fictional upstream module on Modelvia's command
  line that answers that one URL in-process. No third party was contacted and no
  model ran. A fictional provider is never evidence that a real one works.
- **No Composio.** The organisation surface was a local fake with `list` and
  `create` only. No project, no OAuth credential and no real `ak_` key exist.
- **Fictional identities only.** Company, licence, client, customer, rate card,
  operator and portal principals are invented for the run. None of this is
  customer evidence, and the invented rates say nothing about real prices.
- **No worker, no UI, no money.** No Hermes worker, no desktop app, no browser.
  The desktop card was checked by running the reducer, not by rendering a
  screen. No payment surface was exercised.
- **Dependencies were reused**, not installed fresh: the worktree symlinks the
  sibling checkout's `managed-gateway/node_modules` instead of running `npm ci`.

## Remaining gates, unchanged by this run

Hosted Modelvia commissioning, an approved provider catalogue with real terms, a
real Composio organisation key in vendor-only custody, real customer bindings,
and supervised customer acceptance. See
`docs/BUSINESS-DESKTOP-2026-09-21.md` for the current proof and gate list.
