# Modelvia integrator gaps found while connecting RealBud

Handoff to the Modelvia repository owner, 24 September 2026. This is based on reading source and public docs only. It does not establish live behaviour. RealBud did not edit Modelvia source or docs.

Sources checked:
- Public site: modelvia.dev/docs (overview, integrate, customers, customer-console).
- `api.modelvia.dev/health`.
- Modelvia worktree `modelvia-client-onboarding-flow-2026-09-24` at `3b1e80e`.

## Blocking for RealBud's production use

1. **The live gateway is not in production mode.** `GET https://api.modelvia.dev/health` on 24 September returned:
   - `"mode":"local"` and `"productionEnabled":false`
   - `"paymentMode":"local"` and `"customerPaymentMode":"disabled"`
   
   RealBud needs the production mode, or a written statement of what "local" permits, before paid use.
2. **The client key cannot check readiness before the first call.** Four gates are enforced when a request is made:
   - `rates_not_accepted`
   - `rate_card_not_effective`
   - `customer_terms_required`
   - a zero cap (`*_monthly_cap_exceeded`)
   
   The client key cannot read any of them in advance. Please add one read-only readiness route for the `mgt_` key: billing active, rate accepted and effective, customer terms effective, caps above zero.
3. **Caps can only be edited by an operator.** `POST /v1/client/customers` refuses a changed body with `account_version_conflict`. Either document that cap changes are made by Modelvia, or add a versioned client update.

## Documentation fixes

1. **Error codes are missing from the reference.** These appear nowhere in the public docs or OpenAPI:
   - `rate_card_not_effective`
   - `billing_account_unconfigured` (503)
   - `square_payment_disabled`
   - `hosted_collection_not_connected`
   - `account_policy_changed`
   - `invalid_customer_payment`
   - `direct_instructions_required`
   
   The integrate page lists `unknown_key` 404, but client routes return `account_not_found`. The OpenAPI operations have only a `default` response; please list each code with its fix.
2. **The commercial policy is called optional but is required.** `README.md:164` and `platform-cli.ts:46` call it optional. `ledger.ts:252` refuses every client-paid customer without one.
3. **Operator onboarding has no guide.** The steps are billing account → rate card → acceptance → client → `mgt_` key → customer terms, and they exist only as CLI help. A client needs a checklist of what to ask Modelvia for, and in what order.
4. **Setting names differ between the two sides.** The docs use `MODELVIA_API_URL`, `MODELVIA_CLIENT_KEY` and `MODELVIA_EXPECTED_CLIENT_ID`. RealBud uses `PLATFORM_API_URL`, `PLATFORM_CLIENT_KEY` and `REALBUD_PLATFORM_CUSTOMERS_JSON`. RealBud should adopt the documented names, keeping the old ones as aliases.
5. **Some terms need a glossary.** Needed: client, customer, project, billing account (`companyId`), member and installation. The project key prefix `rbk_` reads as RealBud-specific.

## What RealBud changed on its side (branch `claude/modelvia-only-*`)

- Modelvia is the only billing source (see `docs/decisions/2026-09-24-modelvia-sole-billing.md`).
- Installation projects copy the Modelvia customer's caps. Provisioning refuses a missing, inactive or zero-cap customer with its own code.
- An operator page at `/admin/connection` shows each setup step as pass or fail.
