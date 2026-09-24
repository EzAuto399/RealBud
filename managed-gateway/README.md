# RealBud managed gateway

Off-device service with three jobs:

1. **Installation provisioning and revocation.** Each installation gets one Modelvia project and key, and one Composio connector device.
2. **Connectors** (`/v1/connectors/*`), for the desktop's managed Gmail read.
3. **Service entitlement.** Whether an office's RealBud service is active, which licence it holds, and its go-live and expiry dates.

**Modelvia is the only source of AI rates, caps, usage and invoices** (owner decision, [24 September 2026](../docs/decisions/2026-09-24-modelvia-sole-billing.md)). This service has no billing, rate, usage, invoice, payment or model-forwarding route. It never loads into the desktop and never changes Hermes.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness |
| `GET /ready` | none | 200 only when provisioning is composed; always reports `modelviaOperator` and `operatorAccess` (`configured\|missing`). Makes no network call |
| `POST /v1/portal/installations/provision` | portal bearer, `billing_owner` | needs an active entitlement and a ready Modelvia customer |
| `POST /v1/portal/installations/revoke` | portal bearer, `billing_owner` | no entitlement needed, so a lapsed office can still be shut off |
| `/v1/connectors/*` | connector credential | needs an active entitlement |
| `POST /v1/operator/offices/ai-access` | operator bearer, `realbud_operator` | sets one office's AI access at Modelvia: default A$200 monthly cap, a custom cap, or disabled ([DEPLOY.md](DEPLOY.md#office-ai-access)) |

Every other path returns 404. The error codes that tell an operator what to fix:

- `tenant_unavailable` (403): the company has no entitlement. Create one with the entitlement command.
- `service_unavailable` (402): the entitlement is inactive, expired, or not yet live.
- `modelvia_customer_not_ready` (409): the office's Modelvia customer is missing, inactive, under another client, or has a zero monthly cap. Set it with the office AI access route.
- `modelvia_customer_foreign` (409): the Modelvia customer id belongs to another platform client. Nothing was written.
- `operator_unauthenticated` (401) / `operator_unconfigured` (503): no valid operator bearer, or the operator secret or Modelvia operator variables are not set.

The installation project copies the Modelvia customer's caps at provisioning. Its monthly cap and concurrency are the customer's; its request cap is `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` (default A$1), never above the monthly cap. After the customer's caps change, `caps-cli.ts apply --company <id>` (`pnpm run caps`) re-applies them to every ready installation. Cap fields stored in the ledger are legacy and drive nothing.

## Service entitlement (operator)

Run on the service machine only. The command opens the same database as the server (`$REALBUD_GATEWAY_DATA/ledger.sqlite`, default `./data`). The database must already exist: start the server once first.

```sh
cd managed-gateway
node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> \
  --license <licenseId> --name "<legal name>" --address "<address>" \
  --go-live 2026-09-01 --go-live-evidence <signed-order-ref> --expires 2027-09-01
node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> --active false
node --experimental-strip-types entitlement-cli.ts get --company <companyId>
```

On an existing company, `set` changes only the fields you pass. The licence cannot change after creation. Output is one JSON line with no secrets. `pnpm entitlement …` runs the same command.

## Run and test locally

Node 24+ with `node:sqlite`.

```sh
pnpm exec tsc -p managed-gateway/tsconfig.json
cd managed-gateway && node --experimental-strip-types --test ./*.test.ts
node --experimental-strip-types sandbox-smoke.ts   # offline provisioning smoke against fakes
```

The root `pnpm test` does not include this service. Every fixture here is synthetic. A passing fake is never evidence that a real Composio or Modelvia account was used.

## Modules

| Module | Responsibility |
| --- | --- |
| `http.ts`, `server.ts` | Route set above; production composition from env |
| `provisioning.ts`, `provision-connector.mjs` | Installation provisioning and revocation; connector registry CLI |
| `modelvia-keys.ts` | Modelvia operator client: customer read and write (own client only), project, key, rotate, revoke |
| `office-ai-access.ts`, `operator-token.ts` | Operator office AI access route and its own operator bearer |
| `composio-org.ts`, `connectors.ts` | Composio org client; connector broker |
| `entitlement-cli.ts`, `local-env.ts` | Operator entitlement command; shared `.env.local` and database path |
| `database.ts`, `ledger.ts` | SQLite ledger: entitlements, audit chain. Older billing tables stay in the schema, readable and unused |
| `gateway.ts`, `auth.ts`, `direct-provider.ts`, `messages.ts`, `attempts.ts` | Earlier model-forwarding core. Not composed by `server.ts`; kept with its tests ([PHASE2.md](PHASE2.md)) |

Deployment is described in [DEPLOY.md](DEPLOY.md). It is a separate authority and never runs from a coding session.
