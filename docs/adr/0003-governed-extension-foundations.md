# ADR 0003: Build governed extension foundations before live activation

- Status: Accepted
- Date: 2026-08-27
- Owners: RealBud application/runtime
- Canonical constraints: `docs/GOAL-PROMPT.md`
- Revisit: after the first named API/Composio/MCP adapter, first cloud provider,
  and first stable Computer History-capable CUA pin have each completed their
  installed proof—or on 2026-11-27, whichever comes first

## Context

RealBud needs to close gaps between a PM and many existing systems. Direct
APIs, a restricted Composio account, a reviewed MCP server, isolated local
tasks, private browsers, optional cloud lanes and Computer History can all be
useful. Waiting to design every boundary until the first provider appears
would create one-off integrations. Treating all of them as a generic plugin or
raw tool marketplace would give model prose, third-party catalogs or the PM's
OS account more authority than the product permits.

The product therefore needs the extension **admission and truth** layer now,
while live accounts and external effects remain evidence-gated.

## Decision

RealBud ships a code-owned `realbud.execution-adapter.v1` catalog and a fresh
runtime-attestation boundary.

An adapter manifest may name only:

- one reviewed transport (`direct-api`, restricted Composio, approved MCP,
  isolated task workspace, private browser, bounded CUA, remote lane or stable
  History API);
- a closed PM operation such as reading typed records, reading bounded bank
  credits, reading inbox/calendar context, analysing selected files, browsing
  one approved origin, preparing already-approved fields, or reading bounded
  History metadata;
- one existing work-broker route and its hard concurrency ceiling;
- `read-only` or `prepare-only` effect class.

Send, pay, trust, statutory work, Submit, arbitrary commands, arbitrary URLs,
raw MCP tools, ambient credentials, personal browsers and personal Hermes are
not representable in the contract.

A checked-in manifest proves only **Foundation built**. It does not make the
adapter routable. A server-owned implementation must attest its exact adapter
version, configuration generation, current policy digest, expiry and—where
required—named-account digest and explicit opt-in. Equal-generation retries
are idempotent only when the whole receipt matches; stale generations and
conflicts fail closed. Receipts expire after at most fifteen minutes and are
not persisted as connection truth across restart.

Remote lanes additionally require a bounded region, retention window,
deletion support, encryption in transit and at rest, spend ceiling and
complete local fallback. Revocation advances the configuration generation and
immediately removes the lane from routing.

The stable CUA pin currently lacks Computer History. Its manifest is visible
as `runtime-unavailable`; no preview/nightly runtime is installed to make the
row green. A later stable adapter may expose only opt-in case/session/time-
bounded metadata for recovery. It never becomes Notes, evaluation evidence,
permission or automatic replay.

## Product projection

You -> Connections contains one collapsed **Advanced work methods** row. It is
a read-only status view over the code-owned manifests and fresh attestations,
not another surface or marketplace. It has no Add, URL, key, command, provider
discovery or raw-tool controls. “Foundation built”, “Ready now”, “Check
expired”, “Revoked” and “Stable runtime unavailable” remain distinct states.

## What this changes now

- Direct API, restricted Composio and reviewed MCP share one enforceable
  admission vocabulary without becoming connected.
- Local analysis, private-browser, bounded-CUA and cloud routes can become
  ready only from a fresh exact runtime receipt.
- Cloud cannot remove local functionality or omit privacy/spend/deletion
  policy.
- Computer History has a stable contract and an honest unavailable state.
- Future provider adapters reuse the existing work broker, fencing,
  cancellation, effect-unknown and Desk reconciliation rather than creating a
  second operations kernel.

## Explicit non-decisions

- No generic CLI is enabled. A future command-line need must be a named,
  code-owned recipe inside a genuinely enforced isolated task runtime; a
  scrubbed environment and different working directory alone are not a
  sandbox.
- No arbitrary Composio app, MCP URL, provider catalog or connector install is
  accepted from the renderer or model.
- No cloud provider is selected by this ADR.
- No automatic approval, send, pay, Submit or statutory drafting path will be
  added. Those are permanent product exclusions, not deferred features.

## Rollout and rollback

1. Manifest validation, runtime attestation, expiry, revocation and route
   derivation. *(source-built)*
2. Read-only Advanced status projection. *(source-built)*
3. One named direct/Composio/MCP read adapter through shadow mode.
4. One enforced isolated-task recipe and the private Chromium pool.
5. One optional cloud provider with local-parity and orphan-cleanup proof.
6. Stable History adapter only after the pinned runtime exposes it.

Rollback removes or disables a manifest and recomputes work locally. It does
not migrate Desk, delete Evidence, change Bud, or replay possible effects.

## Acceptance conditions

- Unknown fields, operations and transport/route combinations are rejected.
- A manifest alone never makes a lane ready.
- Named-account and opt-in adapters cannot attest without those digests/flags.
- Cloud cannot attest without the complete policy and local fallback.
- Expiry/revocation immediately removes routing capacity.
- Runtime status exposes no account digest, credential, content, path or raw
  tool.
- Existing manual Allow, human Submit, send 403 and no-trust/no-statutory
  invariants remain unchanged.
