# Grok website request protocol review

Metadata-only design advice. This review did not inspect production source, implement behavior or run tests. It is not approval or release/customer acceptance evidence.

Requested `grok-4.7` / `xhigh`; completed: **True**.
Actual terminal model buckets: `grok-4.7-build`. Model calls: 1; turns: 1; terminal: `end_turn`.
Prompt: 1924 bytes; one request; no tool or permission calls. Elapsed including cleanup: 173.076 seconds.

## Restore retargets a profile

Enroll I1, W1, P1; persist the command credential before enrollment. Approve plan, pack, source, grant G, expiry E. Backup envelope, decision, receipt, and outcome. Restore onto I2, company B, P2; claim, dispatch, and post results.

- Restored grants and approvals are invalid and must not retarget or dispatch as P2.
- History and request/run links restore, but first mode needs a new local review, not remote approval.
- Poll, claim, and status recheck installation, company, and account; reporting credentials never claim.
- Proof: invalidated G, binding mismatch, no new receipt, outbox only phase, timestamps, and run reference.

## Authority drops before dispatch

Decision binds plan, pack, source, G, and E. Claim C is in flight when owner cancel, expiry, source revocation, or billing change lands; the awaited call then returns. Retry expired C offline.

- If cancel, revocation, or expiry wins, C has no dispatch intent or run receipt.
- Post-await recheck of bindings, billing, and source auth blocks a stale generation.
- Expired C cannot restart work offline, and a billing owner cannot approve.
- Proof: ordered claim log, decision bound to G, E, plan, and source, and no receipt.

## Lost reply double-dispatches

Morning-review or prepare-recipe saves stable key K, envelope, decision, and dispatch intent. Claim C is accepted; crash or lost reply before outbox commit. Restart mints a new key or reruns offline; another adapter reuses dedup.

- Reconcile K against the actual receipt and mint no new request key or claim.
- A receipt for K blocks another dispatch; if absent, resume only C after recheck.
- Unsupported adapters must not reuse loop or job receipt dedup.
- Proof: one K receipt, sole claim C, matching outbox phase, and no second intent.

## Advisory adjudication

The returned advice does not override the implementation contract. Correct these imprecise assertions before turning them into tests:

- A dispatch intent is deliberately persisted before claim, so claim denial can leave an intent. Assert no valid dispatch permission or new executor receipt, rather than no intent.
- An absent executor receipt after startup must not automatically resume an old approval or expired claim. The contract requires interrupted status and renewed review/claim for the same logical request; stable keys continue to prevent duplicate runs.
- The single saved intent and claim identity may gain later durable reconciliation/decision events. Do not interpret no second intent as forbidding required append-only recovery evidence.

## Collection boundaries

Existing cached authentication was supplied by an opaque symlink in a disposable private Grok home. The collector never opened or copied authentication contents. CLI auto-update, memory, subagents, tool lists, workspace instructions, web search and external MCP configuration were disabled or omitted. Observed MCP server/tool counts and no-tool activity are retained as evidence; they are not a claim of OS-level sandboxing.

The owned process group was reaped, isolated home removed and global config hash independently rechecked. See `grok-website-cleanup.json` for the exact result. No production edits or global configuration changes were made by this reviewer.
