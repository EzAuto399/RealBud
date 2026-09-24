# Fictional Modelvia API cases — prepared, not executed

[cases.json](/Users/yoda/projects/RealBud/outputs/modelvia-live-2026-09-23/cases.json) specifies four inference calls: exact `OK`, bank CSV with only two approved reference edits, invoice due-date extraction, and morning priorities containing an untrusted embedded instruction. Active calls request **8 / 220 / 160 / 120 output tokens**, at most **508 total**. They use no customer data and offer no tools. This is direct-API qualification, not desktop or customer acceptance.

`optionalFollowups` is separate from those four: an **8-token streaming check** can be the fifth dispatch after the first four pass (**516 requested output tokens total**). Two tool protocol specifications, **120 + 32 tokens**, await separate root review; they offer only a fictional in-memory echo and perform no external action. Preserve the initial **A$0.60 hard account cap**, one request at a time, and the explicit fast route; never raise a cap or switch to JEV to finish this set. The tool continuation uses a documented body template that must be expanded in memory, not sent as written. These specifications add no live authority.

1. **Recheck admission first.** Parent reported deployment `8ba0ba4daece55fd94249b35754e8d38d46de2f9`; semantics below were read with `git show` at that exact revision. `/health` and `/ready` are public liveness/readiness checks, while authenticated `/v1/models` checks the actual key's usable model and price contract. Require `hosted-canary-fast` with the reported 256 output ceiling and visible contract-2 audience-correct pricing. A public green health check does not prove the key or service is eligible. This file makes no live availability claim.

2. **Run each active case once, serially.** Supply one fresh explicit `Idempotency-Key` per case and disable automatic retries. Validate the whole assistant response as specified; reject fences, extra JSON fields, truncated finishes and tool calls. Read `/v1/requests/{x-request-id}` with the same project key and require `settled`, matching project/environment/model and visible exact accounting. Preserve the synthetic output, duration, request ID and secret-free ledger fields. Stop and reconcile unknown outcomes; never resend with a new key to obtain a pass.

3. **Run bounded refusal checks only with their prerequisites.** A known model outside a fast-only project's allowlist returns **503 `model_route_unavailable`**, not an invented 403. The over-limit case uses the supported `max_completion_tokens: 257` alias; every `max_tokens` field remains ≤220. It should return **400 `output_limit_exceeded`** before reservation/dispatch. These two checks require an otherwise eligible key/service; an earlier authentication or readiness error is a blocked test, not a pass. Keep separate idempotency keys for these independent requests. Any unexpected acceptance ends the run and requires accounting reconciliation.

4. **Prove retry accounting from the settled readiness call.** An exact repeat with its original explicit key should return **409 `request_already_processed`** plus the original receipt; a different body under that key should return **409 `idempotency_conflict`**. Compare the original ledger receipt before/after and use an authorised, project-scoped ledger/request readback to establish one admitted request and unchanged total charge. A receipt alone cannot prove there are no other ledger entries. Do not test this with an absent header: delivered headerless calls can legitimately become new billable requests after the derived-idempotency grace period.

5. **Check credential closure without creating new authority.** An already expired, non-revoked fictional key should get **401 `key_expired`** on `/v1/models`; the run's just-revoked key should get **401 `key_revoked`** after separately authorised cleanup. Revocation wins if both conditions apply. Skip expiry if no suitable authorised key is available; do not mint, extend, rotate, change service terms or touch a customer key merely to satisfy this specification. Expired tenant/service eligibility is separately **403 `service_unavailable`**, not key expiry. GET model checks do not invoke inference, but valid authentication can update last-used telemetry.

Source references below refer to **8ba0ba4**, not whatever is currently checked out. Source only was inspected; no tests, API calls, services, credential files or paid operations were run for this preparation.

| Contract | Exact source at 8ba0ba4 |
|---|---|
| Health/readiness and model/receipt endpoints | `managed-gateway/http.ts:212–213,303–312` |
| Key authentication before request body; supplied idempotency header; headerless retry behavior | `managed-gateway/http.ts:337–370` |
| Completion request ID and response shape; OpenAI error codes and receipt on 409 | `managed-gateway/http.ts:378,519–547`; `managed-gateway/openai.ts:339–355,425–428` |
| `max_tokens` / `max_completion_tokens` are exclusive aliases | `managed-gateway/openai.ts:75–81` |
| Model catalogue audience pricing and advertised output ceiling | `managed-gateway/key-gateway.ts:264–285`; `managed-gateway/openai.ts:397–413` |
| Forbidden route and oversized output refuse before admission | `managed-gateway/key-gateway.ts:375–435,702–704` |
| Project-scoped supplied-key lookup; original receipt or conflict | `managed-gateway/key-gateway.ts:675–690`; behavior tests `managed-gateway/key-gateway.test.ts:21–43` |
| Receipt fields and project/environment isolation | `managed-gateway/key-gateway.ts:309–317,352–356` |
| Key revoked/expired precedence; service eligibility is distinct | `managed-gateway/keys.ts:115–127`; `managed-gateway/key-gateway.ts:241–248` |

**Next action:** have the live runner load `cases.json`, verify its current revision and scoped model listing, then execute only within the separately authorised project, time and spend bounds.
