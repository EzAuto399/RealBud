# Computer cap, office key enforcement, per-computer usage (2026-10-04)

Evidence tier: **source + local tests + scratch-build browser run on fixture data.** Nothing committed, migration unapplied, no live Modelvia or customer account touched.

## What changed
- **Five computers per office.** `website/supabase/migrations/202610040001_installation_cap.sql`: `realbud_installation_limit()` = 5; `realbud_installations_held()` counts active rows plus pending revocations. Issue and redeem both refuse with `installation_limit`. Redeem takes the company lock only in its insert branch, after the pairing row lock; this fixed a proven cancel/approve deadlock. The Computers page shows "N of 5" and an aria-disabled Pair button with the reason.
- **Office key binding, gateway.** `managed-gateway/provisioning.ts` `requireCustomerBound` fails closed. Provision, redeliver and re-cap need an explicit office↔customer binding (`office_customer_unbound` 409, `modelvia_customer_not_bound` 403). `bindOfficeCustomer` refuses a move while live installations sit under the old customer (`office_customer_rebind_has_installations`). Revoking a `pending` provision becomes a durable cancellation that finds and revokes any `rb-<installationId>` key after 10 minutes.
- **Office key check, desktop → website.** `server/office-link.ts` reports `modelKeyId` only when the vault really holds the key, `modelKeyRejected` after a Modelvia 401/403 (`server/ask-model-relay.ts`), and honours 429 Retry-After (capped at 1 h). The website records the provisioned or rotated id (`realbud_record_model_key`) and the reported id (`realbud_report_model_key`). Badges: "Not using its own AI key", "AI key was refused".
- **Per-computer usage.** `website/lib/computer-usage.ts` and `app/api/account/ai-billing/analytics/route.ts`:
  - Up to 10 parallel per-project Modelvia reads, active computers first.
  - A 5-minute per-instance cache keyed by customer, invalidated when the office money snapshot changes.
  - Flags: disconnected-but-used, unknown project, Office credits / not linked.
  - Money amounts are signed, so a credit month works on both the site and the desktop (`shared/office-link.ts`).
- **Rate limits** (per instance, marked `ponytail:`):
  - Link requests: 5/min per IP.
  - Report: 60/min per IP and 6/min per computer.
  - Redelivery: 2/min.

## Checks (rerun by the interactive session)
- managed-gateway: 385/385.
- server vitest (office-link, ask-model-relay, provisioning contract): 107 pass, 3 skipped (Windows/native-gated; not passes).
- `tsc -p tsconfig.server.json`: clean.
- website `lib/*.test.mjs`: 391 total, 389 pass, 2 skipped. `platform-guard.test.mjs:190` is a pre-existing 10 ms timing test that failed once under load, then passed 5/5 alone and on a full rerun.
- website `tsc --noEmit`: clean.
- Disposable Postgres (`LC_ALL=C REALBUD_TEST_POSTGRES=1`): `test-installations-postgres.mjs` PASS, `test-installation-link-postgres.mjs` PASS.
- `scripts/qa-computer-cap.mjs`: 7/7 against a scratch build (`REALBUD_WEBSITE_DIR`, clone of website/shared/src/managed-gateway). Receipts in `outputs/computer-cap-2026-10-04/`.
- Reviews:
  - Reviewer agent and Astra 6 Ultra (diff review plus edge-case matrix). Their findings are fixed, except the decisions below.
  - The matrix is in the session scratchpad, not the repo.

## Before deploying
1. Apply the migration before the website code.
2. Bind every existing client-paid office (Austin included) once via `POST /v1/operator/offices/ai-access`. Unbound offices can't pair or refresh keys. There is no CLI for this.
3. Moving an office's customer now requires disconnecting its computers first (`managed-gateway/DEPLOY.md`).

## Open
- **Owner decision, cloned disks.** A copied bearer identity counts as one computer, and a copied key works anywhere until revoked. Closing this needs device-bound keys (Secure Enclave) or relaying AI through the gateway.
- **Owner decision, shared limits.** Rate limits and the Modelvia allowance are per server instance. Use a shared store (a Supabase table) if the website runs more than one instance.
- **Unexplained difference in the usage-page screenshot.** The top card shows "Cost so far A$0.60 after credits" while Usage details shows "A$50.00 credit". Likely two separate fixtures in `qa-computer-cap.mjs`; confirm before shipping.
- Within 10 minutes of an unfinished setup, a disconnect says "try again in 10 minutes". There is no automatic retry.
- `scripts/qa-installations-ui.mjs` predates this week's schema and copy, and its owner should update it. `server/index.ts` could pass `env: () => workerModelAccess.env()` so the vault read doesn't use the relay snapshot.
- This checkpoint is not yet linked from `docs/GOAL-PROMPT.md` or `docs/END-STATE.md`; both were being edited by another session.
