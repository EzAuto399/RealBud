# Pinned Hermes memory approval evidence — 2026-09-21

This is source inspection and local fixture evidence, not a paid provider run or live customer-memory test. No existing worker memory, provider credentials, or upstream source was changed or inspected. The source checkout reports HEAD `345cd2b057a452236de401d3534b8502a7465e8d` (Hermes 0.21.3 / v2026.9.14); `git diff --name-only HEAD` for the four producer/store files below was empty.

Local source root: `/Users/yoda/.realbud/hermes/runtimes/345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7/hermes-agent`.

Verified Git blob IDs (`git hash-object` on the unmodified local source):

| File | Git blob SHA |
| --- | --- |
| `tools/memory_tool.py` | `adf740d5c929e6a8d685becc304cba45b4351250` |
| `tools/write_approval.py` | `39c9a4cda86a5b6d84491db7d26acbdd24e4601a` |
| `tools/memory_tool_store.py` | `7098f918990c257ad0fa099826084cfb384801b4` |
| `acp_adapter/permissions.py` | `32bc642bb4fa4a3ebda63209c458c980185eab78` |

## Exact foreground producer

- `tools/memory_tool.py:82–108`: a single add passes the full `content`; replace passes `old: {old_text}\nnew: {content}`; remove passes `old_text`. The label distinguishes `memory` from `user profile`.
- `tools/memory_tool.py:91–106`: batch details join every `_batch_op_line` with newlines. Each line uses `content or new_text` and the substring selector `old_text`. No detail truncation occurs here.
- `tools/write_approval.py:166–207`: foreground memory calls the installed approval callback; background changes stage. The callback receives `detail.strip()` and `Save to memory: {summary}` with `allow_permanent=False`. `once` and `session` mean allow; deny means blocked; missing/unknown outcome stages. An ACP cancellation maps to deny, so the RealBud refusal does **not** claim to have queued the change.
- `acp_adapter/permissions.py:54–64`: callback becomes `kind: execute`, `raw_input: {command, description}`, `title: description + ': ' + command`. Neither title nor raw input is truncated. ACP still offers a session option when `allow_permanent=False` because `allow_session` defaults true.
- There is no `_format_change_summary` in these pinned producer modules.

Official pinned sources: [memory tool](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/memory_tool.py), [write gate](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/write_approval.py), [ACP permission bridge](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/acp_adapter/permissions.py).

## Eligibility and the security fix

`tools/memory_tool_store.py:276–297` replaces/removes the **entire** entry matched by the supplied substring. Batch operations do the same at lines 314–319. Thus full callback detail is not a full before-state review. Inline RealBud approval is restricted to the exact native single-add description, target `memory` or `user profile`. Replace/remove/all batch callbacks are refused until an actual full-entry preview exists.

Before this fix, native memory detail was labeled `shell`; the text “git is our preferred change tracker” collided with the standing command rule `shell:git`. The adapter now emits `tool: hermes_memory_write`, `approvalPolicy: once`, and a complete, unmodified, bounded `memoryReview` only for eligible additions. FullAuto and a requested session grant cannot broaden it. Missing/mismatched metadata, control characters, oversized content, and credential-shaped content are refused before the actionable event or raw details are emitted. Unknown nameless callbacks carrying a description also require one-time approval; other existing single-approval paths now expose the policy to the host.

The host and UI must enforce this marker independently: no standing/auto/task/Always grant; no Allow from a truncated summary or redacted/incomplete memory content. The host/UI changes have separate owners and verification.

Adapter verification: `memory-approval-add-only-final.log` records 73/73 passing tests across `server/drivers/acp/acp.test.ts` and `hermes-memory-approval.test.ts`; `memory-approval-add-only-typecheck.log` records a clean typecheck (exit 0). The earlier 72-test checkpoint predated the add-only restriction and must not be cited as the final policy.

## Pending queue contract for the next phase

The active profile is resolved by RealBud's authenticated `currentWorkerProfile()` / `propertyProfileDir()`, never by request data. Upstream pending records are `<profile>/pending/memory/<8hex>.json` with `{id,subsystem:'memory',action,summary,origin,created_at,payload}`. Single payloads contain `{action,target,content,old_text}`; batch contains `{action:'batch',target,operations}`. Origins are `foreground` and `background_review`; timestamp is Unix seconds. A reported staging success is not durable evidence: `stage_write` can return after an I/O failure.

The stores are `<profile>/memories/MEMORY.md` and `USER.md`, separated by `\n§\n`. `apply_memory_pending(payload, MemoryStore)` is the trusted native replay primitive. It retains native enabled-target checks, scanning, unique-match behavior, atomic batch and configured character limits. Native `MemoryStore._file_lock` supports Unix flock and Windows msvcrt; it rereads before writes and writes atomically. However, native replay has no expected pending digest, exact before-state CAS, or durable review receipt. Stock `/memory approve|reject` is an interactive slash command, not a `hermes memory approve` CLI subcommand, and must not be exposed as an unrestricted bridge.

The smallest complete follow-up is a separate profile-bound review service and UI: bounded strict pending reads, complete before/after preview, workspace/profile/runtime/config/pending/current-content digest binding, explicit approve/reject, and durable recovery after a crash between applying and resolving the pending record. Recheck all bindings at commit while holding the native store lock. Keep skill-review code and approval resets separate. Reuse native mutation validation rather than writing a second memory format; if the pinned API cannot provide a CAS-safe commit, keep mutation unavailable until a reviewed adapter can do so. Never fall back to the upstream loader's default-enabled config when config parsing fails.

Keep memory preferences distinct from RealBud book/source facts and business approval. Current `hermes-pack.ts` retains memory preferences while owning both write gates; current status only reports general learning supported/policy-ready/enabled, and customer-pack UI exposes pending skills. Add separate memory readiness/count/recovery status. Runtime incompatibility, unsafe profile path, disabled target, unreadable store/config or unsupported shape must hold mutation; preserve all files. If the worker cannot enforce the gate, disable both built-in memory targets rather than imply protected learning. A bare `write_approval: true` on an unverified release is insufficient.

Private business backup deliberately excludes worker memory, conversations, authentication and installation (`server/private-workspace-backup.ts:38`). Preserve that boundary. A new memory review journal in the general workflow database would currently break its strict backup kind allowlist; choose an explicitly separate worker-local journal or design the backup exclusion intentionally. Do not silently import worker memories or account state with a customer pack.

Required next-phase tests: two bound profiles and cross-profile refusal; exact pinned producer fixtures; malformed/link/oversized records; stale pending/current/config digests; target flags and Python character limits; unmatched/ambiguous substring refusal; all-or-nothing batches; simultaneous reviewers; crash after write before receipt and exact retry; no skill-side writes; backup exclusion; actual Windows and macOS file-lock/atomic-write behavior in disposable homes. No live provider is needed for these gates.
