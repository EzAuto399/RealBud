# Fresh Grok model probe — 2026-09-22

The authenticated fresh ACP session did not offer the requested Grok 4.7 model. Requested `grok-4.7 / xhigh`; returned `grok-4.6 / xhigh`. Available model options: `grok-4.6`, `grok-4.5`.

Stopped before sending any review packet: **zero prompt requests, zero model review calls, zero tool calls, zero permission requests**. No fallback, retry, or second session was attempted. The prepared source packet remains local and was not submitted.

The existing collector pattern used an empty workspace, full agent profile with empty tools/skills, disabled scanner integrations, memory/subagents disabled, plan permissions, and a cached-auth symlink in a private temporary Grok home. The harness did not read or copy credential contents. Configured restrictions are not a claim of fully verified hidden model context; no prompt was sent.

CLI: grok 1.0.34 (3736acbc8658). Session: 01a0c6b5-6290-79e3-af92-c9e2da3925c2. Elapsed: 4.548 seconds. Owned process group reaped, temporary auth-symlink home removed, global config hashes unchanged. The agent was terminated after metadata; exit 143 reflects that deliberate cleanup.

Evidence: `grok-department-review-run.json` contains sanitized session metadata and cleanup. `grok-source-snapshot.json` pins the unsent review packet. No product source was edited and no review findings were produced.
