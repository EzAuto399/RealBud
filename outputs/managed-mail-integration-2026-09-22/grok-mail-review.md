# Managed-mail acceptance review — Grok completed

The single **1,048-byte metadata-only** prompt completed in **115.671 seconds** with `end_turn`. Returned config confirmed **grok-4.7 / xhigh**; terminal usage identified **grok-4.7-build**, **one model call and one turn**. Exit **0**, no tool calls, no client operations or permission requests. Runtime MCP initialization reported **zero servers and zero tools**. Total elapsed including EOF shutdown and cleanup: **118.711 seconds**.

Session: `01a0c545-18b0-73d0-b81d-a854180ab53f`. Exact sanitized metadata and unmodified final recommendations are in `grok-mail-acp-run.json`.

## Recommended acceptance cases

1. **Tenant/account binding:** authenticate a fictional tenant A, submit tenant B's account identifier through the real desktop client and gateway. The authoritative server binding must win: either reject according to the existing contract or remain pinned to A; never fetch or persist B's mail. Verify both tenant stores and actual upstream-fetch arguments.
2. **Cancellation and revocation during a read:** first ingest accepted fictional staff mail/tasks. Block the next upstream fetch, then separately exercise cancellation and revocation before releasing a late success. Assert no late mail/task writes, preserved terminal status, and byte/field-equivalent previously accepted staff data. Reject stale response/generation replay while allowing any independently authorized fresh sync that the product contract permits.
3. **Gateway-only provider key:** use a fictional canary key only at the gateway/provider boundary. Exercise success, forced upstream errors and missing-key conditions through the real HTTP/client/parser/ingestion flow. Scan client responses, persisted rows, errors, captured logs and diagnostics for absence of the canary. Staff must not be prompted to supply the managed provider key.

These recommendations target the actual application chain with only upstream provider fetch replaced. The tests themselves were not run by this task. No live Composio/Gmail or customer-account behavior is proved by the model review.

## Scope and cleanup

The collector sent exactly one prompt, requested no tools or web, and preserved the 300-second deadline. It reused the documented fresh `agent --no-leader stdio` path with a process-scoped profile/home; it did not resume or retry an earlier review. The observed zero MCP counts are runtime evidence, not inference from flags. Full context/tool-availability isolation remains unproved: the model reports 32,742 input tokens, more than the supplied metadata prompt alone.

An independent process check found no matching owned agent/group/wrapper processes. The private home and opaque auth symlink were removed and user config hashes were unchanged. No credential contents were opened or copied by the harness. No product source or global settings were edited.

Receipts: `grok-mail-packet.json`, `grok-mail-acp-run.json`, `grok-mail-disposition.json`, `grok-mail-cleanup.json`, and `grok-mail-manifest.json`.
