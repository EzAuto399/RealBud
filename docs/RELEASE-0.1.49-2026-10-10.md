# Release 0.1.49, 10 October 2026

**This does not establish:** customer acceptance, a measured speed-up on a customer PC, a live Redbark transaction read, a Windows upgrade over a running service, or a Mac release. The proof is source, local tests and CI Windows packaging.

## Why
On 10 October Auston Realty's Windows PC exposed three problems.
1. **The fixes in 0.1.47 and 0.1.48 never ran on it.** The office service started under 0.1.46 kept running through both manual installs, and the new window kept using it. The health check re-read the version file from disk, so the old process claimed to be the new version. Stopping the process by hand let the office connect.
2. **An Ask turn took about 2 minutes.** The question checked Gmail and the bank feed.
3. **Every Redbark transaction read failed** with "could not be read right now", although the account list worked.

## What changed
- **An old office service is never adopted.** The service reads its version once at start and reports it as `runtimeVersion` on `/api/health`. The window adopts only a service whose `runtimeVersion` matches its own. Any other service, including every pre-0.1.49 one, is stopped through its control route and a fresh one starts. Files: `server/app-version.ts`, `electron/update-service-handoff.mjs`.
- **Redbark gets only its documented arguments.** `list_transactions` had been sent `include_pending:'false'`, carried over from the REST API. Redbark's MCP docs list `account`, `from`, `to` and `limit`, and say unknown arguments are refused as `invalid_arguments`. Pending rows are still dropped on our side. A failed read writes one `connector` log line (step, error code, ms) and never the account, range or rows.
- **Bud's tools are visible to the model directly.** Hermes 0.21.x hid every MCP tool, including all of RealBud's per-turn brokers, behind `tool_search`/`tool_describe`/`tool_call`. That cost one or two extra model calls each time Bud first used a tool family. `tools.tool_search.enabled` is now owned `off`, and startup adds that one key to an existing profile without a Repair. The trade-off is about 3K more prompt tokens per call; large connector sets cost more.
- **Warm workers stay 30 minutes** instead of 10, so a question asked after a short break skips the cold start.
- **One timing line per Ask turn** in `realbud.log` (`event: "turn"`). It records: warm or cold, prelude, worker start, first text, tool count and names, model calls, model time, slowest call and time to headers, upstream errors, total, and outcome. Only numbers and tool names are logged, never a message, argument, account or request id.
- **Ask names the step while Bud works**, for example "Reading the bank feed… · 12s". An unknown tool keeps "Working for Ns", and argument previews are never shown.

## Upgrade notes
- **Each upgraded office gets one automatic hands check** ("Testing Bud on this computer", one model call) after the startup profile write.
- **An office service from 0.1.48 or earlier is stopped and restarted** when 0.1.49 opens. If it is busy, the window says so and waits; it never runs the two side by side.

## Evidence
| Check | Result | Tier |
|---|---|---|
| Full desktop suite and typecheck | see PR | local tests |
| Old-service tests fail without the fix | 4 failed before the fix, all pass after | local tests |
| Hermes ACP tool assembly with search off (0.21.5 f97608f1, 0.21.3 345cd2b0) | 9/9; fails when set to auto | local, env-gated |
| Ask step line at 1280 and 390 px | see PR | local render |
| CI Windows installer | see PR | CI Windows |

## After install on Auston's PC
Ask the same Gmail and ANZ question. Then read the latest `"event":"turn"` line, and any `"event":"connector"` line, in `%USERPROFILE%\.realbud\realbud.log`.
