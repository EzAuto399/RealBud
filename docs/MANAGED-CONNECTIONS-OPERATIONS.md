# Managed customer connections

This is the operator contract for the bounded Gmail adapter added on 21 September 2026. The desktop keeps a revocable installation credential. The Composio `ak_` project key stays on the protected service. Ordinary staff connect their work account in Apps; service administrators configure the service URL and installation credential under You → Service administration.

## Authority and subscription

The gateway resolves company, license, member, installation, private Hermes profile, Composio user, auth configuration and connected account from its operator-owned registry. A request cannot select any of those upstream identities. Each request checks the current registry, device expiry and the existing ledger's company activation, license, go-live date and service expiry. The adapter repeats these checks before and after upstream requests. Revocation stops new reads and withholds a response if authority changes during a read; it cannot undo a request that already reached the provider.

The registry is an operator-managed grant. It is not hardware attestation and does not automatically mirror local-office membership changes. Offboarding must revoke the corresponding registry entry. Modelvia remains the owner of the model/billing service; the connector adapter currently uses this repository's managed-gateway ledger. A production integration must connect the authoritative subscription state and signed desktop grants to that same lifecycle. No new payment collection or deployment is activated by this change.

Do not put a vendor LLM master key in the desktop. Configure the supported model gateway with a customer-scoped key. A desktop administrator password protects the product's settings UI/API, not against the owner of the operating system. Suspension blocks managed services while leaving saved customer records available for reading and export.

## Provisioning

Run on the protected service/operator machine with Node 24. Create a private JSON descriptor with these fields:

```json
{
  "id": "office-seat-01",
  "companyId": "existing-company-id",
  "licenseId": "existing-license-id",
  "memberId": "assigned-member-id",
  "installationId": "assigned-installation-id",
  "profile": "property",
  "active": true,
  "expiresAt": 1798761600000,
  "projectKeyEnv": "REALBUD_COMPOSIO_PROJECT_OFFICE_01",
  "authConfigId": "ac_operator_verified_readonly",
  "userId": "operator_assigned_provider_user"
}
```

The date above is illustrative. Use the agreed service period and the installation's actual immutable private profile (a member profile can differ from `property`). The tenant/license must already exist in the service ledger. An optional `accountId` pins an already verified provider account. The admitted OAuth configuration must expose only Gmail read-only scopes; no account discovery fallback is allowed.

```sh
node --experimental-strip-types managed-gateway/provision-connector.mjs \
  --registry /private/realbud/connector-devices.json \
  --device-file /private/realbud/new-device.json \
  --client-output /private/realbud/new-client-access.json \
  --endpoint https://managed.example.com
```

This issues no provider request. The registry stores only a credential hash; the private client file contains the scoped credential once. It rejects duplicate devices, reused output paths, path aliases and a concurrent provisioning lock. Preserve and privately transfer the client file. Never place it in a workflow pack, source control, support log or shared output. On a failed or interrupted issuance, inspect both files before retrying. A client file with no matching admitted hash is unusable; do not overwrite it and assume issuance succeeded.

Set `REALBUD_GATEWAY_CONNECTOR_REGISTRY` to the registry's absolute path on the service. Supply the key under the descriptor's `REALBUD_COMPOSIO_PROJECT_*` environment name using protected service configuration. The existing service startup and ledger configuration still apply. Container builds use the repository root as context:

```sh
docker build -f managed-gateway/Dockerfile -t realbud-managed-gateway .
```

This builds an image only. Deployment, production secrets, persistent storage, TLS, monitoring and payment-event integration need their own release verification. The existing hosting decision is unchanged.

## Vendor-side provisioning over the portal (22 September 2026)

The CLI above stays the operator path. A second path issues the same grant from
the gateway itself, so the website can provision an installation without an
operator shelling into the service. Both admit devices through the same code
(`managed-gateway/provisioning.ts`); the CLI is now a thin wrapper.

`POST /v1/portal/installations/provision` and `POST /v1/portal/installations/revoke`
use the existing portal bearer. The authenticated principal is the authority: it
must be `billing_owner`, and a body `companyId` that is not the principal's is
refused (403 `company_scope_mismatch`). Request body is
`{ companyId, installationId, customerId, profile, apps? }`, where `customerId` is
the company's Modelvia customer account id — required, with no default, because
guessing one would issue a model key against somebody else's account. `apps`
defaults to `["gmail"]`
and an app with no admitted adapter and reviewed OAuth configuration is refused
(403 `connector_app_not_admitted`) before anything external happens.

Provision is idempotent per `installationId`. The first response carries
`connector.credential` (`rbc_…`) and `model.key` (`rbk_…`) **once**; every later
response returns the same descriptor with neither. `connector.projectId` (the
Composio project id, `pr_…`) is returned on the first and on every repeat, for the
portal to record as `composio_project_id`; it is an identifier, never the project
key. The full contract, the environment variables and the failure codes are in
[managed-gateway/DEPLOY.md](../managed-gateway/DEPLOY.md).

One call does three things, each journalled before it is attempted: resolve or
create the company's Composio project (its `ak_` key goes to the gateway's secret
store under the same `projectKeyEnv` name the registry already uses, never into a
response); admit an `rbc_` device by hash; and create one Modelvia project per
installation (`rb-<installationId>`) under that customer, carrying the ledger
tenant's monthly cap, request cap and concurrency, then mint one key in it. Caps
live on Modelvia projects rather than keys, so the ledger cap is genuinely applied
there and not merely described. An interrupted first call is held (409
`installation_provisioning_outcome_unknown`) for operator reconciliation rather
than retried into a second project, device or key.

Revoke deactivates the device first, then marks the model key for revocation. The
installation's Modelvia project is left in place on purpose — it holds the usage
and billing history the ledger reconciles against, and its caps bound any key
under it. The Composio project is deleted only on an explicit `deleteProject: true`. That
delete is irreversible and revokes the office's upstream OAuth credentials at the
provider; the default is `false`. The whole revocation writes one audit line with
no secret in it, and a repeat revoke returns the recorded outcome instead of
acting twice. Revoking does not delete customer records.

The per-device `apps` allowlist is enforced at every adapter entry point — status,
sign-in link, mail scan and the MCP session. A registry entry written before the
allowlist existed keeps its original Gmail-only grant. An app with no adapter in
this service is refused whatever a registry entry claims, and the MCP method list
stays the existing read-only set.

`server.ts` composes these routes from the environment alone, and only when
`REALBUD_ENABLE_PROVIDER=1` — the same gate the model providers use. While the
gate is off the routes answer 503 `provisioning_disabled`. With the gate on and a
variable missing or malformed, they answer 503
`provisioning_unconfigured:<VARIABLE_NAME>`: the name of the one thing to fix,
never its value. The startup log line carries the same code, and `GET /ready` answers 200 only when
provisioning is composed — it is the deployment's health check. Modelvia's operator
auth is a short-lived HMAC bearer minted per request from a held secret, not a
static token; neither the secret nor a bearer is ever logged.

**Evidence tier: local tests and an offline smoke against injected fakes.** No
real organisation key, Composio project or Modelvia key has been exercised from
here, and the file-backed secret store is a next-to-an-operator arrangement that a
hosted deployment must replace with the platform secret manager before any
vendor-only custody claim.

## Desktop setup and recovery

1. Unlock that installation's service administrator session. Enter only the service origin and scoped installation credential in Managed connections.
2. Check and save. RealBud verifies projected account/tool metadata, rechecks administrator authority and serializes setup changes before saving. It invalidates old agent connection sessions and removes local Composio keys. No message is read by setup.
3. Staff connect Gmail under Apps. A verified account is pinned for subsequent reads. Missing configuration or revoked/expired access is shown as a setup issue.
4. Import the Austin pack, check its requirements and supply reviewed customer samples. Importing never starts a schedule or proves source coverage.

Revoke access by atomically updating the trusted registry entry to `active: false`, or suspend/expire the company through the ledger's existing audited service lifecycle. Do not delete customer records. Rotate by disabling the old grant and provisioning a distinct replacement; old MCP sessions cannot retain authority after a registry change.

OAuth link intent is journaled before the provider request. A lost response, expired link or changed source binding is held for operator reconciliation, including after restart. Check the provider for the original account and outcome before issuing a replacement. Do not erase the journal to retry an uncertain action. For a confirmed replacement, issue a new device grant pinned to the reviewed account, disable the old grant and retain its receipt.

## Admitted scope and remaining proof

The current adapter exposes three Gmail read tools with the existing seven-day, ten-thread limit. It does not search long-term bill history, paginate a full mailbox, fetch attachments, send mail, download bank CSVs or submit to REI Cloud. These limits are surfaced in customer-pack setup and must remain visible until the corresponding adapters and source coverage are accepted.

Local tests cover denial before upstream calls, tenant/profile isolation, expiry and revocation, MCP session ownership, uncertain OAuth recovery, safe response projection and administrator setup races. Those tests use synthetic accounts. A real customer pilot still needs the approved OAuth configuration, source samples, bill/property mappings, schedule/timezone acceptance, exact REI import evidence, and deployed-service recovery monitoring. Windows installer/runtime checks must also run on an actual Windows machine.
