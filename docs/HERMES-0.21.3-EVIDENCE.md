# Hermes 0.21.3 promotion — ACP compatibility evidence

Date: 2026-09-17. Status: **admitted as an installable candidate, not yet recommended.**
Release process: `server/hermes-releases.ts` (catalog) and the comment in that file.

## Why this document exists

The pin procedure requires: match the commit, pin the installers, **run the ACP
smoke**, then recommend. The smoke was missing from the repo and is now
`pnpm qa:acp-smoke`. This records what that smoke establishes and what it does not.

## The pinned identity

| | |
|---|---|
| Tag | `v2026.9.14` |
| Tag object | `7a963716b81be13ba513d4f127633b7da493aff2` |
| **Tag commit** | `345cd2b057a452236de401d3534b8502a7465e8d` |
| Tree | `6e14b9791cdc5a47068685e9429dd5d6bdc5ef5f` |
| `install.sh` | `38547c22f4dd2224ba68a13bc3479309abb17e295b2a2ef79c2d1b8293bd822e` |
| `install.ps1` | `226c70a90ad47e8a4d34cb11aca4ecbeb649e2f9b67fbd009ea49791de2d56f5` |

Installer digests come from
`raw.githubusercontent.com/NousResearch/hermes-agent/<commit>/scripts/<file>`. The
method was validated by reproducing the live 0.21.2 pins exactly first.
`install.ps1` is byte-identical to 0.21.2's; only `install.sh` changed.

### Do not pin the main-branch head

This machine's personal Hermes reports `v0.21.3 (2026.9.14)` but is built from
upstream `6005aa1f`, which is **1653 commits ahead** of the tag commit. Comparing
`345cd2b0...6005aa1f` returns `status: ahead, behind_by: 0` — it is main, which the
pin comment forbids following. The tag is the correct pin.

Related trap: **`hermes acp --version` does not identify a worker.** The managed
0.21.2 runtime reports ACP version `0.21.3`, because ACP versions independently of
the product.

## What the smoke proved

`scripts/qa-acp-smoke.mjs` opens RealBud's exact handshake
(`server/drivers/acp/core.ts:637`): newline-delimited JSON-RPC on stdio, then
`initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false,
writeTextFile: false}}}`. It passes only if the worker answers with protocol 1.

```
ok  0.21.2-managed — protocolVersion=1 authMethods=[xai-oauth, hermes-setup] agent=hermes-agent
ok  0.21.3-main    — protocolVersion=1 authMethods=[xai-oauth, hermes-setup] agent=hermes-agent
```

0.21.2 is RealBud's own runtime and is the control — the smoke is only meaningful
if it passes something known-good.

## Why the tag is safe on the protocol axis, from source

The empirical run above used the main-branch build, not the tag. The tag itself was
verified by reading its `acp_adapter/` at `345cd2b0`:

- `initialize` (`acp_adapter/server.py:502`) returns
  `protocol_version=acp.PROTOCOL_VERSION`. It **ignores the requested version** —
  `:509` only logs it, never compares. So what RealBud receives is fixed by the
  bundled ACP library, not by negotiation.
- The tag pins `agent-client-protocol==0.9.0` (`pyproject.toml`).
- Our working 0.21.2 runtime bundles **the same** `agent-client-protocol 0.9.0`
  (`agent_client_protocol-0.9.0.dist-info`), and that library reports protocol 1 —
  proven empirically, since the managed worker answers `protocolVersion=1`.

Same library, same constant, therefore the same answer: **no ACP protocol skew is
introduced by this upgrade.** The check RealBud performs cannot start failing
because of it.

Every method RealBud drives is present in the tag:

| RealBud calls | Tag implementation |
|---|---|
| `initialize` | `acp_adapter/server.py:502` |
| `authenticate` | `acp_adapter/server.py:526` |
| `session/new` | `new_session`, `:588` |
| `session/load` | `load_session`, `:593` |
| `session/prompt` | `prompt`, `:781` |
| `session/cancel` | `cancel`, `:613` |
| `session/set_mode` | `set_session_mode`, `:967` |
| `session/request_permission` | client-facing: the server calls `conn.request_permission` (`:867`) |

## What is still NOT established

This is a **protocol-surface** verification, not a run of the tag's build. **The
tag-exact runtime has never been executed here.** Doing that means staging it, which
downloads and installs a ~1.6 GB private runtime into
`~/.realbud/hermes/runtimes` and runs the upstream installer. The mechanism is
additive and reversible — `startRuntimeUpdate({ release })` stages into a fresh
candidate directory, and `restoreRuntime` returns the previous selection — but it is
a durable change to a live machine, so it has not been done unattended.

Remaining before `HERMES_RECOMMENDED_VERSION` may move to 0.21.3:

1. Stage the tag-exact build via `startRuntimeUpdate({ release: <0.21.3 entry> })`.
2. `pnpm qa:acp-smoke` against the staged binary.
3. Then, and only then, set `HERMES_RECOMMENDED_VERSION` and re-run `pnpm test`.

## Supporting evidence for the upgrade

`345cd2b0` is **1039 commits ahead and 0 behind** our `939e45c9` — a clean
fast-forward, no divergence. Its release notes name *"Long-lived processes stop
leaking duplicate state.db writer hooks"*, which is the same class of defect
`server/hermes-profile.ts:15-18` warns about ("two writers on that state is
corruption") — the concern the per-seat isolation work exists to prevent. That is
motivation, not proof, but it points the same way as the protocol evidence.
