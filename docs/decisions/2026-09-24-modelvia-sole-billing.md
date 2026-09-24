# Modelvia is the only billing source

Owner decision, 24 September 2026. This record does not establish deployment, applied hosted migrations, live Modelvia readback or customer acceptance.

## Decision

Modelvia is the only source of AI rates, caps, usage and invoices that a RealBud office sees. RealBud's own gateway (`managed-gateway/`) stops doing billing. It keeps three jobs:

1. Provisioning and revoking installations. Each installation gets one Modelvia project and key, plus one Composio connector device.
2. Connectors (`/v1/connectors/*`).
3. Service entitlement: whether the office's RealBud service is active, which licence it holds, when it went live and when it expires.

The website shows billing in one place, `/account/ai-billing`. The old Rates, Limits and Service invoices pages redirect to sections of that page.

## Why

On 24 September, realbud.app showed a Modelvia QA rate card (`fictional-hosted-rates-20260922`) with an "Accept" button, a A$0.00 cap with no explanation, and errors on the Computers and Work requests pages. The underlying causes:

- **Two billing systems ran side by side.** The gateway ledger had its own rate cards, cap edits, invoices and care fee. Modelvia held customers, projects, caps, invoices and checkout.
- **Caps were set in both.** Rates were accepted in both. Invoices came from both.
- **One setup step could not be done.** Provisioning needed a gateway "tenant" row that no production route or tool could create.
- **Failures looked the same.** Every failure reached the office as "unavailable".

## Consequences

- **Caps:** a cap change is made by RealBud in Modelvia (operator). The website shows the cap read-only.
  - Installation projects copy the Modelvia customer's monthly cap and concurrency when provisioned.
  - After a cap change, `caps-cli.ts apply --company <id>` copies the new caps to existing projects.
  - One request is capped at the smaller of the monthly cap and `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` (default A$1). This default is reversible and needs owner confirmation.
  - A missing, inactive, foreign or zero-cap customer is refused with `modelvia_customer_not_ready`.
- **Pricing:** agreed retail terms are recorded in Modelvia as a commercial policy. The website shows the resulting customer price and has no acceptance control.
- **Service entitlement:** entitlement records are created by a trusted operator command (`managed-gateway/entitlement-cli.ts`), not by test fixtures.
- **Stored data:** existing ledger tables and records remain readable. Nothing is dropped.
- **Care fee:** Modelvia cannot issue a non-AI line on a customer invoice. The gateway never closed a care invoice in production. Who issues the monthly care fee is an open owner decision; nothing in this change bills it.

## Still required outside the code (owner authority)

- Apply the website's pending Supabase migrations to the hosted project.
- Set the production website to Modelvia-only configuration and redeploy from a named git ref.
- Create each office's service entitlement with the entitlement command.
- Confirm each office's Modelvia customer, caps and commercial policy with Modelvia.
- The api.modelvia.dev health route reported `"mode":"local","productionEnabled":false` on 24 September. Paid production use needs Modelvia's production mode.
