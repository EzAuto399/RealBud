# Grok website request protocol review

Metadata-only design advice. This review did not inspect production source, implement behavior or run tests. It is not approval or release/customer acceptance evidence.

Requested `grok-4.7` / `xhigh`; completed: **True**.
Actual terminal model buckets: `grok-4.7-build`. Model calls: 1; turns: 1; terminal: `end_turn`.
Prompt: 1838 bytes; one request; no tool or permission calls. Elapsed including cleanup: 114.189 seconds.

## Revoked check fences mail, not epoch

Prep at epoch E with hashes H, profile P, recipe R, fresh Gmail A. Worker W holds E. POST /connected-apps/check then sees A revoked or account B.

- E is unchanged, so W stays enqueued and its stamped epoch still matches.
- Refresh stores unavailable, bumps generation, and readiness loses exact account and fresh success.
- Pre-mail authorize refreshes access, rechecks binding and review, and withholds mail; generic prep stays file/web.
- Prior effects stay; no new mail starts.

## Check splits the two agency snapshots

Adapter saves S0 (A success, E, cfg/profile/recipe digests) and awaits instructions. /check writes revoked A or B at G+1. Late G success returns. Then pre-scan authorize, scan, post-scan compare.

- The second snapshot mismatches, so mail does not start from S0.
- Late G success cannot replace unavailable.
- If scan started, post-scan account/settings/source compare drops the batch; started effects remain.
- Dedup must not apply an older pending success after the newer revocation.

## TTL observation versus config mutation

Valid prep, T0 success cache (five minutes), epoch E. A: /check same account still success. B: /check wrong or revoked account before expiry. C: pack, recipe, agency, config, Desk commit, or connector invalidation; no /check.

- A keeps E and does not stop other work with the same H, P, and R.
- B keeps E, but mail authorize fails; T0 success must not outlive that observation.
- C bumps E before visibility; enqueue of E is rejected; async work stamped E ignores the new cfg.
- Provider rechecks tenant, device, account, and billing, so B fails with no epoch change.

## Advisory adjudication

The returned advice does not override the implementation contract. Correct these imprecise assertions before turning them into tests:

- The model assumes failed or changed observations increment cache generation. Current cache increments generation only on explicit invalidate(); simultaneous refreshes share one pending request. Tests must distinguish observation replacement from credential mutation, and prove newer revocation cannot be overwritten under the real single-flight mechanism.
- Current-account provider authorization alone does not prove the account equals the locally approved account. Independent client-to-gateway reproduction found a pre-existing A-to-B rebinding gap: provider reads B before desktop response validation. The subsequent expected-account precondition fix independently produced zero provider scan calls in the same actual client-to-gateway reproduction; see grok-observation-account-red.json and grok-observation-account-green.json. This is separate local test evidence, not Grok approval or live acceptance.

## Collection boundaries

Existing cached authentication was supplied by an opaque symlink in a disposable private Grok home. The collector never opened or copied authentication contents. CLI auto-update, memory, subagents, tool lists, workspace instructions, web search and external MCP configuration were disabled or omitted. Observed MCP server/tool counts and no-tool activity are retained as evidence; they are not a claim of OS-level sandboxing.

The owned process group was reaped, isolated home removed and global config hash independently rechecked. See `grok-observation-cleanup.json` for the exact result. No production edits or global configuration changes were made by this reviewer.
