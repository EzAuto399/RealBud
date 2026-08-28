# ADR 0001: RealBud-owned local-first work routing

- Status: Accepted
- Date: 2026-08-27
- Owners: RealBud application/runtime
- Canonical constraints: `docs/GOAL-PROMPT.md`
- Revisit: when the named office has 25 measured multi-property runs, when two
  live workflows need independent browser lanes, or on 2026-11-27—whichever
  comes first

## Decision

RealBud will select the cheapest safe execution route for each typed workload.
A cloud account is optional acceleration, never a functionality gate.

```text
selected structured evidence ───────────────▶ one deterministic local batch
selected documents ─────────────────────────▶ bounded local analysis lanes
typed DOM recipe + one account ─────────────▶ one scripted browser lane
typed DOM recipes + independent accounts ──▶ at most two isolated browsers
visible desktop-only step ──────────────────▶ one serial CUA lane
independent cloud-safe work + PM opt-in ────▶ bounded remote acceleration
                                                    │
                                                    ▼
                                    evidence / draft / hold / unknown
                                                    │
                                                    ▼
                                      existing Desk proposal + Allow
```

The current source candidate implements the versioned planner, honest read-only
projection, durable broker, structured broker-to-Desk reconciliation and
offline topology simulator. Ordinary Ask attachment turns also copy only the
server-validated selections into a private short-lived workspace and deny tool
permissions. Structured local batch work is ready. The simulator proves
lifecycle and lane policy without calling a worker, browser, desktop or cloud;
independent brokered analysis, parallel analysis, the private browser pool,
live CUA and cloud execution remain adapter-gated until their listed
implementation and pilot proofs exist. A plan must never label a gated lane as
ready.

The executable seam is now a separate `realbud.work-plan.v1`, not the UI route
projection. Every new broker receipt binds the exact request/routine/Allow
authority, input and account digests, data classes, recipe, origins, route
chain and fresh adapter attestation. Cloud bindings retain their named-account
digest plus region, retention, deletion, encryption, spend and local-fallback
policy. Legacy v1 receipts remain readable for recovery, but cannot acquire a
new route or authority by omission.

## Ownership boundary

Hermes Agent is externally owned source. RealBud does not vendor, patch, fork,
or dynamically rewrite it.

- The exact upstream tag and commit remain in `server/hermes-pin.ts`.
- Every launch uses RealBud's absolute private runtime and private `HOME`.
- RealBud may call only a supported pinned interface through its existing
  worker bridge. A pin bump is a deliberate RealBud release change.
- Personal PATH executables, `~/.hermes`, browser profiles, tabs, cookies,
  credentials, memories and update state are never inspected or reused.
- A local analysis lane is an ephemeral work context, not another product
  agent. It has no identity, channel, schedule, memory, authority or UI.
- If a future pinned Hermes release cannot provide a required supported seam,
  the lane stays unavailable. RealBud does not fix that by editing upstream.

RealBud owns routing, admission, selected-file staging, isolation, concurrency,
idempotency, cancellation, leases, receipts, reconciliation, Desk projection
and every permission decision.

## Route rules

| Input | Default route | Concurrency | Important boundary |
|---|---|---:|---|
| Structured export or read API | One deterministic batch | 1 batch | Validate complete coverage; no per-property model loop |
| Independent extraction/drafting | Local analysis contexts | 1 standard, up to 2 accelerated | Selected inputs only; outputs are untrusted proposals |
| Same PMS account in DOM/browser | Scripted browser loop | 1 | One login/session unless vendor testing proves otherwise |
| Independent accounts/origins | Isolated RealBud browser pool | Up to 2 | Separate Chromium process and RealBud-owned profile per lane |
| Visible desktop/CUA | Existing serial computer lease | 1 | One screen; exact case/recipe/origin; PM owns Submit |
| Cloud-safe independent work | Remote isolated lane | Bounded by policy | Explicit account, disclosure, spend limit and data class |

Deterministic batch and DOM loops are preferred over asking a model to reason
again for every property or page. Model fan-out is reserved for genuinely
independent interpretation or drafting work.

## Product modes

- **Local standard:** all structured work is batched; analysis is serial until
  the bounded analysis adapter exists; one private browser lane; one CUA lane.
- **Local accelerated:** up to two isolated browser or analysis lanes after a
  CPU/memory check and only for independent concurrency keys.
- **Cloud accelerated:** optional remote lanes for independently partitionable
  work after explicit connection, privacy and spend gates. Local fallback
  remains complete.

Auto selection may choose local acceleration when it is ready and the device
passes the resource check. It must not choose paid/cloud execution without a
verified connection and the PM's saved opt-in. Requesting an unavailable mode
falls back to local standard and names why; it never drops records.

## Browser isolation

Each browser lane owns a dedicated process and a profile directory under the
RealBud data boundary. No two lanes share a mutable profile. The route contract
contains an opaque concurrency key, never a cookie, password, token or personal
path.

Accounts with the same concurrency key serialize even in accelerated mode.
Two lanes are permitted only when the work is independent and the relevant
portal test proves simultaneous sessions do not invalidate cookies, trip
security controls or create stale reads. The planner may reduce concurrency at
any time; it may never raise it from model prose.

The QA-only Agent Browser CLI remains a simulator driver. Product authority is
the typed, exact-origin RealBud adapter. The broad CUA MCP surface and Hermes's
generic browser bootstrap are not passed to Bud.

## Work lifecycle and durability

The Demo broker now uses one versioned work item per independently retryable
unit:

```text
planned → admitted → queued → leased → running → evidence-ready → reconciled
   │          │         │        │         │              │
   └──────────┴─────────┴────────┴─────────┴──────────────┴─▶ cancelled
                                  ├──────────────────────────▶ failed
                                  ├──────────────────────────▶ expired
                                  └──────────────────────────▶ effect-unknown
```

Every item binds a server request id, idempotency key, current book/case
revision, input digests, route kind, account concurrency key, allowed origins,
recipe/version, expiry, cancellation generation and lease fencing token.
Secrets and content never enter the receipt. A retry can resume or reproduce
only a proven read/idempotent step. A lost acknowledgement after a possible
external effect becomes `effect-unknown` and is not replayed.

New items additionally bind an immutable work-plan digest and the complete
content-free adapter binding. A PM request or named scheduled occurrence can
admit only local read/classify/draft work. Possible external work and every
remote route require the exact one-time Allow decision. The plan route chain is
ordered: a local primary cannot contain a later cloud route. Read-only cloud
work may move forward to an already-disclosed fresh local fallback after a
retryable pre-effect failure. The caller must present the exact current fence;
the broker increments it so a duplicate fallback request or abandoned cloud
claim cannot advance or complete. Expired work cannot reroute. It cannot move
backwards, add an undeclared route or reroute possible-effect work.

The receipt lifecycle and crash matrix are source-built. Ask has a selected-file
workspace boundary, but this is still not a claim that the current source
candidate has an independently brokered analysis adapter, local browser pool,
live CUA operation or cloud provider.

## Estimates and progress

The UI reports the route before work starts: total records, batch count,
browser-bound records, selected concurrency, fallback reason and whether cloud
is optional. It may show a duration range only from measured per-route
benchmarks. With no measurements it says timing is not yet available; it never
invents an 8–12 minute promise.

Progress is derived from durable admitted/completed/held/unknown counts, not
model narration. Cancellation stops unleased work immediately, asks leased
read-only work to stop, and preserves any possibly-effectful item as unknown.

## Security and privacy

- Inputs are selected files or typed app-owned evidence references.
- Each analysis task uses an ephemeral RealBud-owned workspace with bounded
  files, CPU, memory, time and network policy.
- Browser profiles are encrypted/retained only as the named adapter requires;
  deletion and re-authentication are visible recovery actions.
- No lane receives trust/payment/statutory/send/Submit authority.
- Prompt or page content is untrusted data and cannot widen a tool list,
  origin, account, recipe, expiry or approval.
- Cloud routing requires a named provider, data-processing disclosure,
  residency/retention decision, per-batch spend ceiling and local fallback.

## Failure and recovery

| Failure | Required result |
|---|---|
| Low CPU or memory | Fall back to local standard before launch |
| Browser pool/runtime absent | Keep browser work queued/gated; batch work continues |
| Same-account duplicate | Serialize/deduplicate by concurrency key |
| Process crash before effect | Lease expires; bounded idempotent retry may run |
| Possible external effect | `effect-unknown`; no automatic retry |
| Stale book/case/recipe | Reject admission and rebuild the plan from current state |
| Authentication/MFA | Wait for PM in the same case; do not copy credentials |
| Cancellation/reconfiguration | Generation fence prevents old work starting or replying |
| Partial batch | Preserve completed evidence; held/failed items remain explicit |
| Cloud unavailable before launch | Select local standard and name the fallback before admission |
| Cloud read fails after admission | Use only a later disclosed fresh local route with a new fence, otherwise hold |
| Local route asks for cloud | Reject; a new exact one-time approval and plan are required |

## Alternatives considered

| Alternative | Latency/cost | Complexity | Safety/product fit | Decision |
|---|---|---|---|---|
| Enable Hermes raw subagents/browser/terminal | Potentially fast | Low initial, high recovery risk | Breaks closed authority and leaks upstream UI/runtime assumptions | Rejected |
| Fork or patch Hermes for RealBud | Flexible | Permanent upstream merge/update burden | Violates external ownership and pin discipline | Rejected |
| Cloud-first execution | Fast on large jobs | Provider, privacy and spend dependency | Makes onboarding/account availability a functionality gate | Rejected |
| One serial model turn per property | Slow and costly | Superficially simple | Repeats reasoning, weak retry/progress behavior | Rejected |
| RealBud planner + typed adapters | Fast batch path; measured fan-out | Incremental | Preserves one Bud, Desk authority and local completeness | Chosen |

## Rollout and rollback

1. **Planner and projection:** pure route selection, resource fallback, measured
   estimate contract and read-only You status. No new effects. *(complete)*
2. **Durable broker:** digest-only admission/lease/cancel/restart tests,
   offline structured/analysis/browser/CUA-shaped simulation and exact-once
   structured Desk reconciliation. Authority/adapter-bound work plans,
   forward-only disclosed cloud-to-local fallback and legacy receipt recovery
   are source-complete. No live accounts. *(complete)*
3. **Local analysis adapter:** Ask selected-file workspace isolation is
   complete; independently brokered stateless contexts, output-schema
   reconciliation, a two-lane load test and serial fallback remain.
4. **Scripted browser loop:** one fake and then named vendor account; same-account
   lane remains one; human Submit and unknown-effect tests.
5. **Private two-browser pool:** independent test accounts only; resource and
   profile-isolation proof; hard maximum two.
6. **Cloud adapter:** opt-in provider, privacy/spend gates, cancellation and
   orphan cleanup; local parity test.

Rollback disables an adapter and recomputes pending work onto local standard.
It does not migrate Desk authority, delete evidence or change Hermes. Work with
an uncertain effect remains unknown rather than being reassigned.

## Acceptance gates

- 100-property structured work is one admitted batch, not 100 model turns.
- Two same-account browser jobs never overlap.
- Independent browser jobs never share a process/profile and never exceed two.
- Visible desktop work never exceeds one lease.
- A missing cloud account changes duration, not supported outcomes.
- Duplicate, stale, cancelled, expired and crash-recovered items are tested.
- Every new receipt identifies its authority class, data classes and exact
  adapter attestation; tampering, stale proof and partial bindings fail closed.
- Local-to-cloud escalation and scheduled browser/CUA plans are rejected;
  disclosed read-only cloud-to-local fallback requires and invalidates the old
  fence, and an expired item cannot reroute.
- No plan or receipt contains credentials, content, personal paths or raw tools.
- Send remains 403; routines cannot launch CUA; Submit remains human.
- Personal Hermes and browser sentinels remain byte-for-byte unchanged.
- Source, package, installed, live-account and cloud proof are reported as
  separate evidence buckets.
