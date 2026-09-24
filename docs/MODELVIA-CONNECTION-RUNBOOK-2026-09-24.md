# Connect RealBud to Modelvia: operator runbook

Written 24 September 2026. This is the one ordered path from nothing to a paired office. It replaces the connection steps in `docs/GO-LIVE-RUNBOOK-2026-09-22.md`, `website/docs/PROVISION-BILLING.md` and `website/docs/AI-PLATFORM-BILLING.md` wherever they disagree. Billing rules: [Modelvia is the only billing source](decisions/2026-09-24-modelvia-sole-billing.md).

This runbook has not yet been executed end to end against hosted services. Its steps are backed by local tests only.

**Check after every step:** sign in as an operator and open `https://realbud.app/admin/connection`. Each row reads pass, warn, fail or not configured, with a one-line fix. Do not go on while a row for an earlier step fails.

## Once per deployment

1. **Ask Modelvia for RealBud's client setup.** Modelvia must do all of these; RealBud cannot:
   - billing account;
   - accepted rate card;
   - client;
   - client integration key (`mgt_…`);
   - operator HMAC secret and subject for the gateway.
   
   Record the client ID. `api.modelvia.dev/health` must report production mode before paid use; on 24 September it reported `"mode":"local"`.
2. **Apply the website database migrations.** Apply every file in `website/supabase/migrations/`, in filename order, to the hosted Supabase project.
   - Check: the "Database" rows pass.
   - A missing `202609220006` is why Computers says "Installation status is unavailable".
3. **Deploy the gateway.** Follow `managed-gateway/DEPLOY.md` steps 1–2.
   - Check: `/ready` returns 200 and `modelviaOperator: configured`.
4. **Set the website environment in Vercel, then redeploy from a named git ref.** Vercel applies changed variables only on a new deployment.

   | Variable | Value |
   |---|---|
   | `PLATFORM_API_URL` | `https://api.modelvia.dev` |
   | `PLATFORM_CLIENT_KEY` | the `mgt_…` key from step 1 (server-only, never `NEXT_PUBLIC_`) |
   | `PLATFORM_EXPECTED_CLIENT_ID` | the client ID from step 1 |
   | `REALBUD_GATEWAY_URL` | the **gateway's** Fly origin, not Modelvia's |
   | `REALBUD_GATEWAY_PORTAL_SECRET` | the same value as on the gateway |

   - Check: the "Modelvia connection" and "Gateway" rows pass.
   - The Gateway row fails with "points at Modelvia" if `REALBUD_GATEWAY_URL` is set to Modelvia. That misconfiguration showed Modelvia's QA rate card to offices.

## Once per office

5. **Create the office** in `/admin/offices`. Copy its company ID exactly.
6. **Ask Modelvia to set up the office's customer** under RealBud's client:
   - active;
   - a non-zero monthly cap;
   - a commercial policy (required before any client-paid request).
7. **Map the office to its Modelvia customer.** Add `"<companyId>":"<customerId>"` to `REALBUD_PLATFORM_CUSTOMERS_JSON`, then redeploy.
   - Check: the office's row reads pass.
   - "AI spend not enabled" means the cap is still zero.
8. **Create the office's service entitlement** on the gateway. See `managed-gateway/DEPLOY.md` step 3.
9. **Pair the computer.** Go to Computers → Pair a new computer, then enter the code in the desktop app.
   - The gateway checks the entitlement and the Modelvia customer before creating anything.
   - If either is not ready, the computer stays linked without AI.
   - The redeem response names the missing step:
     - `service_not_entitled` or `service_not_active` → step 8.
     - `modelvia_customer_not_ready` → step 6.
     - `no_platform_customer` → step 7.
   - Fix that step, then pair again.

## Changing an office's cap

Change it in Modelvia, then run `node --experimental-strip-types caps-cli.ts apply --company <companyId>` on the gateway. It copies the cap to each of the office's computers and prints each one's result.

## Renewing an office

Run `entitlement-cli.ts set --company <companyId> --evidence <ticket> --expires <date>`. Existing connectors follow the new date.

## Removing a computer

Computers → Remove. The website now sends the company ID the gateway requires; before 24 September every removal was refused. A computer still listed with a pending revocation needs the operator cleanup in `website/docs/INSTALLATION-PROVISIONING-2026-09-22.md`.

## Known gaps

- **Care fee:** each office's agreed monthly care amount is sent as a manual Square invoice. RealBud does not bill it.
- **Office mapping:** it lives in one environment variable, so each new office needs a redeploy. Moving it into the database is the next reduction.
- **Readiness through a client key:** Modelvia cannot yet report rate acceptance, terms or caps to the client key before the first request. See `docs/MODELVIA-INTEGRATOR-GAPS-2026-09-24.md`.
