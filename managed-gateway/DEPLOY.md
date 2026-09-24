# RealBud managed gateway: deployment

The gateway runs on Fly (Sydney) from `deploy.sh` and `fly.toml`. The website runs on Vercel. Deployment is a separate authority: `deploy.sh` needs a human `fly auth login` and exported secrets, and never runs from a coding session.

**Modelvia is the only source of AI rates, caps, usage and invoices** ([decision, 24 September 2026](../docs/decisions/2026-09-24-modelvia-sole-billing.md)). The gateway keeps installation provisioning and revocation, connectors, service entitlement, `/health` and `/ready`. It has no billing, payment, rate, usage, invoice or model route, and needs no Square, OpenAI, DeepSeek or Kimi credential.

## Order of operations

1. **Deploy.** Export the variables below, then run `managed-gateway/deploy.sh`. It refuses to run while any required variable is unset, and names each missing one without echoing a value.
2. **Check readiness.** `curl -fsS "$REALBUD_GATEWAY_URL/ready"`. A 200 response means provisioning is composed. A 503 response names the variable still to set, never its value. Both responses report `modelviaOperator: configured|missing`. `/ready` makes no network call.
3. **Create each office's service entitlement** on the machine (`fly ssh console -a realbud-managed-gateway`, then `cd /app/managed-gateway`):

   ```sh
   node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> \
     --license <licenseId> --name "<legal name>" --address "<address>" \
     --go-live <YYYY-MM-DD> --go-live-evidence <signed-order-ref> --expires <YYYY-MM-DD>
   ```

   `--go-live` must be today or earlier, and `--expires` must be after `--go-live` (otherwise `invalid_go_live` or `invalid_service_expiry`). The command opens `/data/ledger.sqlite`, the database the server uses. It refuses to create a database, so a wrong path fails loudly. Without an entitlement, provisioning answers 403 `tenant_unavailable`. Suspend an office with `--active false`. Renew by setting a later `--expires`; existing connectors follow the current entitlement, so they keep working without reprovisioning.
4. **Confirm the office's Modelvia customer** is active, sits under `REALBUD_MODELVIA_CLIENT_ID`, and has a non-zero monthly cap. Otherwise provisioning answers 409 `modelvia_customer_not_ready` and creates nothing.
5. Set the website's `REALBUD_GATEWAY_URL` to the app origin (`fly status -a realbud-managed-gateway`) and `REALBUD_GATEWAY_PORTAL_SECRET` to the same value as the gateway. Secrets never go in a `NEXT_PUBLIC_` variable.

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `REALBUD_GATEWAY_PORTAL_SECRET` | yes | portal bearer secret, >=32 chars, shared with the website BFF |
| `REALBUD_GATEWAY_DATA` | fly.toml | `/data`, the mounted volume; the ledger is `ledger.sqlite` inside it |
| `REALBUD_ALLOWED_ORIGINS` | fly.toml | browser origins admitted; default `https://realbud.app,https://www.realbud.app` |
| `REALBUD_ENABLE_PROVIDER` | gate | `1` composes provisioning; anything else leaves it off (`provisioning_disabled`) and hands no transport to any client |
| `REALBUD_GATEWAY_SECRETS_DIR` | fly.toml | absolute 0700 directory on the volume; one 0600 file per Composio project key |
| `REALBUD_GATEWAY_CONNECTOR_REGISTRY` | fly.toml | absolute path of the connector device registry on the volume |
| `REALBUD_GATEWAY_PUBLIC_ORIGIN` | yes | this service's HTTPS origin, put into `connector.endpoint` |
| `REALBUD_COMPOSIO_ORG_KEY` | yes | Composio `x-org-api-key`; a vendor credential, never held by customers |
| `REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL` | yes | the reviewed Gmail read-only OAuth configuration id |
| `REALBUD_MODELVIA_BASE_URL` | fly.toml | Modelvia origin, `https://api.modelvia.dev` |
| `REALBUD_MODELVIA_OPERATOR_SECRET` | yes | Modelvia operator HMAC secret, >=32 chars. A fresh two-minute bearer is minted per request; a static token would 401 |
| `REALBUD_MODELVIA_OPERATOR_SUBJECT` | yes | operator subject in Modelvia's audit trail |
| `REALBUD_MODELVIA_CLIENT_ID` | yes | RealBud's platform client id at Modelvia; only customers under it are provisioned into |
| `REALBUD_MODELVIA_MODELS` | no | comma-separated `allowedModels` per project; default `auto` |
| `REALBUD_MODELVIA_ENVIRONMENT` | no | `production` (default) or `development` |
| `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` | no | per-request cap on each installation project, a positive integer in nanoAUD; default `1000000000` (A$1). Clamped to the customer's monthly cap. A malformed value answers `provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` |

A missing or malformed provisioning variable leaves the server running, answering 503 `provisioning_unconfigured:<NAME>` on `/ready` and on both provisioning routes. The startup log line carries the same code. The file-backed secret store inherits the trust of whoever owns the filesystem. It is not managed custody until it is swapped for a KMS-backed secret manager.

## Installation provisioning

Both routes take the existing portal bearer. The principal must be `billing_owner`. A body's `companyId` only confirms the principal's company and never asserts one.

```
POST /v1/portal/installations/provision
  { "companyId": "…", "installationId": "…", "customerId": "<Modelvia customer id>", "profile": "property", "apps": ["gmail"] }
POST /v1/portal/installations/revoke
  { "companyId": "…", "installationId": "…", "deleteProject": false }
```

`provision` checks, in order:

1. The service entitlement.
2. The Modelvia customer, a read only.
3. It journals the attempt.
4. It creates or reuses the company's Composio project. The `ak_` key stays in the secret store.
5. It admits the `rbc_` connector credential by hash.
6. It creates `rb-<installationId>` under the customer, with the customer's monthly cap and concurrency. The request cap is `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` (default A$1), never above the monthly cap.
7. It mints one key labelled `<companyId>:<installationId>`.

The first successful call returns the connector credential and model key once. A repeat call returns the same descriptor without them and asks Modelvia nothing. An interrupted call can be resumed after `PENDING_RESUME_AFTER_MS`. The resume reuses the same project, rotates the one labelled key, and never mints a second key.

Caps are copied at provisioning. After an office's Modelvia customer changes its monthly cap or concurrency, re-apply them on the machine:

```sh
node --experimental-strip-types caps-cli.ts apply --company <companyId>
```

It needs the Modelvia operator variables. It reads the customer once and updates every `ready` installation project of that company; pending and revoked installations are skipped. It prints installation ids and `applied`/`failed` states only, with an error code per failure, and exits non-zero unless every installation applied. One failure never stops the others; rerun it to retry.

`revoke` does not need an entitlement. It deactivates the device, then revokes the model key. The Modelvia project is left in place. The Composio project is deleted only on an explicit `deleteProject: true`, which is irreversible. Revoke writes one audit line, with no secret in it.

## Managed Gmail compatibility (22 September 2026)

`POST /v1/connectors/mail-scan` requires the exact `{ expectedAccountId, scope }` envelope. The account is a precondition on the server-owned device binding. A mismatch is refused before any provider read. A legacy flat request fails with 400. A changed binding returns 409. Release the desktop and gateway together. See [website request and connector verification](../docs/WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md).

## Proof so far

Local tests only (`node --experimental-strip-types --test ./*.test.ts`) and the offline `sandbox-smoke.ts`, all against injected fakes. No real Composio project, Modelvia customer read or Modelvia key has been exercised from this service.
