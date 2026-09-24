# Hosted architecture

> Direction update, 21 September 2026: [Business OS and Austin workflows](decisions/2026-09-21-business-os-and-austin-workflows.md) settles the target credential boundary. Vendor Composio organization/project keys belong in an independently protected managed service, not customer-editable storage. Its connector protocol, migration, data handling and hosted rollout remain to be implemented and verified. The model gateway described below does not yet provide Composio brokerage. Local-only credential statements and unresolved ownership choices in this earlier note are historical; other code/deployment observations are dated evidence, not a fresh status check.

Working note: we will host so clients connect over the API rather than running a
local gateway. Recorded because it settles several open questions at once, and
because two of its consequences are easy to miss until they bite.

Status: **decided direction, nothing deployed.** Written after reading the code,
not from the plan.

## The hosted picture

```
  OFFICE MAC (customer)                    OUR INFRASTRUCTURE (hosted)
  ─────────────────────                    ───────────────────────────
  RealBud desk
   └─ book, files, portal        ──────►   realbud.app        (control plane)
      credentials — LOCAL ONLY              ├─ billing, rate cards
      (files, cookies, tenant data)         ├─ office ↔ project registry
                                            ├─ operator console
  Composio-attached browser                 └─ tenant provisioning  ◄─ GAP
      human signs in, human Submits

  Worker (Hermes)  ────────────────────►   routing service    (stateless, blind)
   └─ sends prompts + usage,                └─ needs shape + costs only
      receives completion
                                           managed gateway    (stateful)
                                            ├─ Ed25519 grant verification
                                            ├─ per-tenant metering + caps
                                            ├─ margin policy, GST, invoices
                                            └─ SQLite ledger   ◄─ persistence gap
                                                      │
                                                      ▼
                                            DeepSeek / Kimi / …
```

## What the code already gets right

This is the pleasant part. The hosted model is not a rewrite, because the
existing design assumed it:

| Property | Evidence |
|---|---|
| **Tenancy is built in** | `Tenant` interface with `companyId`, `licenseId`, `goLiveAt`, `serviceExpiresAt`, `includedUntil` (`contracts.ts:59`); `provisionTenant()` (`ledger.ts:18`); unknown tenant → `tenant_unavailable` 403 |
| **Inference auth is stateless** | Every call carries an Ed25519-signed `ExecutionGrant` verified per request (`auth.ts:12`). No session server, no sticky routing — it shards naturally |
| **A grant can only be used as issued** | `model_scope_denied` if the model is outside the signed `allowedModels` (`attempts.ts:18`) |
| **Routing is trivially shareable** | Blind and stateless by construction — see `SPEC.md`. One instance can serve every tenant because it learns nothing |
| **Roles already split** | `PortalPrincipal` is `billing_owner` or `billing_reader` (`contracts.ts:66`) |
| **Per-tenant caps exist** | `monthlyCapNanoAud`, `maxConcurrent`, per-attempt ceilings |

So: **one routing service, one gateway, many tenants** — and the routing side
needs no change at all for hosting. That is what the blind boundary bought.

## What hosting actually requires (ranked)

### 1. Secrets currently live on the client's Mac

`ak_…` (Composio project key) sits in `~/.realbud/config.json` at 0600, and the
book key is wrapped by the OS keychain (`electron/main.mjs`). That was the right
answer for a local desk. Hosted, the question becomes: **which secrets move
server-side?**

- **Composio org key** — already ours, currently an operator env var. Must move
  to a managed secret store before any hosted call uses it.
- **`ak_…` per office** — stays on the Mac today by design. If it moves
  server-side, the office's connected apps become reachable by us in a way they
  are not today.
- **Provider keys** — the gateway already holds these; a hosted gateway makes
  that explicit rather than incidental.

**This is the decision, not a task.** Everything else here is mechanical.

### 2. The ledger is a file on one machine

`managed-gateway/database.ts` is SQLite. That is excellent for one host and a
hard ceiling on multiple app servers: metering, reservations and idempotency all
live in one file. Hosting the gateway properly means a shared datastore, and the
documented target is already *"next to the operator until a RealBud
Supabase/Postgres ledger exists."*

Multi-machine also drags in backups and restore — an unbacked ledger is a billing
dispute waiting to happen.

### 3. There is no tenant provisioning surface

Today `provisionTenant()` is called by a script and `provision-service-admin.mjs`
is explicitly *"trusted developer/installer setup, never expose this through an
HTTP route."* Hosting needs a real control plane: create office → create Composio
project → record rate policy → invite billing owner. The pieces exist
(`server/composio-project.ts`, `billing_accounts`); the operator flow does not.

### 4. No rate limiting — on either service

`SPEC.md` already lists this as a gap for routing. Hosted, it stops being a gap
and becomes an abuse surface: one leaked token can spend at line rate. Needed on
the gateway too, per tenant.

### 5. Uptime becomes load-bearing

Local inference cannot go down. Hosted inference can, and when it does the office
stops working mid-morning. That is not a reason to avoid hosting; it is a reason
to decide the failure story before the first paying tenant — queue-and-retry,
or a clear "Bud is offline, carry on without it" that never leaves a half-done
job.

## What hosting does to the privacy claim

Honest version, because this is the part that would embarrass us if a customer
asked and we improvised.

**Still local, whatever we host:** the book, property files, portal credentials
and cookies, attached documents, and all native computer control. Those never
leave the Mac. The wall line — *"RealBud does the routine work, it only reaches
someone else when asked"* — is untouched.

**Leaves the Mac:** the prompt and the completion for any managed-AI call. That
is unavoidable: a hosted model must see the prompt. Today, with a locally
attached provider, it may not.

So the hosted claim must become something like:

> Your book, files and portal logins never leave your Mac. When RealBud uses
> managed AI, that request goes to our gateway and on to the model provider. We
> meter it; we do not keep your prompts.

That is a defensible sentence. It is also **weaker** than the one the local
design could make, and it should be stated deliberately in the rate card and the
privacy page rather than discovered by a customer.

**Routing does not add to that exposure.** It sees token counts, tool names and
turn counts — never content. Worth saying, because "we route your requests" would
otherwise sound like another place prompts go.

## Open, in priority order

1. **Which secrets stay on the Mac?** Decides the privacy sentence and the
   breach surface. Owner decision.
2. **Shared ledger or single host?** Decides whether the gateway can scale past
   one machine and whether invoices survive a disk failure.
3. **Flat retail or per-model rates?** Still open from `README.md`. Hosting makes
   it more urgent, because hosted inference makes the per-request cost visible to
   us for the first time.
4. **Failure story** when hosted inference is unreachable.
5. **Deployment target** for gateway and routing — the gateway has a `Dockerfile`
   and `fly.toml` already; nothing is deployed.

## What this note does not claim

No hosted service is running. The gateway has never been deployed, routing has
never been run outside a dev machine, the desk does not call either of them, and
no tenant exists. Everything above is what hosting *will* require, read from the
code — not a description of a working system.
