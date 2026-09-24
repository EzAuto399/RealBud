# RealBud managed gateway: deployment

The gateway runs on Fly (Sydney) from `deploy.sh` and `fly.toml`. The website runs on Vercel. Deployment is a separate authority: `deploy.sh` needs a human `fly auth login` and exported secrets, and never runs from a coding session.

**Modelvia is the only source of AI rates, caps, usage and invoices** ([decision, 24 September 2026](../docs/decisions/2026-09-24-modelvia-sole-billing.md)). The gateway keeps installation provisioning and revocation, connectors, service entitlement, `/health` and `/ready`. It has no billing, payment, rate, usage, invoice or model route, and needs no Square, OpenAI, DeepSeek or Kimi credential.

## Order of operations

1. **Deploy.** Export the variables below, then run `managed-gateway/deploy.sh`. It refuses to run while any required variable is unset, and names each missing one without echoing a value.
2. **Check readiness.** `curl -fsS "$REALBUD_GATEWAY_URL/ready"`. A 200 response means provisioning is composed. A 503 response names the variable still to set, never its value. Both responses report `modelviaOperator` and `operatorAccess` (`configured|missing`). `/ready` makes no network call.
3. **Create each office's service entitlement** on the machine (`fly ssh console -a realbud-managed-gateway`, then `cd /app/managed-gateway`):

   ```sh
   node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> \
     --license <licenseId> --name "<legal name>" --address "<address>" \
     --go-live <YYYY-MM-DD> --go-live-evidence <signed-order-ref> --expires <YYYY-MM-DD>
   ```

   `--go-live` must be today or earlier, and `--expires` must be after `--go-live` (otherwise `invalid_go_live` or `invalid_service_expiry`). The command opens `/data/ledger.sqlite`, the database the server uses. It refuses to create a database, so a wrong path fails loudly. Without an entitlement, provisioning answers 403 `tenant_unavailable`. Suspend an office with `--active false`. Renew by setting a later `--expires`; existing connectors follow the current entitlement, so they keep working without reprovisioning.
4. **Set the office's AI access** with `POST /v1/operator/offices/ai-access` (see [Office AI access](#office-ai-access)). `default` creates the office's Modelvia customer under `REALBUD_MODELVIA_CLIENT_ID` with the A$200 cap. Without an active customer with a non-zero cap, provisioning answers 409 `modelvia_customer_not_ready` and creates nothing.
5. Set the website's `REALBUD_GATEWAY_URL` to the app origin (`fly status -a realbud-managed-gateway`) and `REALBUD_GATEWAY_PORTAL_SECRET` to the same value as the gateway. Secrets never go in a `NEXT_PUBLIC_` variable.

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `REALBUD_GATEWAY_PORTAL_SECRET` | yes | portal bearer secret, >=32 chars, shared with the website BFF |
| `REALBUD_GATEWAY_OPERATOR_SECRET` | for operator routes | RealBud operator bearer secret, >=32 chars, different from the portal secret. Missing, short or equal leaves operator routes off (503 `operator_unconfigured`, `/ready` `operatorAccess: missing`). Held only by the operator console that mints operator tokens |
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

## Office AI access

Each office's Modelvia customer has an AI monthly cap of A$200 by default. A RealBud operator can set a custom cap or disable AI for the office. Modelvia is the only source of caps; this gateway alone holds the Modelvia operator credential, so it makes the write.

```
POST /v1/operator/offices/ai-access          Authorization: Bearer <operator token>
  { "companyId": "…", "customerId": "<Modelvia customer id>", "name": "<office name>",
    "access": { "mode": "default" } | { "mode": "custom", "monthlyCapNanoAud": "…" } | { "mode": "disabled" } }
→ { "customer": { "active": true, "monthlyCapNanoAud": "200000000000", "created": true },
    "projects": [ { "installationId": "…", "state": "applied" | "failed", "error": "<code>" } ] }
```

- **Authority.** An operator token (`operator-token.ts`): claims `{subject: "operator:<email>", role: "realbud_operator", iat, exp}`, at most five minutes long, signed with `REALBUD_GATEWAY_OPERATOR_SECRET`. A portal token is never accepted here, and an operator token is never accepted on a portal route.
- **Modes.** `default` is A$200 (`200000000000` nanoAUD). `custom` is 1 nanoAUD to A$10,000 (`10000000000000`). `disabled` sets the customer inactive and leaves its cap. Anything else is 400 `invalid_ai_access`.
- **Customer.** If Modelvia holds no customer with that id, one is created under `REALBUD_MODELVIA_CLIENT_ID` with `name`, concurrency 2 and the `REALBUD_MODELVIA_MODELS` models. An existing customer keeps its name, concurrency, models and bindings; only `active` and the cap change. A customer under another platform client is 409 `modelvia_customer_foreign`, and nothing is written. A stale version is re-read and retried once, then 409 `modelvia_customer_version_conflict`.
- **Projects.** After `default` or `custom`, the new cap is pushed to the company's ready installation projects, as `caps-cli.ts apply` does. `disabled` pushes nothing: Modelvia refuses serving for an inactive customer.
- **Checks and audit.** The company must have an entitlement record (403 `tenant_unavailable` otherwise). Requests are serialized per company. Two ledger lines, `office_ai_access_requested` (before any Modelvia call) and `office_ai_access_set`, carry the operator subject, company, mode, cap and project results. They never carry the Modelvia customer id or a secret.
- **Errors.** 401 `operator_unauthenticated`; 503 `operator_unconfigured` (operator secret missing or equal to the portal secret, Modelvia operator variables missing, or `REALBUD_ENABLE_PROVIDER` not `1`); 409 `modelvia_customer_foreign`; 400 `invalid_ai_access`.

Minting operator tokens (the operator console) is not part of this service.

## Managed Gmail compatibility (22 September 2026)

`POST /v1/connectors/mail-scan` requires the exact `{ expectedAccountId, scope }` envelope. The account is a precondition on the server-owned device binding. A mismatch is refused before any provider read. A legacy flat request fails with 400. A changed binding returns 409. Release the desktop and gateway together. See [website request and connector verification](../docs/WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md).

## Proof so far

Local tests only (`node --experimental-strip-types --test ./*.test.ts`) and the offline `sandbox-smoke.ts`, all against injected fakes. No real Composio project, Modelvia customer read or Modelvia key has been exercised from this service.
