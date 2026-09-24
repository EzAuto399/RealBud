# Workflow-pack archival design review

The single fresh ACP review completed with `end_turn` after **189.608 seconds**; collection and cleanup finished after **192.83 seconds**, exit **0**. Session options confirmed `grok-4.7` / `xhigh` before the only prompt; terminal usage reports actual **grok-4.7-build**, **one model call and one turn**. The prompt contained **1380 bytes** of fictional architecture metadata. No tools, client operations or permission prompts were observed.

## Recommendations and interpretation

1. Bind preview/confirmation to the profile, pack, current generation, full history fingerprint and exact selected snapshots. Exercise stale and cross-profile/cross-pack confirmations, proving no journal mutation or new selection.
2. Verify durable archive bytes before publishing new journal references. Inject interruption at temp write, hash, sync and journal-swap boundaries. Retrying the same operation must finish that operation or return its prior receipt; it must never apply to a newer selection.
3. A backup racing archival must represent one consistent journal and its complete referenced archive set. Missing, truncated, incorrect-hash and wrong-pack files must fail admission. Preserve active state, rollback configurations, approvals, schedules, business data and ownership claims.

The response's “newest 8” wording is not a requirement to keep an always-full live window: retain the reviewed number of newest rollback configurations under RealBud's own policy. Plain hashes prove bytes match stored digests; they do not establish origin or defeat an actor replacing both files and journal. These findings are design advice, not implementation approval or test evidence.

## Boundaries and cleanup

The collector supplied one prompt only, disabled tools in its profile and refused client operations. It used a private temporary `GROK_HOME` and an opaque existing-auth symlink, without reading or copying credential contents. No live/customer data or production files were given to the model. Global config hashes match, the owned group is gone, and the private home was removed; see `grok-history-cleanup.json`.

The session reported **0 MCP servers** and **0 MCP tools**. This observational result and no observed tool activity do not prove complete model-context isolation. Terminal usage contains **32804 input tokens**, so the compact supplied prompt was not the entire context. No cause is attributed to additional context.

Exact structured model output, protocol metadata and usage are retained in `grok-history-acp-run.json`. No second prompt, continuation or retry was attempted.
