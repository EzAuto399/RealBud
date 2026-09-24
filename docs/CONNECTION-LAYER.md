# Connection layer

> Direction update, 21 September 2026: read [Business OS and Austin workflows](decisions/2026-09-21-business-os-and-austin-workflows.md) first. The local broker described below is a current supported tool path, not a sandbox for same-user arbitrary code. Local `ak_` storage does not provide vendor-only custody. The managed connector service and scoped grants now have local implementation and two-agency rehearsal evidence; hosted commissioning and customer consent remain separate gates. See [current request/connector evidence](WEBSITE-REQUESTS-IMPLEMENTATION-2026-09-22.md), including the exact expected-account precondition before managed Gmail reads. Connector additions still require server-side authorization; an office member/department is not an extra autonomous worker surface. Earlier local-custody and fixed-product assumptions below are superseded where they conflict with this decision.

How RealBud reaches other systems — API, MCP, Composio, CLI — and the rules that
keep that reach from turning into autonomy. Written for the Property Inspect →
Zapier use case, but the taxonomy is general.

## The distinction everything hangs on

> **A hand is an outbound tool call. A seat is an agent surface with its own
> memory, skills and sessions. RealBud may add hands freely. It must not add
> seats.**

A new MCP server is a **hand**. It gets bearer credentials, it executes what it
is told, and every call passes RealBud's policy gate. If a connection is ever
proposed that would *start a Bud turn*, trigger a conversation, or hold its own
context, that is a seat, and it is refused — that is what "no extra Buds" and
"never send, never move trust" mean in practice.

## What already exists (verified)

| Piece | Where | What it does |
|---|---|---|
| MCP client | `server/composio.ts` → `readMcpRpcResponse` | Parses MCP JSON-RPC, **including SSE framing** over Streamable HTTP |
| Local loopback broker | `server/connected-apps-broker.ts` | Credentials never reach the worker; RealBud terminates the MCP session |
| Policy gate | `connectedAppPolicy(call)` → `read` / `review` / `blocked` | Unknown tools default to `review`, i.e. an approval card |
| Per-product allowlist | `allowedOfficeAppCall(call, allowedApps)` | Binds execution to the apps this office selected |
| Browser fence | `server/portal-fence.ts` | `MONEY_RE` denies pay/sign/send/notice/delete at the fence, before any card |
| Operator CLI | `scripts/manage-composio-projects.mjs` | Trusted tooling that is never HTTP-exposed |

The load-bearing comment is the first line of the broker:

> *"RealBud owns this boundary; upstream tool annotations and worker permission
> modes cannot authorize an external action. Credentials never reach the worker."*

That is why adding a transport is safe: the gate is ours, not the vendor's.

## What is missing — smaller than it first looks

**Per-desk isolation already exists and is not the problem.** The broker is a
per-session loopback server (`createServer`, `server/connected-apps-broker.ts:111`)
with a per-session token (`:89`), and `AppConfig` is per-seat because
`REALBUD_DATA_DIR` isolates seats. Each desk already has its own connections.

More importantly, **the broker is already multi-connection**, not Composio-only.
Line 164-166 branches on transport:

```js
const policy = options.localTransport
  ? (GMAIL_READ_ONLY.has(call.name) ? "review" : "blocked")
  : connectedAppPolicy(call);
```

Gmail read-only is a second connection shape with its own policy, and everything
outside its three allowed tools is **blocked rather than reviewed**. So Zapier is
the **third case in an established pattern**, not a new architecture. The change
is a connection descriptor plus a policy table — not a rewrite.

`AppConfig` (`server/config.ts:11-35`) still needs a general `connections` entry,
because today it has an explicit `composio` field and nothing else:

```
config.json (0600, client's Mac — never the website)
  connections?: {
    "<label>": { url, transport: "streamable-http", token, enabledTools?: string[] }
  }
```

## The real design question: ownership granularity

Not isolation — granularity. The code already answers this differently for each
connection, which is easy to miss:

| Connection | Scope | Where credentials live |
|---|---|---|
| Composio project | **one per office** | seats share the office project |
| Composio identity | per seat | derived by `platformUserId` |
| Zapier connection token | **one per desk** (as designed) | per-seat `config.json` |

Consequence, invisible until an office has three PMs: **each PM separately creates
a Zapier MCP server, generates a token, and OAuths Property Inspect.** That is a
much heavier per-person setup than one Composio project, and it is the actual
onboarding cost of this route.

Options, none yet chosen:

- **Per desk (current shape).** Simplest, matches the existing pattern, no new
  storage. Three PMs means three setups.
- **One per office**, with the token held once and each seat using it. Cheaper to
  onboard; needs a decided home for an office-scoped secret, and the shared layer
  currently waits on the office-of-one shipping.
- **One per office, owned by the principal**, who sets it up during onboarding.
  Best onboarding story if the principal is the one who answers the phone to the
  inspector anyway.

## The three-class taxonomy (the part that matters commercially)

For an inspection workflow, every action sorts into one class:

| Class | Examples | Fence outcome |
|---|---|---|
| **Read** | inspection status, completed report, outstanding actions | auto-allow (like `GMAIL_READ_ONLY`) |
| **Review** | log an action against a property, create a follow-up, update a record | approval card, every time |
| **Blocked** | anything that reaches a person or moves money — email tenant, SMS report, pay invoice, issue notice, submit | **deny before the card** |

RealBud's product value is not that it connects. It is **what it refuses.** An
inspection tool that emails a tenant an adverse report is doing the one thing the
wall line forbids. So the deny class has to be structural — enforced in the
broker, not requested of the vendor's UI.

## Zapier MCP specifically — four findings

Researched 2026-09-17 against Zapier's MCP docs ([connections](https://docs.zapier.com/mcp/overview/how-connections-work),
[tools](https://docs.zapier.com/mcp/overview/how-tools-work), [modes](https://docs.zapier.com/mcp/manage/switch-modes)).

1. **One endpoint, Streamable HTTP only.** `https://mcp.zapier.com/api/v1/connect`.
   An SSE-only client cannot connect — RealBud's reader handles SSE *responses*,
   which is a different thing, so this is compatible but must be tested.
2. **Authentication: OAuth, or a connection token.** RealBud is not on Zapier's
   supported-client list, so the realistic path is a **connection token** sent as
   `Authorization: Bearer …`. Zapier's own guidance is explicit: *"Treat a
   connection token like a password… give each user their own server and token
   rather than sharing one"*, and *"Regenerating a token immediately invalidates
   the previous one."* This fits the existing model — per-install config, 0600,
   never on the website — and gives a clean offboarding lever.
3. **Agentic mode must be OFF. Use managed mode.** This is the decisive finding.
   In agentic mode the server exposes 16 meta-tools including
   `discover_zapier_actions`, `enable_zapier_action` and `auto_provision_mcp` —
   the agent grants itself new powers at runtime. That breaks RealBud's closed
   allowlist and would mean the set of things Bud can do is decided at
   conversation time. **Managed mode exposes one dedicated tool per
   pre-configured action**, so the allowlist stays enumerable and ours.
4. **A tool name is not authority.** `execute_zapier_write_action` says it
   writes, but not *what* it writes. RealBud must inspect the nested
   action/arguments before classifying — exactly how `COMPOSIO_MULTI_EXECUTE_TOOL`
   already validates each element of `arguments.tools[]`, including calls hidden
   inside a batch. A wrapper tool must be opened, never trusted by its name.

## Routes considered

| Route | Shape | Verdict |
|---|---|---|
| **A. Managed-mode Zapier MCP** | Property Inspect action → Zapier → one dedicated MCP tool → RealBud broker | **Recommended to start.** No per-app adapter to build, and the allowlist is small and explicit. Cost: Zapier is in the path, per-task allowance applies. |
| **B. Property Inspect API direct** | `developer.propertyinspect.com` → RealBud adapter | Fewest moving parts, no third party in the data path, best long-term. Costs a real adapter and AU region confirmation. |
| **C. Both** | Zapier for breadth, direct for the one integration that matters daily | Probably where this ends up. Start with A to learn which actions are actually used, then move the hot path to B. |

Anyone using Zapier MCP also gets Zapier's own **History** tab as a second audit
trail alongside RealBud's receipts — useful, and worth telling a principal.

## First slice, if approved

1. Generalise the broker: accept a `{label, url, token}` MCP server beside the
   Composio session, keeping the same policy gate and loopback boundary.
2. Add `connections` to `AppConfig`, with the token read from config and never
   echoed back (`GET /api/config` reports configured-or-not booleans only, as it
   already does for every other secret).
3. Enumerate the managed-mode Property Inspect tools and classify each into
   read / review / blocked, with the blocked class enforced in the broker.
4. Prove it: a fake MCP server in tests, asserting that a blocked-class call is
   denied **without** an approval card and without reaching the upstream.

## Open questions

- **AU region** for the Property Inspect API (regions listed are UK / Ireland /
  South Africa / US / Other) and whether AU data stays in AU. This was already an
  open item and it is a client-facing answer, not an internal one.
- **Health-check cadence** for a connection token that can be revoked upstream at
  any moment — a stale token must fail loudly rather than silently stop working.
- **Whose Zapier account?** The office's, presumably, so the connection belongs
  to them and survives us. That also means offboarding must revoke the token, not
  just forget it.
