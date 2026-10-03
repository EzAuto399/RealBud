# Codex integration — DRAFT plan (2026-09-30)

Status: **draft for owner review. Nothing here is built or approved.** Evidence tier: source reading + OpenAI public docs only. No tests, no builds, no live accounts.

Ask: make RealBud usable directly from OpenAI Codex (and ChatGPT), with Codex's own model doing the reasoning.

Sources read 2026-09-30:
- https://developers.openai.com/plugins/build/extensions (MCP Extensions: sidebar, panels, file viewers, composer mentions, rich forms — ChatGPT UI surfaces)
- https://developers.openai.com/plugins/build/plugins (packaging: `plugin.json`, `mcp.json`, `skills/`, `hooks/`, local marketplaces)
- https://developers.openai.com/plugins/build/mcp-server (tool annotations, OAuth 2.1, "enforce authorization in the MCP server… never rely on the model")
- https://learn.chatgpt.com/docs/extend/mcp.md (Codex `config.toml` `[mcp_servers.*]`, per-tool `approval_mode`)
- https://learn.chatgpt.com/docs/app-server.md (embedding Codex via JSON-RPC app-server)

Re-check these before building; the pages are new and moving.

---

## 1. Decisions this conflicts with (must be resolved first)

The ask conflicts with standing owner decisions. Each needs an explicit superseding decision record, not a quiet workaround.

| Standing rule | Where | Conflict |
|---|---|---|
| "Claude/Codex/Grok are not RealBud agents" | `docs/IDENTITY.md:3`, CLAUDE.md | Codex's model would be the reasoner for RealBud work. |
| Modelvia is the only source of AI rates, caps, usage, invoices | `docs/decisions/2026-09-24-modelvia-sole-billing.md:7` | Codex tokens bill to the customer's ChatGPT/OpenAI plan and never reach Modelvia. Our resale margin and caps don't apply. |
| RealBud owns the visible window | CLAUDE.md | Work would happen in the Codex/ChatGPT window. |
| Remote execution needs its own authenticated command + approval protocol | `docs/decisions/2026-09-20-hermes-and-installations.md:11` | An external host calling RealBud tools is exactly this. |

Proposed framing for the owner: **Codex is a client of RealBud, not a RealBud agent.** RealBud remains the system of record and the authority. Codex is just another "hands + brain" that can read, propose and queue, the same way a person using the Desk does. Hermes stays the in-app worker. This keeps IDENTITY intact in spirit, but the billing question stays open (see §7).

## 2. Two ways to read "native Codex"

**A. RealBud as a Codex/ChatGPT plugin (recommended).** The person works in Codex or ChatGPT. The plugin bundles a RealBud MCP server and Austin skills. Codex's model calls RealBud tools, and RealBud enforces authority server-side.

**B. Codex as RealBud's worker.** RealBud embeds `codex app-server` (JSON-RPC over stdio) in place of, or beside, Hermes. There is already a dormant driver at `server/drivers/codex.ts`, which is test-only and excluded from `BUILT_IN_DRIVERS` (`server/drivers/builtIn.ts:5`).

B is less work because the driver exists and the approval round-trip maps onto `respondToRequest`. But it collides with Hermes pinning, profile isolation and Modelvia billing, and it isn't what "integrated into Codex" means. **This draft plans A. B is noted as a later option.**

## 3. Target shape (option A)

```
Codex CLI / IDE / app  or  ChatGPT desktop
  └─ RealBud plugin (plugin.json + mcp.json + skills/)
       └─ MCP (streamable-http, loopback)  ──►  RealBud server: NEW server/mcp-host.ts
                                                  ├─ plugin grant check (scopes)       ◄─ paired in RealBud UI
                                                  ├─ domain functions (Desk, loops, packs, evidence)
                                                  ├─ proposals → Desk queue (human Allow in RealBud)
                                                  └─ evidence/audit (execution-history, audit-artifacts)
```

### 3.1 New MCP host endpoint: do not wrap `/api`
- RealBud has no MCP server an external host can connect to. The existing brokers (`browser-broker.ts`, `connected-apps-broker.ts`, memory-proposals) are per-run and serve only our own worker.
- **Do not** proxy the HTTP API. `GET /api/session` (`server/index.ts:2981-3005`) hands the whole-API `SESSION_TOKEN` to any loopback caller. A plugin that did this would get full authority. Tracked separately as a hardening item, because a local Codex process can already reach it today.
- New module `server/mcp-host.ts`, mounted at loopback `POST /mcp/codex`, with:
  - **Plugin grant** — a separate credential created by an explicit "Connect Codex" action in RealBud: scopes, expiry, revocable, and shown in RealBud's settings. It is stored in the private store, never in the plugin folder, `~/.codex`, or the Hermes profile. Codex receives it via `bearer_token_env_var` (local) or OAuth (hosted, §6).
  - Tools call domain functions directly and reuse the same guards the HTTP routes use (`guardPermissionDecision`, `autoDecision`, `rules.ts` can-never-widen).
  - Every call writes evidence with `actor: codex-plugin` + grant id, so a Codex-originated change is distinguishable from a person or Hermes.

### 3.2 Tool surface, phase 1

Annotations follow the OpenAI spec (`readOnlyHint`, `destructiveHint`, `openWorldHint`). Codex's own `approval_mode` is an *extra* prompt, never the control.

| Tool | Kind | Maps to | Notes |
|---|---|---|---|
| `realbud_office_status` | read | session/office state | also the `openai/profile` tool, so the person can see which office is connected |
| `desk_list` / `desk_item_get` | read | `/api/desk*` data | arrears and proposals, with source truth labels (fixture vs real) |
| `properties_list` / `property_get` | read | Desk book | |
| `loops_history` | read | `/api/loops/history` | |
| `workflow_packs_list` | read | `/api/workflow-packs` | |
| `evidence_get` | read | execution-history | |
| `desk_propose` | write (non-destructive) | Desk propose | **creates a proposal only**, and a person Allows it in the RealBud Desk |
| `loop_run_request` | write (non-destructive) | loop queue | queues a named loop; nothing freeform |

**Not exposed in phase 1:** browser/portal actions, pay/sign/send/notice, property delete, rules edits, pack install, and anything touching credentials. Browser work depends on the fence and on per-instance approval of the actual recipient, amount or content (`browser-authority.ts:31, :751`). Codex's own browser bypasses all of that. At most, a later `browser_task_request` would queue a task that Bud runs under the fence in RealBud, and the approval would still happen in RealBud.

The rule behind all of this: **Codex can read and propose, but only a person in RealBud can make a consequential action happen.** That holds no matter how Codex's approval settings are configured.

### 3.3 Skills
- Generate `skills/<id>/SKILL.md` from the pack definition (`server/customer-pack-definition.ts`, `pack/workflows/austin-accounts/workflows.json`), so there is one source. Hand-copied skills would drift.
- Initial set: `morning-priorities`, `bills-calendar`, `bank-references`, `email-inbox-triage`. Each skill tells the model to use RealBud tools and to stop at a proposal.
- Limits to design for: `SKILL.md` ≤ 256 KiB, ≤ 5 MiB of resources per skill.

### 3.4 Plugin package (lives in repo, e.g. `integrations/codex-plugin/`)
```
plugin.json          # Agent Plugins schema 1.0.0; name "realbud"; extensions.com.openai.interface.displayName "RealBud"
mcp.json             # mcpServers.realbud: streamable-http → http://127.0.0.1:<port>/mcp/codex
skills/…             # generated
assets/icon.png
```
- No `hooks/`: they execute local scripts, and we don't need them.
- Naming: "RealBud" only. No PropertyMe, Hermes or OpenMausBot anywhere in the manifest or assets.
- Dev install: repo marketplace `.agents/plugins/marketplace.json` → `codex plugin marketplace …`.

### 3.5 Suggested Codex config
Ship as docs, not enforced by us:
```toml
[mcp_servers.realbud]
url = "http://127.0.0.1:<port>/mcp/codex"
bearer_token_env_var = "REALBUD_CODEX_GRANT"
default_tools_approval_mode = "writes"   # prompt on anything not readOnlyHint
```

## 4. ChatGPT extensions (phase 3, optional)
The extensions page is about **ChatGPT** surfaces, not Codex CLI. If wanted later:
- **Sidebar app** `ui://realbud/desk`: a read-mostly Desk view. Allow/Deny stays in the RealBud window unless the owner decides otherwise.
- **Composer mentions**: `@property` / `@tenant` picker over `properties_list`. This is desktop-only.
- **Rich forms**: property/loop pickers for `desk_propose`.
- **Plugin settings**: which office or grant is connected.

## 5. Phases and gates

| Phase | Deliverable | Evidence needed |
|---|---|---|
| 0 | Owner decision record(s) for §1 + billing (§7) | signed decision in `docs/decisions/` |
| 1 | `mcp-host.ts` + grant pairing + read tools; fixture office only | unit tests (grant scope, denial, evidence actor), MCP Inspector receipt |
| 2 | `desk_propose`, `loop_run_request`, generated skills, local-marketplace plugin | local tests + Codex CLI on dev machine against fixture office; receipt in `outputs/codex-plugin-<date>/` |
| 3 | Packaged-app build exposing the endpoint; ChatGPT sidebar/mentions if approved | packaged build → installed device |
| 4 | Austin pilot via workspace publishing | live integration + customer acceptance, under Austin's own authority |

Fixture runs are never customer proof.

## 6. Local vs hosted
- **Local (phases 1–3):** loopback streamable-http with a bearer grant. This works for Codex CLI, IDE and app on the same machine. ChatGPT *web* can't reach loopback.
- **Hosted (only if needed):** ChatGPT web and public directory listing need a public HTTPS endpoint with OAuth 2.1. The candidate is `managed-gateway/`, relaying to the paired office. That is remote execution, which triggers the separate authenticated command/approval protocol required by the 2026-09-20 decision, so it gets its own design. **Public directory submission is out of scope.** Workspace publishing to Austin is enough.

## 7. Open questions for the owner
1. **Billing:** Codex reasoning is paid by the customer's OpenAI plan. Do we (a) accept that and charge a RealBud platform fee, (b) require the Codex path to run through Modelvia (probably impossible for native Codex), or (c) keep Codex read/propose-only so the heavy work still runs on Hermes + Modelvia?
2. Should Allow/Deny ever be possible from inside Codex/ChatGPT (e.g., via a rich form), or always only in the RealBud window? This draft says RealBud window only.
3. Which Codex surfaces matter to Austin: CLI, IDE, the Codex app, or ChatGPT desktop? That determines whether §4 is worth building.
4. Is option B (Codex app-server as a worker) wanted at all, or should the dormant `server/drivers/codex.ts` be deleted to avoid confusion?

## 8. Risks
- Codex's approval settings are user-controlled. That's why authority must live in `mcp-host.ts`, never in annotations or Codex config.
- Prompt injection via tool results (tenant emails, portal text) can steer Codex's model. Mitigation: no consequential tools exposed, and proposals are reviewed in RealBud.
- `/api/session` loopback token exposure exists today, independent of this plan.
- OpenAI plugin/extension specs are new: pin the schema version (`1.0.0`) and re-read the docs at build time.
