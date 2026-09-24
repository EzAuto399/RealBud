# Go-live runbook — Modelvia and RealBud, 22 September 2026

Ordered. "You" means a person with the credentials; "agent" means preparable in this session. Verify each step before the next. Nothing here is customer proof; the last step is the first real observation.

## Current live state (from Modelvia's dated handoff, not observed)

| Service | Live | Branch head | Gap |
| --- | --- | --- | --- |
| api.modelvia.dev (Render Singapore) | `69678e8` | `codex/neon-release` `0f11732`+ | six defect fixes, portal slices, operator `onboard`, optional idempotency header, and the MCP/usage-summary work still uncommitted in the working tree |
| modelvia.dev (Vercel) | `d2f6422` | same branch | portal slices |
| RealBud gateway | not deployed | `managed-gateway/` in the wave branch | hosting undecided (`HOSTING-DECISION-2026-09-22.md`) |
| realbud.app (Vercel `realbud`) | older build | website wave | provisioning route, usage route, migration 0006 |
| Supabase `realbud` project | unknown | migrations 0001–0007 | apply in order; 0006 drops and re-creates `realbud_revoke_installation` |

## Steps

1. You: answer the hosting decision in one word (Fly for the RealBud gateway is what `deploy.sh` and `fly.toml` already target).
2. You (Modelvia session): commit the MCP and usage-summary work onto `codex/neon-release`, push, CI green. Verify: `gh run list --branch codex/neon-release --limit 3`.
3. You: manual Render deploy of that revision. Verify: `curl -s https://api.modelvia.dev/health` shows the new revision.
4. You: onboard RealBud as a platform client with one command (`platform-cli.ts onboard onboarding.json`, template `onboarding.example.json`; copy `acceptance.digest` from `GET /v1/operator/rates` first). Keep the printed `mgt_…` client key and the operator secret + subject. Verify: `node platform-cli.ts customers`.
5. Agent (done in this wave): gateway signs a fresh Modelvia operator token per call from `REALBUD_MODELVIA_OPERATOR_SECRET` + `REALBUD_MODELVIA_OPERATOR_SUBJECT`; `deploy.sh`/`fly.toml` carry every provisioning name; `GET /ready`.
6. You: create the `realbud` Supabase project (org EzAuto399; never `veylet` or `wondertrail-development`) and apply `website/supabase/migrations/*.sql` in filename order. Verify: `realbud_record_provisioning` and `realbud_installation_scope` exist; anon and authenticated are denied.
7. You: deploy the RealBud gateway with secrets exported in the shell that runs `deploy.sh`: `REALBUD_GATEWAY_PORTAL_SECRET` (≥32 chars, same value as the portal), `REALBUD_GATEWAY_OPERATOR_SECRET`, `REALBUD_FINGERPRINT_KEY`, `REALBUD_PAYMENT_WEBHOOK_KEY`, `REALBUD_COMPOSIO_ORG_KEY`, `REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL`, `REALBUD_MODELVIA_OPERATOR_SECRET`, `REALBUD_MODELVIA_OPERATOR_SUBJECT`, `REALBUD_MODELVIA_CLIENT_ID`, and `REALBUD_ENABLE_PROVIDER=1`. Verify: `curl $ORIGIN/ready` is 200; `POST $ORIGIN/v1/portal/installations/provision` without a bearer is 401.
8. You: Vercel env for `realbud`: `REALBUD_GATEWAY_URL` (https, step 7 origin), `REALBUD_GATEWAY_PORTAL_SECRET` (same as step 7), `PLATFORM_API_URL=https://api.modelvia.dev`, `PLATFORM_CLIENT_KEY` (step 4), `REALBUD_PLATFORM_CUSTOMERS_JSON={"<companyId>":"<modelvia customer id>"}`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REALBUD_SITE_ORIGIN`, `REALBUD_AUTH_SECRET`, `REALBUD_OPERATOR_EMAILS`. Then `npx vercel --prod` from `website/` and point `realbud.app` at it (the desktop only talks to that host). Verify: `/account` signed in is 200; `/api/account/ai-billing` returns a period.
9. You: build and notarize the desktop app (`pnpm package:mac:release`), upload the artifacts with `latest-mac.yml`, install on one real Mac.
10. You, watched by the agent: Account → Computers → Pair a new computer → enter the code on the Mac. Expected within a minute: the row reads Provisioned; on the Mac, You → Bud shows "Model access: managed by RealBud service (Modelvia)"; run one turn in Ask; You → Account shows a non-zero AI usage figure; revoke the computer on the website; the next turn is refused. This is the first live observation of the whole chain.
11. You: Composio org key into vendor custody and the reviewed Gmail auth-config id; then one real mail scan on the customer's own account.

## Not closed by this runbook

Modelvia's own production review is NO-GO for paying customers (Square receipt, commercial terms, provider catalogue approval, backup restore after MFA, alerts ownership). Collection stays off. The RealBud gateway's file-backed secret store is next-to-an-operator custody, not a managed secret manager. Windows remains unproven.
