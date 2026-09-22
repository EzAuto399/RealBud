# RealBud hosting

Website on **Vercel**. OpenAI admin spend on the **server only**. No Fly.

Supabase is optional later (new `realbud` project in org EzAuto399). Do not reuse `veylet` or `wondertrail-development`.

## Website (Vercel)

From `website/`:

```bash
npx vercel
```

Server env (Vercel project settings — never `NEXT_PUBLIC_` for secrets):

```
REALBUD_SITE_ORIGIN=https://realbud.app
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
OPENAI_ADMIN_KEY=
OPENAI_ORG_ID=
REALBUD_GATEWAY_PORTAL_SECRET=
```

`OPENAI_ADMIN_KEY` is the **admin** key (`sk-admin-…`), not a client inference key. Browser JS never reads it.

Point `realbud.app` at Vercel (Cloudflare DNS CNAME). Email routing stays on Cloudflare.

## OpenAI wiring (our org, one key per office)

1. Create an API key in our OpenAI org for that office. The office does not log into OpenAI.
2. Map `key_…` → `company_id` with `OpenAIOffices.mapKey`.
3. Record FX + **margin policy** per office (`OpenAIOffices.recordPolicy` / private cost `policy`):
   - **Apply a %:** `apply: true`, `method: "margin"` or `"markup"`, `basisPoints` (2000 = 20%).
   - **Skip extra margin:** `apply: false` (or `basisPoints: 0`). Still converts FX and adds 10% GST. The stored % is kept for a later version.
   - Policies are versioned and immutable. To change % or turn it off, record a **new** `version`.
4. Monthly: poll `GET /v1/organization/costs?group_by=api_key_id` → retail AUD (margin only if `apply`) → tax invoice.
5. Clerk invitation to the billing owner. They accept rates, then pay on Square.

Do not bill from org wallet balance. Do not put wholesale USD or margin % on `/account`. Clients cannot toggle margin.

## Gateway (this Node service)

Run next to the operator until a RealBud Supabase/Postgres ledger exists:

```bash
# secrets: managed-gateway/.env.local (gitignored)
export REALBUD_GATEWAY_PORTAL_SECRET="$(openssl rand -hex 32)"
export REALBUD_GATEWAY_DATA=./data
node --experimental-strip-types server.ts
```

`.env.local` may hold `OPENAI_ADMIN_KEY` and `OPENAI_ORG_ID`. Website `REALBUD_GATEWAY_URL` is this service’s HTTPS origin.

## Managed Gmail compatibility — 22 September 2026

The desktop and connector gateway now require `POST /v1/connectors/mail-scan`
to carry the exact `{ expectedAccountId, scope }` envelope. The account is a
precondition on the server-owned device/connection binding, not a caller-selected
override. The gateway refuses a mismatch before any provider read and rechecks
that binding at subsequent scan authority checkpoints. Legacy flat requests fail
closed with 400; a changed binding returns 409 and requires source review.

Coordinate the compatible desktop and gateway release. The local two-agency
rehearsal and account-rebinding regression do not establish a deployed service.
See [website request and connector verification](../docs/WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md).

## Vendor-side installation provisioning — 22 September 2026

Two portal routes, authenticated with the **existing portal bearer**
(`REALBUD_GATEWAY_PORTAL_SECRET`, the same token the website BFF mints). The
authenticated principal is the authority: it must be `billing_owner`, and a body
`companyId` that does not equal the principal's is refused with 403
`company_scope_mismatch`. A body never asserts a tenant.

```
POST /v1/portal/installations/provision
  { "companyId": "…", "installationId": "…", "customerId": "<Modelvia customer id>",
    "profile": "property", "apps": ["gmail"] }

POST /v1/portal/installations/revoke
  { "companyId": "…", "installationId": "…", "deleteProject": false }
```

`provision` is idempotent per `installationId`. The **first** call returns the
secret material exactly once:

```json
{ "provisioning": {
  "version": 1,
  "service":   { "companyId": "…", "hostInstallationId": "…" },
  "connector": { "endpoint": "https://…", "credential": "rbc_…", "profile": "property",
                 "apps": ["gmail"], "projectId": "pr_…" },
  "model":     { "provider": "modelvia", "baseUrl": "https://api.modelvia.dev/v1",
                 "key": "rbk_…", "keyId": "<16 hex>", "projectId": "rb-<installationId>",
                 "spendCapLabel": "monthly-cap … nanoAUD, request-cap … nanoAUD, max-concurrent …" } } }
```

Every later call returns the same descriptor **without** `connector.credential`
and `model.key`. `connector.projectId` is the Composio project id (`pr_…`) and is
returned on both the first and every repeat response, for the portal to record as
`composio_project_id`. It is an identifier, never the project key.

What the call does, in order, journalling the intent first:

1. Resolves or creates the company's Composio project through the org client
   (`x-org-api-key`, org key from env only). The returned `ak_` project key is
   written to the secret store under the registry's existing `projectKeyEnv`
   indirection — `REALBUD_COMPOSIO_PROJECT_<COMPANY>` — and never leaves the
   service. An existing project with no stored key fails closed
   (`connector_project_key_unavailable`): regenerating would invalidate a key an
   installation is already using.
2. Mints the `rbc_` connector credential and admits its **hash** to the device
   registry, the same admission the `provision-connector.mjs` CLI performs (both
   now share `provisioning.ts`).
3. Creates **one Modelvia project per installation** — `rb-<installationId>`,
   named `RealBud installation <installationId>` — under the company's Modelvia
   customer account (`customerId` from the body; required, no default), then mints
   one key in it with `label` = `<companyId>:<installationId>`. Caps live on the
   project, not on keys, so the ledger tenant's `monthlyCapNanoAud`,
   `requestCapNanoAud` (clamped to the monthly cap) and `maxConcurrent` are
   **actually applied** at Modelvia, and are enforced at client, customer and
   project level for every key underneath. `version: 0` creates; a project id
   Modelvia already holds comes back as a conflict, and provisioning stops there
   (409 `modelvia_project_already_exists`) rather than risk a second live key —
   the operator surface exposes no key listing to check against.

An interrupted first call leaves a `pending` record and is held for operator
reconciliation (409 `installation_provisioning_outcome_unknown`). It is never
retried blind: that could create a second project, a second device or a second
minted key.

`revoke` deactivates the device in the registry first, then marks the Modelvia key
for revocation. The installation's **Modelvia project is deliberately left in
place**: it holds the usage and billing history the ledger reconciles against, and
its caps bound any key under it regardless. Removing it is an operator action at
Modelvia, never a side effect here. The Composio project is deleted **only** on an explicit
`deleteProject: true` — irreversible, and it revokes the office's upstream OAuth
credentials at the provider. Default is `false`. One audit line
(`installation_revoked`), no secret in it. A repeat revoke returns the recorded
outcome instead of acting twice.

### Environment

`server.ts` composes provisioning from these and nothing else. Values are read
through getters, so no secret is copied into a descriptor, a log line or a
response. **Off unless `REALBUD_ENABLE_PROVIDER=1`**, the same gate the model
providers use; while it is off the routes answer 503 `provisioning_disabled` and
no transport is handed to the Composio or Modelvia clients at all.

| Variable | Required when enabled | What it is |
| --- | --- | --- |
| `REALBUD_ENABLE_PROVIDER` | gate | `1` composes provisioning; anything else leaves it off |
| `REALBUD_GATEWAY_SECRETS_DIR` | yes | absolute 0700 directory; one 0600 file per secret name |
| `REALBUD_GATEWAY_CONNECTOR_REGISTRY` | yes | absolute path of the device registry |
| `REALBUD_GATEWAY_PUBLIC_ORIGIN` | yes | this service's HTTPS origin, put into `connector.endpoint` |
| `REALBUD_COMPOSIO_ORG_KEY` | yes | `x-org-api-key`; vendor credential, never customer-held |
| `REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL` | yes | the reviewed Gmail read-only OAuth configuration id |
| `REALBUD_COMPOSIO_API_BASE` | no | test/self-hosted seam; set but unusable fails closed |
| `REALBUD_MODELVIA_BASE_URL` | yes | Modelvia service origin, normally `https://api.modelvia.dev` (origin only, no path) |
| `REALBUD_MODELVIA_OPERATOR_SECRET` | yes | Modelvia operator **HMAC secret**, >=32 chars; vendor-held |
| `REALBUD_MODELVIA_OPERATOR_SUBJECT` | yes | operator subject recorded in Modelvia's audit trail |
| `REALBUD_MODELVIA_CLIENT_ID` | yes | RealBud's platform client account id at Modelvia |
| `REALBUD_MODELVIA_MODELS` | no | comma-separated `allowedModels` for each project; default `auto` |
| `REALBUD_MODELVIA_ENVIRONMENT` | no | `production` (default) or `development` |

Modelvia's operator auth is a **short-lived HMAC bearer, not a static token**
(`operator-token.ts` on `codex/neon-release` requires `exp > now` and
`exp - iat <= 300000`). This service holds the secret and mints a fresh two-minute
bearer per request; a fixed token pasted into an env var would 401 minutes after
issue. Neither the secret nor a minted bearer is ever logged.

`GET /ready` is the platform health check and is declared as such in `fly.toml`:
200 `{ready:true}` only when provisioning is composed, otherwise 503 with the same
reason code. A misconfigured deployment fails its health check rather than quietly
serving 503s to the portal.

A deployment that sets the gate but misses one of these boots normally and answers
503 `provisioning_unconfigured:<VARIABLE_NAME>` on `/ready` and on both routes — the name of the
one thing to fix, never its value. A malformed value (a non-HTTPS public origin, a
relative secrets directory) reports a code the same way. The startup log line
carries the same code under `provisioning`, so an operator sees it without sending
a request. Nothing half-built is ever composed.

**The file-backed secret store is a next-to-an-operator arrangement, not managed
custody.** It inherits the trust of whoever owns the filesystem. A hosted
deployment swaps `fileSecretStore` for the platform secret manager (KMS-backed,
with its own audit trail and rotation) before the vendor-only custody claim holds.

`deploy.sh` sets every one of these as a Fly secret and refuses to run when any is
unset (it names the missing ones and never echoes a value); `fly.toml` carries only
the non-secret paths — `REALBUD_GATEWAY_SECRETS_DIR=/data/secrets` and
`REALBUD_GATEWAY_CONNECTOR_REGISTRY=/data/connectors.json`, both on the mounted
volume so an issued credential and a stored project key survive a restart — plus
`REALBUD_MODELVIA_BASE_URL`. `REALBUD_GATEWAY_PUBLIC_ORIGIN` differs per
deployment and is set by `deploy.sh`.

**Composed but never run against a real provider.** No real organisation key has
been used, no real Composio project has been created from here, and no real
Modelvia key has been minted. The local proof is `provisioning.test.ts`,
`composio-org.test.ts`, `modelvia-keys.test.ts` and leg 1 of `pnpm smoke:sandbox`,
all against injected fakes. Deployment remains a separate authority.

## Square billing

Square sandbox and production are **separate hosts** (`connect.squareupsandbox.com`
vs `connect.squareup.com`) with separate tokens. The client picks the host from
`REALBUD_PAYMENT_MODE`: `sandbox` uses the sandbox host, every other mode uses
production. The host is never inferred from the token, so a sandbox token cannot
reach the real account and a production token cannot silently draft into nowhere.

Required together, or `square` stays `null`:

```
SQUARE_ACCESS_TOKEN=…            # sandbox or production, matching the mode
SQUARE_NOTIFICATION_URL=…        # https, and the exact URL registered in Square
SQUARE_WEBHOOK_SIGNATURE_KEY=…
```

### What works today

A **draft** tax invoice, plus reconciliation and signature-verified payment and
refund webhooks. `SquareBilling` deliberately has **no publish, send, charge or
refund-creation method** — so nothing here can take money.

**Collection is not wired.** `BillingService` is still handed the local checkout
simulator because `SquareBilling` does not implement `HostedPaymentAdapter`
(`createCheckout` / `verifyWebhook` / `requestRefund` / `verifyRefundWebhook`).
`server.ts` refuses to boot if you set `REALBUD_AUTHORIZE_COLLECTION=1` without a
real adapter, because checkout would otherwise return `https://checkout.invalid/…`.
Keep that flag **unset** until the adapter exists.

### Sandbox smoke test

Proves our code against the **real** Square API. The unit suite in `square.test.ts`
runs against a hand-written fake, so it only validates our assumption of Square's
request and response shapes; this catches a wrong field name, API version or host.

```bash
cd managed-gateway
pnpm smoke:sandbox          # reads SQUARE_ACCESS_TOKEN from .env.local
```

It pins the host to sandbox, uses a throwaway in-memory ledger, creates a draft
invoice only, and prints no secret. Exit 0 means the flow works end to end.

The script now has two legs. Leg 1 runs the provisioning flow (provision →
connector status → revoke) **offline against fakes** and always runs. Leg 2 is the
Square sandbox check above; without `SQUARE_ACCESS_TOKEN` it prints `SKIPPED` and
the script exits 0 on leg 1 alone. Exit 0 with that banner is not Square proof.

Store the token so it never reaches shell history or a transcript:

```bash
read -rs -p "Square sandbox access token: " T && echo
printf '\nSQUARE_ACCESS_TOKEN=%s\n' "$T" >> .env.local
unset T
```

`loadLocalEnv` does not strip quotes, so write the raw value.

Card entry stays on Square.

## Clerk invites

After the Vercel Clerk app exists: create the user (or invitation) for the agency email, then insert `billing_accounts` for that `user_…` id. Same `company_id` as the OpenAI key mapping.
