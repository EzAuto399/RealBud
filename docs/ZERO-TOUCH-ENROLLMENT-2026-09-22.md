# Zero-touch enrolment — desktop side (22 September 2026)

When a new installation is added to a RealBud account, the vendor side provisions
it automatically. The customer machine never receives a vendor organization or
project key. This describes what the desktop does with the grant it is handed,
and names the parts that are not yet wired.

## The contract

`shared/office-link.ts` validates a `provisioning` object carried by the website's
`POST /api/installations/redeem` reply. Absent `provisioning`, the reply is the
older link-only contract and behaviour is unchanged.

```
provisioning: {
  version: 1,
  service:   { companyId, hostInstallationId },
  connector: { endpoint, credential (rbc_…64 hex), profile, apps: [ … ] },
  model:     { provider: 'modelvia', baseUrl, projectId, key (rbk_…), keyId, spendCapLabel }
}
```

Validation is exact: unknown keys are refused, `version` must be 1, `provider`
must be `modelvia`, and every string is scanned for anything shaped like a vendor
organization key (`ak_…`, `ck_…`, `sk-…`). Such a payload is rejected outright —
that credential must never reach a customer machine. `connector.endpoint` is an
https origin with no path, query, fragment or embedded credentials.
`model.baseUrl` keeps the vendor's API path (`/v1`) and is otherwise held to the
same rules. A loopback http origin is admitted for local service rigs only, the
same exception `managedConnectorSettings` already makes.

## What a successful redeem does

`server/office-link.ts` applies the grant **before** the link is recorded, so a
computer never reads as linked while missing the access the reply carried. The
apply itself (`server/worker-model-access.ts`) is ordered so an interruption
never leaves a half-configured installation:

1. Refuse a grant naming a different private worker profile.
2. Refuse a second, *active* grant for a different installation id — it holds for
   recovery rather than orphaning the previous office's revocable key.
3. Write the model key to the private vault under `worker-model-access`
   (encrypted envelope, `server/private-vault.ts`).
4. Write `service-installation.json` through `server/managed-service.ts`, which
   owns that file's shape for the entitlement authority that reads it.
5. Write `service-provisioning.json` (0600, atomic, `writePrivateJson`) holding
   only operator references: installation id, key id, base URL, spend-cap label
   and the granted app list. **No secret is in this file.**
6. Last, `saveConfig({ composio: { managed, key:'', apiKey:'', url:'',
   selectedAccounts:{} } })` — the existing writer, which wipes local Composio
   keys as it switches the workspace onto the broker.

Re-applying the same installation id is idempotent; `provisionedAt` is preserved
and a rotated key replaces the vault entry in place.

## The model key

The key lives in exactly two places: the encrypted vault entry, and the
environment of a worker child process. It is never in `config.json`, the oplog,
a website report, or `GET /api/config`. `server/redact.ts` now masks `rbk_…` in
free text as well (the object-key rule already covered `*_KEY` fields). `mgt_…`
stays covered too: that prefix is the gateway's own *operator* key, which is a
different credential and is refused as an installation key.

The variable names come from the installed worker, not from assumption. In
hermes-agent 0.21.3 (the selected runtime) the provider registry row is

```
("openai-api", "OpenAI API", "https://api.openai.com/v1", ("OPENAI_API_KEY",), "OPENAI_BASE_URL")
```

and `agent/client_lifecycle.py` resolves `base_url = env_url or default_base`,
so the env base URL overrides the provider default at turn time. `OPENAI_API_BASE`
is **not** read; do not add it. `applyWorkerModelAccessEnv`
(`server/hermes-runtime-env.ts`) copies only those two names.

Order matters. `hardenHermesChildEnv` deletes ambient provider keys on purpose,
so the grant must be injected **after** that strip. A test spawns a real child to
prove the two variables survive the hardening while `COMPOSIO_KEY` does not.

## A stated skip is not a failure

The portal answers `provisioning: { skipped: '<reason>' }` when it deliberately
did not mint a grant — an office with no platform customer binding, for example.
That reads exactly like an absent field: the link still succeeds and nothing
pretends access was granted. Only a malformed descriptor is refused.

## Retry on the report path

If the gateway was unreachable at redeem time, the portal returns the same
`provisioning` object once from `POST /api/installations/report`
(`website/docs/INSTALLATION-PROVISIONING-2026-09-22.md`). The desktop admits it
through the same `apply` sink and the same office check. A grant already in
force is left alone — re-applying would replace a live revocable key with
whatever the reply happened to carry. "Already in force" is the sink's optional
`active()` when the composition supplies one, else a durable `provisioned` flag
on the saved link, so a repeating portal cannot re-apply across a restart.

## Which website

`https://realbud.app` is the default and the only origin a packaged build uses.
`REALBUD_WEBSITE_ORIGIN` overrides it for staging **only** when
`REALBUD_PRODUCTION` and `REALBUD_MANAGED_SERVICE` are both unset and the value
is a plain https origin (no path, query, fragment or credentials). Anything else
falls back to production. The decision is written to the oplog once per process.

## Withdrawal

Three triggers, one operation — config `composio.managed` cleared, vault entry
destroyed, `service-installation.json` removed, and a withdrawn marker written in
place of the provisioning record:

- the installation report gets 401 or 403 from the website;
- a service administrator removes `service-installation.json` (noticed by
  `reconcile()` on the ordinary five-minute status tick);
- the person disconnects the website link (`clear()`, no withdrawn banner, so a
  later enrolment starts clean).

Saved work records are never touched. `GET /api/office-link` reports
`serviceWithdrawn: true`, and both `ManagedConnectionsCard` and `WebsiteLinkCard`
show "Service access was withdrawn; your records are kept."

## Managed connections beyond Gmail

`managedConnectorAccess` no longer hard-codes `gmail`. Service keys must be a
subset of this installation's granted `apps` (default `['gmail']` when there is
no provisioning record), so a broker response cannot widen its own allowlist.
Gmail keeps its exact reviewed read-only triple; another granted app may return
tools under its own uppercase namespace and nothing else. No new tool surface is
created here — the broker still decides what each app exposes.

## Composition

The `server/index.ts` composition was completed separately by the orchestrator:
`createWorkerModelAccess` is passed to `createOfficeLink` as its `provisioning`
sink, and `setWorkerModelAccessSnapshot` keeps a synchronous snapshot for the
adapter's env hook (which cannot await a vault read).

## What only the hosted side can prove

Nothing here was checked against a live website, gateway, Composio or Modelvia.
The desktop's refusals and storage are local facts. That an `rbk_…` key is
genuinely per-installation, revocable and spend-capped; that revoking it really
produces the 401/403 this code reacts to; that the broker honours the app
allowlist — that is hosted-side evidence that does not exist yet. The portal's own note records that
its report-path retry is not implemented on its side either, so the desktop's
acceptance of it is unexercised end to end. The portal does not return
`monthlyCapNanoAud` or `remainingNanoAud` at all today; the usage card shows
"Not reported by your account" rather than claiming an uncapped account. (That
`api.modelvia.dev` speaks the OpenAI-compatible `/chat/completions` protocol has
since been proven by live-usage QA; see the second pass below.)

## The attached model (22 September 2026, second pass)

The grant used to reach only the launch environment. The worker profile still
selected whatever the office had attached by hand, and a leftover profile `.env`
key outranked the granted one — upstream `agent/credential_pool.get_env_prefer_dotenv()`
reads the profile dotenv *before* `os.environ`, and says so in its own docstring.
So a provisioned office could hold a valid grant and still route every turn
through a stale local key, or through `api.openai.com`.

`apply()` now points the profile at the gateway as part of the grant, through
`applyManagedModelProfile` in `server/hermes-pack.ts` — the same profile-file
write the bridge's manual attach performs, through the same admitted helpers. No
Hermes source is touched. The keys, and where each one comes from in the selected
runtime (hermes-agent 0.21.3, commit `345cd2b0`):

| config.yaml key | value written | source of truth in the installed runtime |
| --- | --- | --- |
| `model.provider` | `openai-api` | `hermes_cli/auth.py` `_config_model_provider()` — rung 2 of `resolve_provider("auto")`, above every env-key and OAuth rung. `openai-api` is the registry's OpenAI-compatible api-key row. |
| `model.base_url` | the grant's `model.baseUrl` | `hermes_cli/auth.py` `_config_model_provider()`. The launch env `OPENAI_BASE_URL` also overrides the provider default (`agent/client_lifecycle.py` `_resolve_env_credentials`: `base_url = env_url or default_base`); writing it here too means a CLI path that never sees the launch env still resolves the gateway. |
| `model.api_mode` | `chat_completions` | `hermes_cli/runtime_provider.py` `_configured_api_mode()`. Pinned deliberately — see below. |
| `model.default` | the office's existing value, or `auto` when it names none | `hermes_cli/auth_model_picker.py` `_save_model_choice()`; every reader spells it `model_cfg.get("default")`. |

`api_mode` is not optional here. The `openai-api` overlay declares transport
`codex_responses` (`hermes_cli/providers.py` `HERMES_OVERLAYS`), and
`_detect_api_mode_for_url` only mandates Responses for official OpenAI hosts. So
without this key the worker would POST `/responses` to a gateway that publishes
an OpenAI-compatible `/chat/completions` surface. `chat_completions` is the
confirmed wire: live-usage QA settled a receipt against
`api.modelvia.dev/v1/chat/completions`.

The apply drops any `OPENAI_API_KEY` line from the profile `.env` first, before
the config names the gateway, and keeps every other line. The provisioning
record gains a `modelProfile` receipt — provider, api mode, base URL, model and
`envKeyRemoved` — which holds no credential. The granted key is still never
written to the profile.

**The grant carries no model id, and it does not need one.** Modelvia's
catalogue accepts `auto`, where the gateway's router picks an eligible model per
turn, and live-usage QA settled a receipt against `/v1/chat/completions` with it.
So a profile that names no model gets `model.default: auto` and a freshly
provisioned computer is ready with no second setup step; readiness reports the
model as attached. An existing office choice is never overwritten, and the setup
sheet keeps a Model ID field as an optional override — never a credential
control.

## Readiness and the setup surface

`workerModelGrant()` (`server/worker-model-access.ts`) publishes the grant state
synchronously for readers that cannot await a private-file read; every operation
that resolves a grant republishes it, and the default is `none`, which is exactly
today's manual behaviour. `modelAccessStatus()` (`server/hermes-status.ts`) turns
that plus the profile into one office-facing line:

- active grant, profile selects the gateway, no shadowing `.env` key, model named
  → "Model access: managed by RealBud service (Modelvia)." and the model step counts as done;
- active grant, no model named or profile not taken up → a hold naming that;
- withdrawn → "Model access was withdrawn for this computer. Your records are
  kept." — a hold, never "not attached". `applyHandsReadiness`, the hands ping
  and the ledger check all stop on it rather than spending a minute to produce an
  auth failure nobody can act on.

`attachModel` refuses a pasted key on a provisioned installation and takes the
provider, endpoint and wire from the grant, so the model name is the only thing
the office supplies. `BudSetupCard` renders no provider picker, sign-in offer,
key field or custom base URL when the installation is provisioned
(`showsProviderCredentialFields` returns false for every combination), and no
customer-facing string names OpenAI. Unprovisioned installations keep today's
manual path unchanged for development use.
