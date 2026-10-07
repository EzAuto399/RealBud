# RealBud managed gateway: deployment

The gateway runs on Fly (Sydney) from `deploy.sh` and `fly.toml`. The website runs on Vercel. Deployment is a separate authority: `deploy.sh` needs a human `fly auth login` and exported secrets, and never runs from a coding session. `deploy.sh --check` runs only the validation and changes nothing at Fly. The Modelvia credential for this gateway is a RealBud-scoped HMAC secret, bound to the `realbud` client by Modelvia's `MODELVIA_REALBUD_CLIENT_ID`.

**Modelvia is the only source of AI rates, caps, usage and AI invoices** ([decision, 24 September 2026](../docs/decisions/2026-09-24-modelvia-sole-billing.md)). The gateway keeps installation provisioning and revocation, connectors, service entitlement, `/health` and `/ready`, and collects **one monthly RealBud invoice per office** through Square against the office's accepted monthly commercial terms: the care fee plus, for a customer office that accepted AI resale (owner decision, [26 September 2026](../docs/decisions/2026-09-26-modelvia-commercial-terms.md)), one "AI usage" line per finalized Modelvia customer invoice at its exact total and GST ([Care fee collection](#care-fee-collection-square)). It has no AI rate, usage, limit or model route of its own, and it needs no OpenAI, DeepSeek or Kimi credential.

## Global-secret cutover

1. Configure and deploy Modelvia with `MODELVIA_REALBUD_SCOPED_SECRET` and `MODELVIA_REALBUD_CLIENT_ID=realbud`. Verify its scoped token is rejected for another audience or client before changing this gateway.
2. Export the same protected value as `REALBUD_MODELVIA_SCOPED_SECRET` for this gateway, run `deploy.sh --check`, and deploy. Keep `REALBUD_MODELVIA_CLIENT_KEY` for invoice and margin reads. Never copy Modelvia's global operator secret into the scoped variable.
3. Check `/ready`, then exercise an existing RealBud office's AI access and installation key provisioning/revocation. Verify client and project ancestry at Modelvia; `/ready` only checks local configuration.
4. Remove `REALBUD_MODELVIA_OPERATOR_SECRET` from Fly's stored secrets and the old protected deployment entry. Recheck `/ready` and a scoped operation after the restart. Revoke the global Modelvia operator credential only after its other authorized users have replacement credentials.

For the first **customer-paid** office, Modelvia refuses a new customer with `billingCompanyId` under this scoped credential. RealBud returns 409 `modelvia_billing_binding_operator_required` and leaves the attempted customer creation unapplied. A Modelvia global operator must verify that a Modelvia billing account exists with the reviewed RealBud office company id, then create that customer once under client `realbud` with `billingCompanyId` set to that exact id. Verify the immutable binding and billing account before retrying the same RealBud office AI access request. The gateway never falls back to a global credential. A customer already bound to another office is refused with 409 `modelvia_billing_account_bound`; do not retry against another office id.

## Order of operations

1. **Deploy.** Export the variables below, then run `managed-gateway/deploy.sh`. It validates every variable before touching Fly, names each missing one without echoing a value, stages the secrets over stdin and deploys once. It generates no secret: every value is a stable one recovered from protected storage, so a redeploy rotates nothing.
2. **Check readiness.** `curl -fsS "$REALBUD_GATEWAY_URL/ready"`. A 200 response means provisioning is composed. A 503 response names the variable still to set, never its value. Both responses report `modelviaOperator` and `operatorAccess` (`configured|missing`). The legacy `modelviaOperator` field reports only the scoped credential's local presence. `/ready` makes no network call and cannot prove Modelvia accepted it. The startup log line also reports `careCollection` (`off|sandbox|live`).
3. **Create each office's service entitlement** with the operator route (same operator token as [Office AI access](#office-ai-access); no SSH):

   ```
   PUT /v1/operator/offices/entitlement          Authorization: Bearer <operator token>
     { "companyId": "…", "licenseId": "…", "name": "<legal name>", "address": "<address>",
       "evidence": "<ticket>", "goLiveEvidence": "<signed-order-ref>",
       "goLive": "YYYY-MM-DD", "expires": "YYYY-MM-DD", "active": true }      ("active" optional)
   → { "result": "created" | "updated" | "unchanged",
       "entitlement": { companyId, licenseId, active, serviceAvailable, goLiveAt, serviceExpiresAt, customerName, customerAddress } }
   GET /v1/operator/offices/entitlement?companyId=…  → { "entitlement": { … } } or 404 not_found
   ```

   It applies the command's rules (`entitlementFromFlags` in `entitlement-cli.ts`) and the same ledger write, so the same input gives the same stored entitlement and the same error codes. Every field is sent on every call; an ABN set with the command is kept. Sending what is already stored answers `unchanged` and changes nothing. Requests are serialized per company, and each success adds an `operator_entitlement_set` ledger line with the operator subject, company and result. It needs only `REALBUD_GATEWAY_OPERATOR_SECRET`, not the Modelvia variables. Errors: 401 `operator_unauthenticated` (a portal token is never accepted); 503 `operator_unconfigured`; 400 `invalid_entitlement` (wrong fields or types, empty strings), `invalid_go_live` (not a YYYY-MM-DD date, or after today), `invalid_service_expiry` (not a YYYY-MM-DD date, or not after go-live), `invalid_id`, `customer_identity_required`; 409 `license_id_immutable` when the company is already bound to a different licence.

   **Fallback** when the route is not reachable: the same write on the machine (`fly ssh console -a realbud-managed-gateway`, then `cd /app/managed-gateway`):

   ```sh
   node --experimental-strip-types entitlement-cli.ts set --company <companyId> --evidence <ticket> \
     --license <licenseId> --name "<legal name>" --address "<address>" \
     --go-live <YYYY-MM-DD> --go-live-evidence <signed-order-ref> --expires <YYYY-MM-DD>
   ```

   `--go-live` must be today or earlier, and `--expires` must be after `--go-live` (otherwise `invalid_go_live` or `invalid_service_expiry`). The command opens `/data/ledger.sqlite`, the database the server uses. It refuses to create a database, so a wrong path fails loudly. Without an entitlement, provisioning answers 403 `tenant_unavailable`. Suspend an office with `--active false`. Renew by setting a later `--expires`; existing connectors follow the current entitlement, so they keep working without reprovisioning.
4. **Set the office's AI access** with `POST /v1/operator/offices/ai-access` (see [Office AI access](#office-ai-access)). `default` creates the office's Modelvia customer under `REALBUD_MODELVIA_CLIENT_ID` with the A$200 cap, then its commercial terms (the response's `terms.state` must read `active`, `pending` or `not_required`). A customer office reads `acceptance_required` until its billing owner has accepted the month's terms with `aiUsage` (step 6); save its AI access again after that acceptance. Without an active customer with a non-zero cap and terms in force, provisioning answers 409 `modelvia_customer_not_ready` and creates nothing. This route is also the only way to bind a client-paid office to its Modelvia customer (no CLI does it). An existing office that never went through it, because it was provisioned before the gateway failed closed, is refused with 409 `office_customer_unbound` on its next provision, redelivery or cap refresh: save its AI access once with its current customer id and access mode before then.
5. Set the website's `REALBUD_GATEWAY_URL` to the app origin (`fly status -a realbud-managed-gateway`) and `REALBUD_GATEWAY_PORTAL_SECRET` to the same value as the gateway. Secrets never go in a `NEXT_PUBLIC_` variable.
6. **Publish each office's monthly care terms and its Square mapping** on the machine, then let the office's billing owner accept and pay ([Care fee collection](#care-fee-collection-square)).

## Environment

| Variable | Required | What it is |
| --- | --- | --- |
| `REALBUD_GATEWAY_PORTAL_SECRET` | yes | portal bearer secret, >=32 chars, shared with the website BFF |
| `REALBUD_GATEWAY_OPERATOR_SECRET` | yes | RealBud operator bearer secret, >=32 chars, different from the portal secret. `deploy.sh` refuses a missing, short or equal value; at runtime the same leaves operator routes off (503 `operator_unconfigured`, `/ready` `operatorAccess: missing`). Held only by the operator console that mints operator tokens |
| `PLATFORM_BIND_HOST` | fly.toml | listen address, `0.0.0.0` on Fly |
| `REALBUD_GATEWAY_DATA` | fly.toml | `/data`, the mounted volume; the ledger is `ledger.sqlite` inside it |
| `REALBUD_ALLOWED_ORIGINS` | fly.toml | browser origins admitted; default `https://realbud.app,https://www.realbud.app` |
| `REALBUD_ENABLE_PROVIDER` | gate | `1` composes provisioning; anything else leaves it off (`provisioning_disabled`) and hands no transport to any client |
| `REALBUD_GATEWAY_SECRETS_DIR` | fly.toml | absolute 0700 directory on the volume; one 0600 file per Composio project key |
| `REALBUD_GATEWAY_CONNECTOR_REGISTRY` | fly.toml | absolute path of the connector device registry on the volume |
| `REALBUD_GATEWAY_PUBLIC_ORIGIN` | yes | this service's HTTPS origin, put into `connector.endpoint` |
| `REALBUD_COMPOSIO_ORG_KEY` | yes | Composio `x-org-api-key`; a vendor credential, never held by customers |
| `REALBUD_COMPOSIO_WEBHOOK_BASE_URL` | no (opt-in) | this gateway's HTTPS origin (normally the same value as `REALBUD_GATEWAY_PUBLIC_ORIGIN`). Set, each office project gets its Composio webhook subscription ([Event triggers](#event-triggers-composio-webhooks)); unset, none is made and the trigger routes have nothing to receive. A value that is not a bare `https://` origin answers `provisioning_unconfigured:connector_webhook_base_invalid`. `deploy.sh` does not stage it: set it with `fly secrets set` |
| `REALBUD_OAUTH_GOOGLE_CLIENT_ID`, `REALBUD_OAUTH_GOOGLE_CLIENT_SECRET` | no (both or neither) | RealBud's own Google OAuth client. With both, new Gmail and Google app auth configs use it (`realbud-<slug>-own-v1`) instead of Composio's shared client, which Google blocks for any `gmail.readonly` override; without them Gmail uses Composio's default managed scopes (`realbud-gmail-managed-v2`), read-only at the gateway. Allow redirect URI `https://backend.composio.dev/api/v3/toolkits/auth/callback`. Half a pair answers `connector_oauth_app_unconfigured:<NAME>`. See docs/MANAGED-CONNECTIONS-OPERATIONS.md |
| `REALBUD_OAUTH_MICROSOFT_CLIENT_ID`, `REALBUD_OAUTH_MICROSOFT_CLIENT_SECRET` | no (both or neither) | Same, for Outlook, OneDrive, Teams, SharePoint, OneNote and To Do |
| Gmail auth config | automatic | Provisioning resolves or creates a Gmail OAuth2 config inside each office's Composio project: `realbud-gmail-own-v1` (`gmail.readonly` only) with the Google client secrets, otherwise `realbud-gmail-managed-v2` (Composio's default scopes, no override; the gateway's three read tools keep it read-only). Its project-scoped ID stays on the gateway; do not supply one deploy-wide ID. |
| `REALBUD_MODELVIA_BASE_URL` | fly.toml | Modelvia origin, `https://api.modelvia.dev` |
| `REALBUD_MODELVIA_SCOPED_SECRET` | yes | Modelvia RealBud-scoped HMAC secret, >=32 chars, distinct from the old global Modelvia operator secret and the gateway's portal/operator secrets. A fresh two-minute `managed-ai-realbud` bearer is minted per request; a static token would 401. Modelvia binds it to `MODELVIA_REALBUD_CLIENT_ID` server-side |
| `REALBUD_MODELVIA_OPERATOR_SUBJECT` | yes | operator subject in Modelvia's audit trail |
| `REALBUD_MODELVIA_CLIENT_ID` | yes | RealBud's platform client id at Modelvia; only customers under it are provisioned into |
| `REALBUD_MODELVIA_MODELS` | yes | comma-separated Modelvia route ids, written as `allowedModels` on each customer and project RealBud creates. There is no default, and `auto` is refused as an entry (`provisioning.ts` `composeModelvia`, `deploy.sh`): Modelvia matches `allowedModels` against concrete route ids, so `auto` there admits no route at all (an empty `/v1/models`, every chat 503). `auto` is what the desktop REQUESTS (`MANAGED_MODEL_DEFAULT` in `server/hermes-pack.ts`), and Modelvia serves it from whichever routes this list admits, by the account's `auto` strategy. Unset or `auto` answers `provisioning_unconfigured:REALBUD_MODELVIA_MODELS` on `/ready`. On the r4 menu set `deepseek-v4.1-flash,claude-sonnet-5.5`, so a new office reaches both `flash` and `max` ([Model menu r4](#model-menu-r4-deepseek-flash-and-claude-sonnet-55)) |
| `REALBUD_MODELVIA_ENVIRONMENT` | no | `production` (default) or `development` |
| `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` | no | per-request cap on each installation project, a positive integer in nanoAUD; default `4000000000` (A$4). Clamped to the customer's monthly cap. Modelvia holds each request's bound up front. On r4 the hold is sized from the prompt: a short prompt holds about A$0.63 on `claude-sonnet-5.5` and A$0.11 on `deepseek-v4.1-flash`, and a prompt near the window about A$4.74 and A$0.39. A cap below a route's hold drops that route: `auto` serves another, and an explicit `max` (or no route left) is 402 `project_request_cap_exceeded`. A malformed value answers `provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` |
| `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES` | for terms | comma-separated RealBud companyIds whose AI RealBud absorbs (the owner's and internal offices). Setting AI access for one of them writes a `client_funded` commercial policy at Modelvia. Unset: no office gets client-funded terms |
| `REALBUD_MODELVIA_CLIENT_FUNDED_REFERENCE` | no | acceptance reference on those policies; default `realbud-owner-decision-2026-09-24-internal-ai` |
| `REALBUD_INVOICE_TERMS_DAYS` | no (default `7`) | days from issue to due date on new RealBud invoices (owner decision, 29 September 2026). 0 to 365; a malformed value refuses to start |
| `REALBUD_PAYID`, `REALBUD_PAYID_NAME` | no | PayID shown under "How to pay" on invoices, the invoice email and the client billing page. Both or the PayID is not shown |
| `REALBUD_BANK_ACCOUNT_NAME`, `REALBUD_BANK_BSB`, `REALBUD_BANK_ACCOUNT_NUMBER` | no | bank transfer details for "How to pay". All three, a 6-digit BSB and a 4–10 digit account, or bank transfer is not shown. Non-secret, but staged as secrets by `deploy.sh` when exported |
| `REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS`, `REALBUD_MODELVIA_RESALE_TERMS_REFERENCE` | yes (production `3000`, `realbud-office-terms-2026-09-26-ai-resale-30pct`) | both or neither; `deploy.sh` sets the production values when unset and validates them. With both, the markup (0 to 10000) is the DEFAULT for new office terms only; each office is priced at the markup in the terms ITS billing owner accepted, and AI access for any office not listed above writes a `resale` policy at that accepted markup once the office has accepted monthly terms carrying `aiUsage` (see [Office AI access](#office-ai-access)); the policy's `acceptanceReference` is `<terms reference>@<first 32 hex of that office's acceptance digest>`, never one shared value. The reference is an id (at most 160 characters). A malformed terms variable leaves the office AI access route off (503 `operator_unconfigured`) |
| `REALBUD_MODELVIA_CLIENT_KEY` | yes | RealBud's Modelvia client integration key (`mgt_<16 hex>_<43>`), the same credential the website holds as `PLATFORM_CLIENT_KEY`. Read only here: month close reads each resale office's finalized Modelvia customer invoices with it, and the margin view reads Modelvia's analytics. Absent: a resale office's close answers 503 `modelvia_client_unconfigured` and the margin view shows the Modelvia columns as unavailable. Never logged or returned |
| `REALBUD_PAYMENT_MODE` | fly.toml | care-fee collection: `local` (default; invoices close and read, checkout answers 503 `payment_provider_unselected`), `sandbox` or `live` |
| `REALBUD_INVOICE_EMAIL_MODE` | no | `off` (default) or `resend`; explicit `resend` enables CLI delivery and the server's bounded retry drain. It does not schedule monthly invoice close or affect checkout |
| `REALBUD_INVOICE_RESEND_API_KEY` | `resend` only | dedicated protected Resend Sending key. Do not use the Supabase Auth SMTP credential |
| `REALBUD_INVOICE_FROM` | `resend` only | one verified sender mailbox, such as `billing@notify.realbud.app`; the exact address is frozen on the first invoice attempt |
| `REALBUD_INTERNAL_COMPANY_ID` | care routes and invoice email | RealBud's own company id. Never invoiced, mapped or checked out. Unset, care routes answer 503 `commercial_terms_unavailable`; `resend` invoice mode refuses to start |
| `REALBUD_AUTHORIZE_COLLECTION` | sandbox, live | must be `1`; the explicit statement that this deployment collects money |
| `SQUARE_ACCESS_TOKEN` | sandbox, live | Square token for the matching host (sandbox and production are separate hosts with separate tokens; the host follows the mode, never the token). Needs `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENTS_READ`, `PAYMENTS_WRITE` |
| `SQUARE_MERCHANT_ID`, `SQUARE_LOCATION_ID` | sandbox, live | RealBud's Square merchant and its active AUD location; every checkout re-reads both from Square first |
| `SQUARE_NOTIFICATION_URL` | sandbox, live | exactly `https://<this gateway>/v1/webhooks/square`, the URL registered in the Square webhook subscription; the signature is bound to it |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | sandbox, live | the subscription's signature key |
| `REALBUD_SELLER_BASIS_DIGEST` | live | the reviewed seller-basis digest printed by `commercial-cli.ts publish`; a checkout whose accepted terms carry another seller basis is refused (403 `seller_basis_not_approved`) |
| `REALBUD_SELLER_BASIS_APPROVAL_REF`, `REALBUD_PRODUCTION_INVOICE_APPROVAL_REF`, `REALBUD_MANAGED_PROJECT_VERIFIED_REF` | live | operator attestations that the seller/tax basis, the production invoice document and the Modelvia project set-up were reviewed. References only: code cannot verify the facts behind them |
| `REALBUD_SELLER_LEGAL_NAME`, `REALBUD_SELLER_ABN`, `REALBUD_SELLER_ADDRESS`, `REALBUD_TAX_TREATMENT_REF`, `REALBUD_SELLER_VERIFICATION_REF`, `REALBUD_CUSTOMER_TERMS_REF`, `REALBUD_CARE_AGREEMENT_REF` | billing plans | the seller (owner decision, 29 September 2026: Yo-Da Lai, sole trader, ABN 84 992 526 369, GST registered), the GST treatment reference and the reviewed reference ids the gateway writes into every month's terms it publishes from an office's billing plan ([Billing plans](#billing-plans-accept-once-roll-forward)). All seven or none; the plan routes answer 503 `billing_plan_unconfigured:<NAME>` until every one is set, and in `live` mode the digest of this seller basis must equal `REALBUD_SELLER_BASIS_DIGEST` (else `billing_plan_unconfigured:REALBUD_SELLER_BASIS_DIGEST`). Non-secret; `deploy.sh` validates and stages them |

A missing or malformed provisioning variable leaves the server running, answering 503 `provisioning_unconfigured:<NAME>` on `/ready` and on both provisioning routes. A `sandbox` or `live` payment mode with a Square variable missing refuses to start with `care_collection_unconfigured:<NAME>`, so a deployment that asked to collect can never silently run with collection off; `deploy.sh` applies the same rule before any Fly change. The startup log line carries these codes and never a value. The file-backed secret store inherits the trust of whoever owns the filesystem. It is not managed custody until it is swapped for a KMS-backed secret manager.

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
2. The Modelvia customer, a read only. It must be bound to this office: a customer-paid customer's `billingCompanyId` must be the `companyId`; a client-paid customer must not be recorded for another office, nor this office for another customer, by the office AI access route. Otherwise 403 `modelvia_customer_not_bound`, before anything is created. A client-paid customer needs that binding to exist: an office never set through that route is refused with 409 `office_customer_unbound` until an operator sets its office AI access once. The binding is never taken from the request body. Redelivery and cap refresh repeat this check, and the `rb-<installationId>` project check, before touching a key or project.
3. It journals the attempt.
4. It creates or reuses the company's Composio project and its Gmail read-only auth config. The `ak_` key stays in the secret store; the auth config ID is scoped to that project.
5. It admits the `rbc_` connector credential by hash.
6. It creates `rb-<installationId>` under the customer, with the customer's monthly cap and concurrency. The request cap is `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` (default A$4), never above the monthly cap.
7. It mints one key labelled `<companyId>:<installationId>`.

Before step 3, a customer RealBud's client pays for must have a commercial policy in force at Modelvia (see [Office AI access](#office-ai-access), "Terms"). Without one every request would be refused with `customer_terms_required`, so provisioning answers 409 `modelvia_customer_not_ready` and creates nothing, the same answer the website already maps to "set the office's AI access". A delivered installation is not re-checked.

Every installation of an office shares the office's one Composio project and its key; concurrent first provisions of one office create it once. If the new project's key cannot be written to the secret store, the new project is deleted and the call answers 503 `connector_project_key_unwritable`; a resume after `PENDING_RESUME_AFTER_MS` starts clean. If that delete is not confirmed either, provisioning answers 409 `connector_project_key_unavailable` until an operator removes the keyless project. Two projects with the office's name are 409 `connector_project_ambiguous`. The connector routes read each office's key from the same secret store (`REALBUD_GATEWAY_SECRETS_DIR`), falling back to a same-named environment variable only for devices registered by the operator CLI.

Each office's auth config must be confirmed by that office's project key before a device is admitted: Gmail OAuth2, enabled, the expected name, and either Composio-managed (default scopes) or own-client with exactly `gmail.readonly` plus permitted sign-in scopes. If config creation has an uncertain outcome, reconcile that project's configs before resuming; do not create another config blindly. Existing ready device bindings keep their saved auth config IDs, except that a device with no active Gmail account under a superseded config moves to the current one on its next Gmail connect (docs/MANAGED-CONNECTIONS-OPERATIONS.md).

The billing owner chooses `personal`, `shared` or `both` Gmail on the website's Computers page (`both`: each person's own Gmail, and granted computers may also use the office mailbox when a request selects it with `x-realbud-mailbox: office` or names its confirmed account). The gateway stores this office policy and a monotonically increasing revision. In shared mode, owner-only `/v1/portal/mailbox/{authorize,verify,confirm,grants}` connects one private office account, confirms its actual Google address and grants named installations. `/v1/portal/mailbox` reads the current policy; `/v1/portal/mailbox/policy` changes the mode. All mutations require `expectedRevision`; the portal bearer determines the company. Mode changes clear grants and require fresh address confirmation, except `shared` <-> `both`, which keeps the confirmed mailbox, its grants and full access (the revision still moves). A lapsed owner link is replaced by `authorize` once the provider says its account never connected. Each failed mailbox operation logs one line with the operation and error code only. A grant is bound to the installation's current connector credential: a credential redelivery (`redeliver: true`) moves it to the new credential in the same transaction, without a revision change; revoke never does, and a revoked installation cannot be redelivered. A desktop receives only a disconnected or granted Gmail status plus the policy revision, never the project key or candidate address. Reads require the reviewed revision after a policy change. Uncertain OAuth outcomes need operator reconciliation.

The first successful call returns the connector credential and model key once. A repeat call returns the same descriptor without them and asks Modelvia nothing. An interrupted call can be resumed after `PENDING_RESUME_AFTER_MS`. The resume reuses the same project, rotates the one labelled key, and never mints a second key.

Caps are copied at provisioning. After an office's Modelvia customer changes its monthly cap or concurrency, re-apply them on the machine:

```sh
node --experimental-strip-types caps-cli.ts apply --company <companyId>
```

It needs the Modelvia operator variables. It reads the customer once and updates every `ready` installation project of that company; pending and revoked installations are skipped. It prints installation ids and `applied`/`failed` states only, with an error code per failure, and exits non-zero unless every installation applied. One failure never stops the others; rerun it to retry.

`revoke` does not need an entitlement. It deactivates the device, then revokes the model key. The Modelvia project is left in place. The Composio project is deleted only on an explicit `deleteProject: true`, which is irreversible. The Composio project and its key belong to the whole office, so `deleteProject: true` is refused with 409 `connector_project_in_use`, before any effect, while another installation of the office is ready or pending; revoke those first. A retried delete that finds the project already gone records `projectAlreadyAbsent` and removes the stored key. Revoke writes one audit line, with no secret in it.

## Connect any app (30 September 2026)

An office is not given a fixed app set. Its Composio project is the office's;
each desktop installation is a user in it (`installation-<installationId>`).
When a person asks Bud "connect Xero" (or Slack, Outlook, any Composio
toolkit), the desktop posts `{ "app": "xero" }` to `/v1/connectors/authorize`
with its own `rbc_` credential, and the gateway admits the app on demand:

1. The slug is checked by shape (`^[a-z][a-z0-9_]{0,31}$`) and looked up with the
   office's project key (`GET /toolkits/{slug}`); a toolkit Composio does not
   know, or one without Composio-managed auth, answers 404
   `connector_app_unavailable` before anything is created.
2. Serialized per (office, app), the office's Composio-managed auth config
   `realbud-<slug>-managed-v1` is found or created in the office's own project,
   with the office's own key. The create intent is journaled first
   (`connector_office_apps` row `pending`); an uncertain create is never
   repeated, and stays 409 `connector_auth_config_create_unconfirmed` until an
   operator reconciles it.
3. The device's registry `apps` allowlist gains the slug (`admitApp`,
   `updateRegistry`), audited as `connector_app_admitted`.
4. `POST /connected_accounts/link` for the installation's user id returns the
   sign-in link; the link is journaled per (device, app) in
   `connector_app_links` exactly as Gmail's is in `connector_links`.

Gmail is untouched: its reviewed read-only config, its per-device
`authConfigId` binding, `connector_links` and the office mailbox policy all
stay as they were. A registry written before this reads as Gmail-only. The
provisioning body's `apps` may name any slugs (they are recorded, and their
configs are created at first connect); a repeat with a different list keeps
the recorded one rather than failing.

`GET /v1/connectors/status` reports every admitted app under `services`, plus
`apps` (the admitted list) and the union of tool names. A connected app's tool
names are classified (`shared/app-tool-policy.ts`): `read` and `review` are
listed, `blocked` (destructive, bulk, administrative) are dropped and refused
at `tools/call` as well. The MCP session is one transport over Gmail's fixed
adapter and one generic adapter per connected app; tool names route by
namespace and no tool outside an admitted, connected app is reachable. The
desktop shows its Allow card for `review` tools before dispatch; the gateway
executes only what the desktop sent.

### Operator: create the office project at office creation

```
POST /v1/operator/offices/{companyId}/connector-project
Authorization: Bearer <operator token>   (REALBUD_GATEWAY_OPERATOR_SECRET, operator-token.ts)
body: none, or {}
200 { "companyId": "…", "projectName": "realbud-<companyId>", "projectId": "pr_…", "state": "ready" }
409 { "companyId", "projectName", "state": "held",    "error": "connector_project_ambiguous" | "connector_project_key_unavailable" | "connector_project_key_orphaned" | "connector_webhook_ambiguous" | "connector_webhook_url_mismatch" }
503 { "companyId", "projectName", "state": "pending", "error": "<transient code>" }   — call again
404 { …, "state": "held", "error": "tenant_unavailable" }   — the ledger has no such office (entitlement first)
400 { …, "state": "held", "error": "invalid_id" | "invalid_connector_secret_reference" }
401 { "error": "operator_unauthenticated" }   503 { "error": "operator_unconfigured" | "provisioning_unavailable" }
```

Idempotent (`InstallationProvisioning.ensureOfficeProject`): the same call
provisioning makes at first link, so a project created here is the one every
installation of the office links into. The response never carries the `ak_`
key; it goes to the secret store under `REALBUD_COMPOSIO_PROJECT_<COMPANY>`.
The website's admin office form is wired to this route by a separate change.
With `REALBUD_COMPOSIO_WEBHOOK_BASE_URL` set, the same call also makes the
office project's webhook subscription (below), so calling it once per existing
office backfills them.

## Event triggers (Composio webhooks)

A desktop asks to be told when new mail arrives instead of polling Gmail.
Composio polls (Gmail new-message, at most every 15 minutes on
Composio-managed auth) and posts a signed event to this gateway; the desktop
pulls the event ids from here. Code: `composio-triggers.ts`.

```
POST /v1/webhooks/composio/{companyId}      Composio only; HMAC-signed, no bearer
POST /v1/connectors/triggers  { "app": "gmail", "event": "new-message", "enabled": true|false }   device credential
POST /v1/connectors/events    { "after": <seq> }   device credential, answers { events, cursor, gap, more }
```

- **Subscription.** `ensureOfficeProject` (first link, or the operator route
  above) creates the office project's one subscription under the office's own
  project key: `POST /webhook_subscriptions` with `webhook_url`
  `<base>/v1/webhooks/composio/<companyId>`, the four events and `version: "V3"`.
  Its signing secret goes to the secret store as
  `REALBUD_COMPOSIO_WEBHOOK_<SHA256(companyId), upper hex>` (one 0600 file, like the project key;
  hashed so no two offices can share a name).
  It is never logged, audited or returned; the audit line
  `connector_webhook_subscribed` carries the subscription id only.
- **Verification.** The path only selects the office's secret. The raw body
  (at most 256 KB) must carry `webhook-signature: v1,<base64 HMAC-SHA256 of "{webhook-id}.{webhook-timestamp}.{body}">`
  (any one of several space-separated signatures may match) and a timestamp
  within 300 s. An office without a stored secret answers like a bad
  signature (401), so offices cannot be enumerated.
- **What is kept.** Ids only: sequence, office, `webhook-id` (unique, so a
  redelivery answers `replayed`), body digest, trigger id, provider user, kind
  and the Gmail message id. Never a subject, sender, body or any other `data`
  field. A trigger id this office's registry does not hold, or one whose
  account or user differ, is refused (403 `composio_trigger_unknown`, audited).
- **Routing.** `installation-<id>` events reach only that computer;
  `office_<sha>` events only computers holding the office mailbox grant.
  Acknowledged rows are deleted (office rows once every granted computer has
  acknowledged them); anything else after 7 days. A cursor behind rows that
  aged out unread, or ahead of the ledger, answers `gap: true` and the desktop
  rescans. The pull skips the per-device busy lock and the mailbox policy
  revision check.
- **State.** `composio.connected_account.expired` and
  `composio.trigger.disabled` mark the trigger `expired` or
  `provider_disabled`; `GET /v1/connectors/status` reports `triggers` with
  that state. Enabling again (after a reconnect) restores `enabled`.
- **Disable.** The device's switch, its revoke (provisioning) and a mailbox
  mode change that retires a mailbox (`shared` retires personal mailboxes;
  any change except shared <-> both retires the office one) turn the instances
  off. The local state changes first, so their events are dropped; a provider
  failure is audited as `composio_trigger_disable_unconfirmed` and never
  blocks the revoke or the mode change. Disable such an instance in the
  Composio dashboard.

### Operator: secret storage and rotation

1. Set `REALBUD_COMPOSIO_WEBHOOK_BASE_URL` (`fly secrets set`) and restart.
2. Call `POST /v1/operator/offices/{companyId}/connector-project` once per
   existing office to create its subscription. `held` with
   `connector_webhook_url_mismatch` means the project's subscription points at
   another URL, and `connector_webhook_ambiguous` means it has more than one:
   fix them in the Composio dashboard first. `pending` (503) is safe to repeat.
3. **Rotate** an office's secret: delete the file
   `$REALBUD_GATEWAY_SECRETS_DIR/REALBUD_COMPOSIO_WEBHOOK_<SHA256(companyId)>`, then call
   the route in step 2. It finds the existing subscription, rotates its secret
   (`POST /webhook_subscriptions/{id}/rotate_secret`) and stores the new one.
   Deliveries in between answer 401 and Composio redelivers them. The same
   steps repair a secret lost from the store or a failed store
   (`connector_webhook_secret_unwritable`).

Unverified against a live Composio project: the subscription list and rotate
routes and their response fields, the signing key (the secret string as given),
the V3 payload fields, `GMAIL_NEW_GMAIL_MESSAGE` and its `{interval: 15}`
config, the trigger-instance upsert response field and the
`PATCH /trigger_instances/manage/{id}` `{status}` body. Every test runs against
a stubbed fetch.

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
- **Customer.** If Modelvia holds no customer with that id, one is created under `REALBUD_MODELVIA_CLIENT_ID` with `name`, concurrency 2 and the `REALBUD_MODELVIA_MODELS` models. Its billing binding follows the client's `billingMode` at Modelvia: `client` needs none; `customer` binds `billingCompanyId` to the office's `companyId`; `mixed` also sets `payer: "customer"`. That Modelvia billing account must exist first (409 `modelvia_billing_account_missing`; one already bound elsewhere is 409 `modelvia_billing_account_bound`). The route also records the office↔customer binding provisioning checks; a customer already bound to another office is 409 `modelvia_customer_bound_elsewhere`. An existing customer keeps its name, concurrency, models and bindings; only `active` and the cap change. A customer under another platform client is 409 `modelvia_customer_foreign`, and nothing is written. A stale version is re-read and retried once, then 409 `modelvia_customer_version_conflict`.
- **Projects.** After `default` or `custom`, the new cap is pushed to the company's ready installation projects, as `caps-cli.ts apply` does. `disabled` pushes nothing: Modelvia refuses serving for an inactive customer.
- **Terms.** After `default` or `custom`, the office's commercial policy. Modelvia refuses every request of a customer RealBud's client pays for until an active policy is in force (409 `customer_terms_required`). A company in `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES` gets `{payer: client, invoiceIssuer: client, collection: invoice, management: self_service, platformFeeBasisPoints: 0, clientMarkupBasisPoints: 0, customerBilling: client_funded}`, effective one minute before now. Any other office gets `resale` at the markup its billing owner last accepted (in monthly terms carrying `aiUsage`), under that acceptance's own reference, effective at Modelvia's own time (the `Date` header of its policy-list response); when the accepted markup differs from the resale policy in force, ONE new policy is appended and the old one is never changed (see [Per-office AI markup](#per-office-ai-markup)); until then nothing is written and the response reads `"terms": {"state": "acceptance_required"}` (save again after the acceptance). Without resale configuration it gets nothing (`"unconfigured"`). A client-funded policy already in force is kept as it is (`modelvia_terms_billing_mismatch` if the office accepted resale): changing who pays is a dated migration at Modelvia, never this route. A customer that pays Modelvia itself needs none (`not_required`). The response adds `"terms": {"state": "active"|"pending"|"not_required", "created", "policyId", "customerBilling"}`, or `{"state": "failed", "error": "<code>"}` (`modelvia_terms_payer_mismatch`, `modelvia_terms_clock_skew`, `modelvia_terms_refused`, `modelvia_terms_conflict`) without undoing the customer or caps; save again to retry. The audit line carries the policy id, never the customer id.
- **Moving an office to another customer.** The office's binding moves only when no installation would keep keys under the wrong customer: each installation's Modelvia project stays under the customer it was made in. While any installation of this office is not fully revoked (ready, pending, or revoking with key cleanup owed) under a different customer, or any other office's installation is still live under the requested customer, the route answers 409 `office_customer_rebind_has_installations` and writes nothing. To move an office's customer, disconnect its computers first (revoke every installation until it reports `revoked`), then set the new customer, then reconnect. An office that accepted AI resale cannot be moved at all (409 `office_customer_rebind_blocked`).
- **Custom caps** are whole cents: a multiple of `10000000` nanoAUD, from one cent to A$10,000.
- **Checks and audit.** The company must have an entitlement record (403 `tenant_unavailable` otherwise). Requests are serialized per company. Two ledger lines, `office_ai_access_requested` (before any Modelvia call) and `office_ai_access_set`, carry the operator subject, company, mode, cap and project results. They never carry the Modelvia customer id or a secret.
- **Errors.** 401 `operator_unauthenticated`; 503 `operator_unconfigured` (operator secret missing or equal to the portal secret, Modelvia operator variables missing, or `REALBUD_ENABLE_PROVIDER` not `1`); 409 `modelvia_customer_foreign`; 400 `invalid_ai_access`.

Minting operator tokens (the operator console) is not part of this service.

## Live Modelvia integration values

Checked against Modelvia `main` 49327ba, the build api.modelvia.dev served on 25 September 2026. Names and non-secret values only; secrets stay in protected storage and are exported only for `deploy.sh`.

| Variable | Value |
| --- | --- |
| `REALBUD_MODELVIA_BASE_URL` | `https://api.modelvia.dev` (fly.toml) |
| `REALBUD_MODELVIA_CLIENT_ID` | `realbud` |
| `REALBUD_MODELVIA_MODELS` | `deepseek-v4.1-flash,claude-sonnet-5.5` once Modelvia's r4 menu is live (until then live Modelvia serves `deepseek-v4.1-flash,kimi-k3`, recorded 26 September 2026). The customer and project allowlists must name served route ids; `auto` is what the desktop REQUESTS, and as an allowlist entry it matches no route (503 `model_route_unavailable`). Retired ids serve nothing: `kimi-k3` from r4, and earlier `hosted-canary-fast`, `hosted-canary-smart`, `deepseek-chat` and `deepseek-flash`. See [Model menu r4](#model-menu-r4-deepseek-flash-and-claude-sonnet-55) |
| `REALBUD_MODELVIA_ENVIRONMENT` | `production` (default) |
| `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD` | unset, or `4000000000` (A$4). This equals the request cap on RealBud's internal-cost billing account at Modelvia, which also caps every request |
| `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES` | the owner office's RealBud companyId: the company whose Modelvia customer is `realbud-owner` (the website derives `realbud-<companyId>`, so `owner` unless `REALBUD_PLATFORM_CUSTOMERS_JSON` binds it explicitly). Confirm it on `/admin/offices` before deploying |
| `REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS` | `3000` (Modelvia's rate + 30%, owner decision 26 September 2026) |
| `REALBUD_MODELVIA_RESALE_TERMS_REFERENCE` | `realbud-office-terms-2026-09-26-ai-resale-30pct` (RealBud's resale terms; each office's policy adds its own acceptance digest) |
| `REALBUD_MODELVIA_CLIENT_KEY` | secret; the `mgt_` client integration key issued for client `realbud` |
| `REALBUD_MODELVIA_OPERATOR_SUBJECT` | the operator subject Modelvia issued for this gateway |
| `REALBUD_MODELVIA_SCOPED_SECRET` | secret; never written here |

Modelvia objects this integration expects (created by Modelvia's operator, not by RealBud): the internal-cost billing account `rbco_1946641d97e347d5a0c297128b3aad22` (A$10/month, A$4/request), rate card `openrouter-2026-09-r2` accepted for it (on r4, `openrouter-2026-09-r4`: Modelvia admits no route whose model the accepted card does not price), client `realbud` (`billingMode: client`), customer `realbud-owner`, and its active client-funded policy `realbud-owner-internal-2026-09-25`. Saving the owner office's AI access keeps that policy and writes none. The billing account's A$10 monthly cap binds before the A$200 office default does. `rbco_…` is Modelvia's billing account id, not a RealBud companyId.

What the desktop sees from Modelvia for a RealBud key: receipts are `priceAudience: resale_customer`, `chargeDetail: all_in`, `description: "AI usage"`, with `usedBy` `{kind: customer|client_internal, displayName}`; a client-funded office's receipts are `priceBasis: withheld` (no price for the office, never zero). A completed request resent with the same `Idempotency-Key`, or a header-less identical body within 30 s of delivery, is 409 `request_already_processed` with the original receipt and no second charge; the case relay sends one key per logical request (`server/department-worker.ts`). A Stop or a provider failure before any answer text costs A$0.


### Model menu r4 (DeepSeek Flash and Claude Sonnet 5.5)

Source: Modelvia `feat/customer-routing-controls` eaef8a1 (29 September 2026), `docs/CUSTOMER-ROUTING-CONTROLS.md`, `docs/CATALOGUE-R4-SONNET.md` and `managed-gateway/catalogue.openrouter.example.json` there. Local tests at Modelvia only: not deployed, and its routes serve only once the Modelvia owner dates their review. RealBud's contract with it is `modelvia-live-contract.test.ts` (a stand-in, not Modelvia).

- **Menu.** Two models serve: `deepseek-v4.1-flash` (the default, mode `flash`) and `claude-sonnet-5.5` (mode `max`). `kimi-k3` and the `flash-max` configuration are retired. A caller's `model` may be `auto`, `flash`, `max`, `default` or a concrete id. A RealBud key's `GET /v1/models` lists the allowed modes, then `default` with `resolves_to` (the mode it resolves to carries `default: true`), then the allowed ids.
- **`auto` stays the desktop default.** With no `routing` on the account, every mode is allowed, `default` means `auto`, and `auto` uses Jev across both routes. `auto` is listed and served whenever the account allows it and admits a route. Modelvia refuses a routing write that allows `auto` with nothing to serve (`invalid_routing_auto`), so `MANAGED_MODEL_DEFAULT = "auto"` keeps working under any routing the operator sets.
- **`REALBUD_MODELVIA_MODELS=deepseek-v4.1-flash,claude-sonnet-5.5`.** Name both ids so a new office's customer and project admit `flash` and `max`; `auto` then routes between them. Naming only the flash id keeps a new office on flash (`max` answers 503 `model_route_unavailable`). Change it when r4 is live at Modelvia: set earlier, a new office would lose `kimi-k3` while Modelvia still serves it.
- **Existing offices keep their models.** RealBud never rewrites `allowedModels` on a customer or project that already exists (an AI access save or a cap push carries back what Modelvia holds), so the new value reaches new customers and new installation projects only. Modelvia serves `max` only when `claude-sonnet-5.5` is on RealBud's client, the office's customer AND the installation's project: it intersects all three. **The Modelvia operator must add `claude-sonnet-5.5` to client `realbud`, to every existing RealBud customer and to every existing installation project.** Until then those offices keep `auto`, `flash` and `default` on DeepSeek. A leftover `kimi-k3` entry is harmless: it matches no route.
- **Routing is the Modelvia operator's.** Per-account `routing` (allowed modes, default mode, `auto` strategy `jev`, `flash-only` or `escalate`, and a monthly cap on `max`) is set only by the Modelvia operator. RealBud never sends it: its whole-record writes omit `routing`, and Modelvia keeps the stored value. A mode an office is not allowed is 403 `mode_not_allowed`; an exceeded `max` cap is 402 `max_cap_reached` for an explicit `max`, while `auto` serves flash.
- **Sonnet parameters.** On `claude-sonnet-5.5` Modelvia omits `temperature`, `top_p`, `seed`, `presence_penalty`, `frequency_penalty` and `parallel_tool_calls: true`, and refuses `parallel_tool_calls: false` (400 `unsupported_parameter:parallel_tool_calls`; `auto` then serves flash, an explicit `max` gets the 400). RealBud's worker sends none of them: its recorded requests carry `messages`, `model`, `stream`, `stream_options` and `tools`, and the Hermes chat-completions transport it is pinned to never sets `parallel_tool_calls` (0.20.3 and 0.21.3). An all-in receipt shows neither the omitted parameters nor the served mode.
- **Onboarding lock.** Provisioning with the global operator secret (`REALBUD_MODELVIA_OPERATOR_SECRET`, as deployed today) is not affected by Modelvia's per-client onboarding lock. RealBud PR #25 moves provisioning to a RealBud-scoped Modelvia operator, which IS gated by the `delegation.customerProvisioning` switch on RealBud's client (closed until set), so before that cutover the Modelvia operator must enable it for client `realbud` (`npm run cli -- delegation set realbud --customers on`); otherwise a new office's customer and project are refused with 403 `onboarding_operator_only`. The scoped operator also checks a new record's `allowedModels` against its parents (400 `invalid_model_policy`), so `claude-sonnet-5.5` must already be on client `realbud` and on each existing customer before a new installation names it.

## Billing plans: accept once, roll forward

Owner decision, [29 September 2026](../docs/decisions/2026-09-29-operator-billing.md) (second part). Instead of publishing each month's terms by hand and asking the billing owner to accept every month, the operator sets ONE **billing plan** per office on the admin desk (`PUT /v1/operator/offices/billing-plan`, operator bearer, body `{companyId, startPeriod, includedMonths (0–24), careCents, aiBilling: 'resale'|'included', markupBasisPoints?, billingEmail?, tradingName?}`; `GET …?companyId=` reads it). `startPeriod` is the go-live month (the month the owner accepted the invite; month 1 of any included period), `includedMonths` the months with no care fee and AI included, `careCents` the GST-inclusive monthly care fee after them, `aiBilling` whether AI usage is then billed after each month at Modelvia's price plus the office's markup (`resale`, markup default `REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS`) or stays RealBud's cost (`included`; such an office belongs in `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES`). Austin Realty: `{startPeriod: "2026-09", includedMonths: 2, careCents: "12500", aiBilling: "resale"}`.

- **Publishing.** The plan publishes the office's terms for every month from `startPeriod` through next month that is not already closed, each carrying the digest-bound `billingPlan` block; a later month is published lazily (close list, close, portal terms read) and by the server's daily roll-forward. Seller, tax and reference ids come from the deployment variables above and the customer identity from the office's entitlement record; a browser body never states them. An included month is care `0` with no `aiUsage`; from the first billed month the terms carry the care fee and, for `resale`, `aiUsage` at the plan's markup.
- **Accept once.** The website's existing `GET /v1/portal/commercial-terms` shows the plan in the owner's words (`plan`: included months, the fee from which month, AI billed from which month) and never a markup basis point; `POST …/accept` of any one month of a plan version is the **anchor** acceptance of that version, and every other month of the version, published before or after, gets a **standing acceptance** (`commercial_acceptances` row, subject `standing:<anchor digest>`) in the same transaction as its terms or as the anchor. Nothing else creates acceptances. Accepting a `resale` plan is the office's acceptance of AI resale from its first month, so Modelvia is brought to the resale policy at once (a customer with no policy is refused every request, and a client-funded policy cannot become resale later); the included months' Modelvia invoices are absorbed instead.
- **Close.** An included month closes as an A$0 Tax Invoice with the one line "Included service — no charge" (`ai: included`, status `nothing_due`); the month is recorded in `office_ai_absorptions` (append-only) and the resale month's own accepted plan names it too, so no later close consolidates a Modelvia invoice for it or waits for one. A billed month closes as before: care plus the month's finalized Modelvia invoice lines.
- **Change.** `PUT` with the same content returns the current version; different content is a new version (`plan-v2`, …): closed months are untouched, every unclosed month is republished from the new version and the close list shows `plan_awaiting_owner` until the owner accepts one of them (agreement clause 7). Other close-list blockers: `no_billing_plan` (an office invoiced before, with nothing published for the month and no plan), and the code of a refused publication (for example `commercial_tenant_inactive`, or `ai_markup_differs_from_proposal` when a pending `propose-markup` disagrees with the plan's markup).

## Care fee collection (Square)

RealBud collects one monthly invoice from each office through RealBud's configured Square merchant: the care fee and, for a customer office that accepted AI resale, its AI usage, so the office pays ONE amount. Modelvia is still the only source of AI rates, usage and AI invoices: the AI line is the exact total and GST of the office's finalized Modelvia customer invoice (issued with RealBud as seller, `invoiceIssuer: client`), referenced by its `CI-…` number; the gateway prices nothing itself. A client-funded office (the owner's and internal offices) is never billed for AI. Card entry stays on Square; the gateway never sees a card.

The operator explicitly closes each month. Closing is local with invoice email off; in `resend` mode, the CLI attempts the invoice email after the durable close. Square checkout is a separate action:

1. **Review and publish the month's terms** on the machine. Review the seller identity, ABN, address and GST treatment, the office's identity (it must match its entitlement exactly), that office's exact monthly care amount (which may be zero) and the signed customer terms. Set optional `customer.billingEmail` only to the exact office-approved invoice mailbox; leave it absent when no recipient is approved. It is part of the accepted terms digest, and the gateway never guesses a recipient from website accounts. Create a JSON file shaped like `CommercialTermsDraft` in `commercial-terms.ts` with a unique `version` for the month and `"rateCards": []` (AI pricing is Modelvia's; any entry there is a reference only and never gates anything). For a customer office add `"aiUsage": {"billing": "resale", "termsReference": "realbud-office-terms-2026-09-26-ai-resale-30pct"}`; `publish` fills `markupBasisPoints` with the office's pending proposed markup, else its accepted markup, else the deployment default (a file may state it; one that disagrees with a pending proposal is refused, 409 `ai_markup_differs_from_proposal`): accepting those terms is the office's acceptance of AI resale, recorded once as the ledger event `ai_resale_terms_accepted` with the office's own Modelvia acceptance reference. Leave it out for client-funded offices. With `REALBUD_INTERNAL_COMPANY_ID` set, run

   ```sh
   node --experimental-strip-types commercial-cli.ts publish reviewed-terms.json
   ```

   It stores the immutable terms and prints the terms digest and the seller-basis digest. It sends nothing. The seller and tax references are operator attestations, not automatic legal verification.
2. **The office's billing owner accepts.** The website reads `GET /v1/portal/commercial-terms?period=YYYY-MM`, shows the full terms, then posts `POST /v1/portal/commercial-terms/accept` with exactly `{ "period": "YYYY-MM", "version": "…", "digest": "…" }`. A reader, another office or a stale version cannot accept; a later published version needs a new acceptance. A suspended office (`--active false`) cannot be published to, closed or checked out; an already issued checkout still reconciles.
3. **Record the office's Square customer mapping** once, from a reviewed file with `companyId`, `merchantId`, `locationId`, `customerId` and `evidence`:

   ```sh
   node --experimental-strip-types commercial-cli.ts map reviewed-square-mapping.json
   ```

   The merchant and location must be the deployment's own; the mapping is immutable and calls nothing. The actual payer may use any card; settlement binds the office's saved checkout attempt, order, merchant, location and exact AUD total, never a cardholder profile.
4. **Close the invoice** after the month ends:

   ```sh
   node --experimental-strip-types commercial-cli.ts close <companyId> <YYYY-MM> <termsVersion>
   ```

   The invoice (`RB-000001`, …) carries the accepted care line, any unapplied care credits, a rounding line and, when the terms carry `aiUsage`, each line of every finalized Modelvia customer invoice of this month or an earlier month since the office's first resale acceptance that is not yet consolidated: one per model (`AI usage — DeepSeek V4.1 Flash — 1,234 requests`), with who used it (user or project label) and the `CI-…` number as reference. Each AI line is that Modelvia line's exact cents and GST, and they sum exactly to the Modelvia invoice (409 `modelvia_invoice_lines_mismatch` otherwise); an itemized office (`charge-detail`) also keeps Modelvia's split (model usage, routing, service fee) when Modelvia itemizes for RealBud's client, an all-in office never does. The invoice names the office (registered and trading name, ABN, address, RealBud account id), the billing month, number, issue and due date (on receipt), and "Usage by <office>" with its Modelvia customer ID; its JSON adds `links.aiUsageCsv`, and `GET /v1/portal/invoices/{id}/ai-usage` (website `/api/account/invoices/{id}/ai-usage`) returns the per-request CSV: date/time, user, project, model, tokens in/out, amount and GST, from Modelvia's `requests.csv` joined with its client analytics; the invoice GST stays the inclusive GST of the one total (what Square's order shows), any cent of difference sitting on the care line. The close reads Modelvia under `REALBUD_MODELVIA_CLIENT_KEY` (with `REALBUD_ENABLE_PROVIDER=1`) and refuses an invoice that is not final, not RealBud's client or this office's customer, has another seller ABN (409 `modelvia_invoice_seller_mismatch`), or was paid or had a checkout started at Modelvia (409 `modelvia_invoice_payment_started`: the office could pay twice). `office_ai_consolidations` records which Modelvia invoice went onto which RealBud invoice, keyed by the Modelvia invoice id, so none is ever billed twice (409 `modelvia_invoice_already_consolidated`); the event `ai_usage_consolidated` carries the same.

   **Not finalized yet.** When Modelvia shows usage for the month (or pending or unpriced requests) but no finalized invoice for it, the close **waits**: 409 `modelvia_invoice_not_finalized`, nothing is written; finalize the customer invoice at Modelvia (operator draft + finalize) and close again. Only if the care fee must go out first, add `--defer-ai`: the invoice is care only, records `aiUsage.deferredPeriods` and the event `ai_usage_deferred`, and says so on the document; the next month's close includes the late Modelvia invoice, and waits again (or defers again) while a deferred month's invoice is still missing.

   **Guards (all 409, nothing written).** `modelvia_checkout_enabled`: Modelvia's `customerCheckout` for client `realbud` must be `off` (as it is live on 26 September), or the office could pay Modelvia directly as well; a Modelvia invoice offering a checkout or direct payment is `modelvia_invoice_payment_started`. `modelvia_invoice_before_acceptance`: an unconsolidated Modelvia invoice for a month before the office's first resale acceptance. `ai_usage_unconsolidated`: the month's terms carry no `aiUsage` but an office that once accepted resale still has Modelvia AI owed; publish terms with `aiUsage`. `gst_reconciliation_required`: the AI lines' own GST and the one total's GST differ by more than a cent (each AI line always keeps Modelvia's GST; a cent of rounding sits on the care line, or on a zero-amount "GST rounding adjustment" line when there is no care line). An office that accepted resale cannot be moved to another Modelvia customer (`office_customer_rebind_blocked`). Invoices for later months are skipped before they are validated. A month with no Modelvia usage closes with no AI line. Re-running a close returns the same invoice without calling Modelvia. It is bound to the acceptance, seller basis and exact total, and stays immutable. A fresh close atomically queues one invoice email when the accepted terms include `customer.billingEmail`; the CLI then attempts delivery only in `resend` mode. The website lists the invoice at `GET /v1/portal/invoices` and renders it at `…/{id}/document`.

   **Invoice email delivery.** The default `REALBUD_INVOICE_EMAIL_MODE=off` performs no email network call. After a separate owner review of the sending domain and recipient workflow, configure `REALBUD_INVOICE_EMAIL_MODE=resend`, `REALBUD_INVOICE_FROM` (one verified sender mailbox), and a dedicated protected `REALBUD_INVOICE_RESEND_API_KEY` with Sending permission. Set these in the operator CLI's protected environment; `deploy.sh` validates and stages them on Fly, but does not schedule a monthly close. Do not reuse Supabase Auth SMTP. The email body contains the full stored invoice; its account links use `https://realbud.app`. The close output includes the invoice ID, `email.state` and a provider ID on acceptance, never the address, invoice body or key. A delivery/configuration error does not roll back the closed invoice. With an accepted recipient, `close` exits **2** when email is not `provider_accepted`; `email-deliver` also exits **2** unless the provider accepted it. Read the printed invoice ID, state and `emailError` before retrying. Terms with no recipient still close successfully with `not_queued`. Run `commercial-cli.ts email-list <companyId>` to read up to 100 outbox states or `commercial-cli.ts email-deliver <companyId> <invoiceId>` to retry one invoice. Neither command backfills historical invoices that had no outbox intent.

   With `resend` enabled, the server checks up to eight due outbox rows every minute. It automatically sends only queued rows less than one hour old, plus retryable or stale-sending rows using their original frozen request. Older never-attempted queued rows show `manualReviewRequired` in `email-list`; review the office/recipient and use `email-deliver` explicitly. The outbox freezes the exact sender, recipient, JSON payload and Resend `Idempotency-Key` before its first call. A concurrent process waits for a one-minute lease; an uncertain timeout may retry the same bytes and key after one minute, for at most eight attempts and only within 20 hours of the first call. After that, on a changed sending key or a provider payload conflict, the state is `reconciliation_required`; check the Resend dashboard against the invoice and key before any manual action. A first definite Resend 401/403 with no earlier uncertain attempt is `rejected` with `provider_auth_rejected`: correct the sending key or sender, run `commercial-cli.ts email-repair-auth <companyId> <invoiceId> <review-reference>`, then run `email-deliver` for that invoice. The repair writes an audit event and a fresh idempotency key, but sends nothing itself. An uncertain attempt cannot use this repair path. `provider_accepted` means Resend accepted the request and returned its ID. Inbox delivery, bounce handling and office receipt are separate, unverified proof layers. No Square charge is made by email delivery.
5. **The billing owner pays** through `POST /v1/portal/invoices/{id}/checkout`. Before any Square write the gateway re-reads the merchant and location from Square and rechecks the office, its mapping, the accepted terms, the seller basis, the invoice digest and the exact amount. One idempotent payment link and order are created; the order's reference binds the invoice and terms digests, and its inclusive GST must equal the invoice's. The link is reused until it expires. The browser return proves nothing.
6. **Settlement** arrives on `POST /v1/webhooks/square`. The signature is checked over the exact raw bytes and the registered notification URL, the event's merchant and age are checked, then the payment is re-read from Square and must be `COMPLETED`, at RealBud's location, on the checkout's order, for the exact amount. Only then is the invoice marked paid, exactly once; `…/{id}/receipt` then answers. Payments for other orders in the same Square account are ignored.
7. **Credits and refunds.** `commercial-cli.ts credit <companyId> <invoiceId> <creditId> <cents> <reason>` records an audited care credit against a closed invoice; it is applied as a line on the office's next invoice. Refunding a credit through Square instead (`BillingService.refundCareCredit`) reserves it so it cannot also be applied; the receipt changes only after an authenticated `COMPLETED` refund is re-read from Square. An uncertain create or refund is held for operator reconciliation and never replayed. Minting a refund from the command line is not wired yet; see "Proof so far".

Failure codes on the way: 503 `commercial_terms_unavailable` (no internal company id), 404 `commercial_terms_missing`, 409 `commercial_terms_not_accepted` / `commercial_terms_stale` / `commercial_tenant_inactive` / `square_mapping_required` / `commercial_invoice_not_collectible` (nothing to pay) / `checkout_reconciliation_required` (an uncertain Square create; an operator reads the order before anything is retried), 403 `internal_usage_not_billable` / `internal_usage_not_collectible` (RealBud's own account, by id or by `billingMode: internal_cost`), 403 `seller_basis_not_approved` (live only).

8. **Margin view (owner).** `GET /v1/operator/billing/margins?period=YYYY-MM[&format=csv]` under an operator token (the website's `/admin/margin` page) lists each office for the month: AI retail (what the office pays), Modelvia cost (wholesale incl. Modelvia's fee), RealBud markup, care fee (net of care credits), total, margin (markup + care), the RealBud invoice and its state, and the AI actually billed with its `CI-…` numbers. GST inclusive, in cents (CSV in dollars). Modelvia money comes from Modelvia's per-customer margin report when `/v1/client/margin-report` answers, else from `/v1/client/analytics` (`customerNetNanoAud` vs `platformNetNanoAud`, admission-month estimates; a row with pending or unpriced requests is marked provisional). A client-funded office shows no retail and a negative markup: its AI is RealBud's cost. Each row also shows the office's accepted markup, any pending proposal, and whether Modelvia was last seen pricing at it (`markup_percent`, `proposed_markup_percent`, `markup_policy`).

### Per-office AI markup

Each office pays AI at Modelvia's price plus its own markup (0 to 10000 basis points), stated in the monthly terms its billing owner accepts. Nothing changes an office's price except that acceptance.

1. `commercial-cli.ts propose-markup <companyId> <basisPoints> <reason>` (or `POST /v1/operator/offices/ai-markup` `{companyId, markupBasisPoints, reason}` under an operator token) records an audited proposal (`ai_markup_proposed`, with the operator subject). `commercial-cli.ts markup <companyId>` shows accepted, proposed, next-terms and Modelvia sync state.
2. Publish the office's next terms (step 1 above); `aiUsage.markupBasisPoints` is filled from the proposal.
3. The billing owner accepts. The gateway then appends a new Modelvia resale policy at the accepted markup, `effectiveAt` = Modelvia's `Date` header (never this service's clock), carrying the acceptance reference; the superseded policy is untouched, so usage Modelvia admitted before keeps its price. A failed write never fails the acceptance: it is journalled (`ai_resale_policy_sync_failed`) and retried with `commercial-cli.ts sync-markup <companyId>` or `POST /v1/operator/offices/ai-markup/sync` `{companyId}` (idempotent). Until then Modelvia still prices at the previous markup.
4. `commercial-cli.ts charge-detail <companyId> all_in|itemized` (or `POST /v1/operator/offices/ai-charge-detail`) chooses whether the office's next invoices show Modelvia's split; all-in is the default. Itemized needs Modelvia's client setting `customerChargeDetail: itemized` too.

**Modes.** `REALBUD_PAYMENT_MODE=local` runs everything above except checkout and the webhook. `sandbox` needs `REALBUD_AUTHORIZE_COLLECTION=1`, the six Square variables and the Square **sandbox** webhook subscription for `payment.created`, `payment.updated`, `refund.created` and `refund.updated` at the exact `SQUARE_NOTIFICATION_URL`. `live` additionally needs `REALBUD_SELLER_BASIS_DIGEST` (the digest printed at publication) and the three approval references, and uses the production merchant and subscription. A wallet, Cash App or buy-now-pay-later method is disabled pending sandbox qualification. This is RealBud collecting from its own customer; Modelvia's provider-owned retail Square path is not configured here.

Do not infer consent from a Square token or from local adapter tests. Before a real customer payment, verify the production merchant identity and location, the office's mapping, a genuine sandbox checkout, webhook and refund, and the delivered invoice.

## Managed Gmail compatibility (22 September 2026)

`POST /v1/connectors/mail-scan` requires the exact `{ expectedAccountId, scope }` envelope. The account is a precondition on the server-owned device binding. A mismatch is refused before any provider read. A legacy flat request fails with 400. A changed binding returns 409. Release the desktop and gateway together. See [website request and connector verification](../docs/WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md).

## Proof so far

On 26 September 2026, gateway main `5a108832` was deployed to Fly as v7 image tag `deployment-01M3EPY2GM8BP70K7C7ZPEZ4AP` on machine `83d170ea735528`; `/ready` returned 200. A fresh attached-volume snapshot, `vs_kZgqeDKLmq7Qs7nmQOz3j`, was created with digest `9d0d6f63c094b040825c5424743c5f4d69aacf33b377be28c2e215a3cefea12f`. A read-only live SQLite check found `user_version=3`, `quick_check=ok`, and zero invoice-email outbox rows. Invoice email mode was `off`. Website main `9a962d4` was live on Vercel deployment `dpl_HAnjrNJ8senAvXFZMk95zG4JqjjK`; `realbud.app/` returned 200 and unauthenticated `/account/ai-billing` redirected to sign-in with 307. These are deployment and health receipts, not proof of a sent invoice email or customer acceptance. No verified sender, sending key, accepted recipient, provider acceptance, inbox receipt, or Square payment has been recorded for this release.

Later on 26 September, gateway main `db4f0c9c` (signed desktop entitlements and invoice collection copy) was deployed to Fly as v9 image tag `deployment-01M3ERB8GVWBNVET42AT53DT9Z`; `/ready` returned 200. Read-only live SQLite reported `user_version=3`, `quick_check=ok`, and zero invoice-email outbox rows. Payment mode remained `local`, invoice email mode `off`, and `internalCompanyConfigured` was `false`. Website main `78e509a` was live on Vercel deployment `dpl_8K54p2bSFYMcX6tpgYNnXoeMHhvF`; `realbud.app/` returned 200, unauthenticated `/account/ai-billing` redirected with 307, and the unauthenticated invoice API returned 401. Signed-in billing UI, provider acceptance, delivered invoice email, and customer acceptance remain unverified.

Earlier on 26 September 2026, after integrating the Composio hotfix from main (`8f7f7ee6`), the full managed-gateway local suite (`node --experimental-strip-types --test ./*.test.ts`) passed 284/284 tests and the gateway TypeScript check passed. The invoice-email retry and recovery coverage had passed in the earlier, pre-integration 280/280 local suite on the same date. These are local source-level checks.

The 24 September 2026 receipt was 188 passing local tests plus the offline `sandbox-smoke.ts`, all against injected fakes. That 24 September receipt did not exercise a real Composio project, Modelvia customer read or Modelvia key from this service. The Square adapter is proven against an injected fake only: local tenant, money, signature, retry and webhook behaviour, not Square's hosted response shape. A supervised sandbox payment-link checkout, webhook and refund, and any real customer acceptance, remain to be done. Refunding a care credit exists as a service method with tests but has no operator command yet.
