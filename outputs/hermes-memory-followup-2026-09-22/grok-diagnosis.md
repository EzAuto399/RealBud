# Bounded Grok CLI diagnosis and health result

Installed CLI: **grok 1.0.34 (3736acbc8658)**. One distinct deterministic health prompt completed in **9.12 seconds**, exit **0**, stop **end_turn**, **one turn**, with exact structured output `{"probe":"realbud-cli-health","answer":4}`. The actual usage bucket was **grok-4.7-build**, requested **grok-4.7 / xhigh**. Session: `d8da12b8-de4d-41da-9c03-fb86c4f95a47`. No tool-use content blocks were returned. The final receipt is `grok-health-run.json`.

This proves the authenticated model/CLI can complete a tiny structured headless request. It does not prove that substantive xhigh reviews finish inside 180 or 600 seconds, nor establish why the four earlier review packets timed out. No earlier review was restarted, and no second model probe was made.

## Findings

The normal read-only inspection discovered 2 MCP servers, 8 hooks and 441 skills. Only safe metadata was persisted; commands, arguments, auth contents and raw config were not dumped. The official headless documentation says the tool allowlist concerns built-in tools while MCP meta-tools remain, and ordinary JSON is emitted after completion. Therefore an empty final-output file does not by itself diagnose a startup hang. [Official headless reference](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)

The probe used documented process-scoped `GROK_HOME` and compatibility scanner environment overrides, a private disposable home and empty working directory, updater/memory/subagents disabled, plus the existing cached login through an opaque temporary symlink. No credential contents were read by the harness, copied or displayed. User config remained byte-identical. [Official settings reference](https://docs.x.ai/build/settings/reference)

An initial inspection guard stopped before any model call because it counted discovered-but-disabled entries as active. Inspection deliberately reports such entries. After correcting this distinction, preflight showed zero active MCP servers/hooks/plugins/project instructions; 219 shared native skills remained discoverable.

**Runtime contradicted that preflight:** the streamed session initialization reported `semble` connected and advertised **24 tools**, despite the no-tool request and isolated inspection. The probe itself made zero tool calls. This candidate is **not proven MCP/tool isolation**. Possible causes include CLI/leader/runtime discovery differences, but no cause was verified and none is claimed. The first output arrived after 6.286 seconds; completion then followed normally.

## Supported next usage and limits

The installed CLI successfully accepted `--json-schema` together with `--output-format streaming-messages-json`. A bounded collector can inspect the actual runtime init, consume terminal `result`, validate `structured_output`, check `stop_reason`, and retain returned model/session information while excluding reasoning/raw diagnostics. Keep a wall-clock deadline and terminate/reap the owned process group on timeout. [Official scripting documentation](https://docs.x.ai/build/cli/headless-scripting)

A fully isolated, reliably completing substantive development-review invocation was **not established**. Do not treat `--tools ''` or an isolated `inspect` result as proof of the runtime tool set. `grok agent --no-leader` is documented by local help as creating a new agent, but ACP/profile isolation was not exercised in this one-probe scope. An ACP or root-agent isolation investigation is the next separate check if needed; no guessed settings or global changes were made here.

## Cleanup

`grok-health-cleanup.json` confirms zero remaining processes matching the exact owned process group/session/wrapper. The temporary Grok home and authentication symlink were removed. The user config hash is unchanged. No product source or global settings were modified.
