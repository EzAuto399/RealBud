# Fresh ACP development review — terminal success

One distinct metadata-only Windows fixture review completed through a fresh local ACP agent. The agent returned `end_turn` at **50.908 seconds**, then exited **0** on stdin EOF; total collection and cleanup took **53.744 seconds**. The returned session options confirmed **grok-4.7 / xhigh** before the sole prompt. Usage reports **one model call, one turn**, and actual model bucket **grok-4.7-build**. No tools, client operations, or permission prompts were observed.

Session: `01a0c52b-5be2-76d0-b0c5-6bbdbdd36140`. Installed CLI: `grok 1.0.34 (3736acbc8658)`. Exact sanitized initialization, selected model/effort, terminal usage, final answer and cleanup are in `grok-acp-windows-fixture-run.json`.

## Supported invocation and boundaries

The documented `grok agent --no-leader stdio` path starts a local agent instead of connecting to the shared leader. The test supplied `--model grok-4.7 --reasoning-effort xhigh --agent-profile <temporary-profile>` before `stdio`, with global `--no-auto-update --disable-web-search --permission-mode plan`. It sent ACP `initialize`, `session/new`, then exactly one `session/prompt`. [Official ACP reference](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)

The profile uses the documented full prompt, empty tool list, `agentsMd: false`, no preloaded skills and plan permissions. Process-scoped `GROK_HOME`, scanner overrides, memory/subagent disablement, and an empty working directory preserved the user's settings. Existing authentication was accessed by the CLI through an opaque symlink; the harness never opened, copied or printed credential contents. [Agent definition reference](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/README.md), [settings reference](https://docs.x.ai/build/settings/reference)

A subtle CLI distinction matters: the inspected current official source does not forward top-level `--max-turns` or the headless CLI tool allowlist into `run_agent_command`, even though the combination parses successfully. This source was not established as byte-identical to the installed binary. The collector therefore makes no claim of a native ACP max-turn flag: it permits only one prompt, aborts on tool/client-operation activity, and enforces a 300-second total deadline. This successful terminal usage independently confirms one model call and one turn. [Official command dispatch source](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-bin/src/main.rs)

## Development result

The review accepted the separation between independent fixture preparation and a production verifier that never repairs existing ACLs, subject to these assertions:

- Independently verify the prepared ACL before invoking production code; perform no ACL repair afterward.
- Assert local fixed NTFS, persistent ACLs, protected root DACL, accepted owner/ACE principals and effective current-user full access.
- Prove inherited-child binding to the verified root and refusal of reparse points and extra hard links.
- Compare bytes and SDDL before/after both accepted and deliberately broadened fixtures, including no changes to the parent outside the disposable root.

These are design-review recommendations, not new Windows test evidence. They align with the intended verify-only policy and identify concrete acceptance assertions; no production source was changed.

## What this does not establish

Fresh ACP initialization completed in **1.168 seconds**, session creation in **1.391 seconds**, and the model API duration was **49.044 seconds**. This invocation did not stall during startup. It does not determine the cause of earlier `--single` review timeouts or guarantee broader xhigh review latency.

**Full MCP/tool/context isolation remains unverified.** The protocol announced MCP initialization, but this strict collector retained notification shapes/counts rather than server descriptors or startup payload values. The model consumed **32,807 input tokens** despite a tiny metadata prompt, so the supplied prompt was not its entire input context. No cause is attributed to that extra context. Empty tool/profile flags and no observed tool calls are not proof that no tools were advertised.

The external cleanup check found no matching owned agent/group/wrapper processes. The private home and auth symlink were removed; global config hashes matched. No prior review packet was rerun, and no second model request was sent.
