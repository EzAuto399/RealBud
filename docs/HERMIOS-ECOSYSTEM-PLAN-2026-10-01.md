# Hermios × RealBud × Modelvia — ecosystem plan, 1 October 2026

Status: plan. Evidence tier for every fact below is **source and document reads** (RealBud, `hermios-realbud-modules`, the Codex Hermios plugin 0.6.0, the owner's salesfren platform proposal) plus the public OAuth discovery receipt in `outputs/connections-design-2026-10-01/`. Nothing here is a live integration, an installed-device result or customer acceptance.

Owner request (1 Oct 2026): an easily accessed Hermios tab in daily use where people sign in and see Hermios; then Hermios CRM compatibility, operation, and multiple Buds/agents working on the CRM at the same time — enterprise grade across Modelvia, RealBud and Hermios.

Supersedes nothing. Builds on `docs/decisions/2026-10-01-connection-sessions-and-hermios-placement.md` (rollout steps 1–5) and the owner proposal (`salesfren/docs/realbud-hermios-platform-design.md`, `realbud-hermios-build-coordination.md`).

## Roles (owner proposal)

| System | Owns | Does not own |
|---|---|---|
| **Hermios** | CRM records, metadata, CRM roles/permissions, industry apps, effective CRM commercial grants, operator catalog | RealBud company authority, Bud execution, model billing |
| **RealBud** | Native workspace, the person's Bud and department Buds, company/scope authority, task/execution grants, approvals, handoff delivery | CRM record truth, model routing/billing |
| **Modelvia** | Model routing/admission, provider usage, the authoritative accounting ledger | CRM data, record permissions; no second charge path |

## What exists today

- **Hermios (Twenty-based).** Sign-in at `app.hermios.app`, each org at `<org>.hermios.app`, API/MCP/OAuth at `api.hermios.app`. OAuth 2.1 with S256 PKCE, refresh tokens, scopes `api`/`profile`; dynamic client registration issues **public** clients only; redirects must be https or loopback, exact match. One OAuth connection = one account + one workspace. MCP (streamable HTTP) exposes native reads (`get_hermios_record`, `search_hermios_mentions`, `get_hermios_profile`, …), a narrow compare-and-set write (`update_hermios_record`: deal stage / task status with `expectedValue`), generic `execute_read_tool` (find/group reads) and generic `execute_tool` (**every write, including deletes, `send_email`, `run_workflow`**). Per-workspace Postgres schemas; timeline activity; webhooks; API rate limits.
- **Hermios gaps for agents.** No generic record revision / optimistic concurrency, no idempotency keys on record writes, MCP writes record the OAuth user but **not which client or Bud** wrote, no Bud/service identity binding (planned), `/mcp` throttling unconfirmed. Module contract v1 (`hermios.realbud` pilot) is branch-only (`codex/realbud-module-access`), not deployed.
- **RealBud.** An unmounted Hermios modules adapter with strict binding/generation rules (`server/hermios-modules.ts`); "Hermios CRM — Planned" catalog entry; no OAuth client, no Hermios token custody, no person-facing Hermios view. Reusable: encrypted private vault (holds the Modelvia key), the connected-apps loopback MCP broker pattern (per-turn mount, random bearer, dispatch receipts), company Postgres with RLS, scopes/departments, case leases, idempotent job enqueue, per-member worker profiles.
- **Modelvia.** Usage attributed per installation project only; default concurrency 2 per customer; per-request and monthly caps.

## Phases

### 1 · Hermios tab in Desk (RealBud — in progress 1 Oct)
Desk gets a **Hermios** tab beside Needs you. Hermios web runs in an isolated embedded view (`persist:hermios` partition, sandboxed, no preload, navigation allowlist `*.hermios.app` + Google/Microsoft sign-in hosts, popups denied, other links open externally over https only). The person signs in themselves and stays signed in; **Bud cannot see or drive this view**. "Sign out here" clears only that partition. The tab states plainly that Bud is not yet connected. Four doors stay four (a Desk tab, not a new door).

Prerequisite hardening (separate task): the main window currently hands any URL scheme to the OS on window-open.

### 2 · Connect Bud to Hermios, read-only (RealBud, then Hermios review)
1. RealBud-owned OAuth: registered public client (DCR or pre-registered by the Hermios operator — **owner decision**), PKCE + state, loopback redirect on RealBud's local server, tokens in the encrypted vault, serialized refresh, atomic replace, revoke on disconnect. Tokens never reach the renderer, prompts or logs.
2. Verify `get_hermios_profile` after consent; bind **RealBud company + member ↔ Hermios workspace + membership id**. Never match by email. New connection generation on reconnect or account switch (A→B→A); discard stale responses and approvals.
3. Per-member connections. A member's Hermios account never becomes an office-wide credential.
4. A dedicated Hermios broker (reuse the connected-apps loopback/receipt pattern, not the Composio policy) mounted per Ask turn with an **explicit read allowlist**: native reads + `execute_read_tool` find/group reads. `execute_tool`, `send_email`, `draft_email`, deletes and workflow tools are never exposed.
5. Native record panel in the Hermios tab (Codex/Astra design: record list, record canvas, Work with Bud rail). ⌘K brings the selected record into Bud's context as a versioned reference; Bud fetches current authorized fields.
6. Mount the existing modules adapter for module status (read).

Acceptance: RealBud-owned sign-in → verified workspace → permitted record read → disconnect, plus refresh/expiry, switching and wrong-workspace/revoked-member rejection tests.

### 3 · Reviewed CRM writes, one Bud at a time (RealBud + Hermios)
First write set: create note, create task, change deal stage / task status (`update_hermios_record` compare-and-set). Every write: approval card with the exact record, field and before → after; durable intent + receipt; readback; uncertain outcome → reconcile, never auto-retry. Per-record lease on the RealBud side.

### 4 · Many Buds on the CRM at once (enterprise gate)
Required **in Hermios** for Phase 2 (found while building the connection, 1 Oct):
- `get_hermios_profile` returns only the membership id, name, email and workspace nickname — no workspace id. RealBud binds `membership:<profileId>` until Hermios also returns a stable workspace id; the modules adapter fails closed meanwhile.
- Confirm production multi-workspace mode is on, so members of any organization can choose their workspace at consent.

Required **in Hermios** before concurrent writes are allowed:
- Record revision on all mutations (`expectedRevision` / If-Match) with conflict errors.
- Idempotency keys on record mutations.
- Actor attribution stored in the timeline: OAuth client + Bud/agent id + department + on-behalf-of member.
- Bud runtime identity binding (or scoped service identities) with a role per department.
- Per-client MCP rate limits; webhooks/change events usable by RealBud (via a RealBud relay, since desktops are not publicly reachable).

Required **in RealBud**:
- Department-scoped Hermios tool policies (objects, fields, actions) intersected with the member's Hermios role.
- Per-record leases shared across Buds (company Postgres), conflict UI ("This record changed — review again"), stale-draft invalidation from change events.
- One correlation id across RealBud receipt ↔ Hermios timeline ↔ Modelvia request.
- Company workers out of preview; per-department queues and limits.

Required **in Modelvia**:
- Usage tagged per office, member, department and Bud; per-department caps.
- Concurrency above 2 for offices running several Buds.

### 5 · Ecosystem and commercial (owner decisions)
Identity mapping across the three systems; entitlements (`hermios.bud.collaboration`); enterprise SSO (Twenty's SSO module exists); paid vs included mapping and billing owner; read/export after expiry; pilot workspace.

## Who builds what

| Work | Owner (per coordination doc) |
|---|---|
| Phase 1 tab, Phase 2 RealBud host connection + broker, Phase 3 RealBud side, Phase 4 RealBud side | RealBud sessions |
| Hermios revision/idempotency/attribution/identity/rate limits, module contract deployment | Hermios coordinator (Codex, `hermios-realbud-modules`) |
| Usage attribution and concurrency | Modelvia session (usage contract review) |

## Owner decisions needed

1. Client registration for RealBud: dynamic public client vs operator-registered client, and the pilot Hermios workspace.
2. First CRM write set Bud may propose (Phase 3), and whether any read is unattended.
3. Send the Phase 4 Hermios asks to the Hermios coordinator and the Modelvia asks to the Modelvia session.
4. Open items from the owner proposal: paid vs included, billing owner, export after expiry, initial action-approval policy.
