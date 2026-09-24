# Desktop protocol 2 work checkpoint

Owned behavioral source frozen after the accepted-cancellation reporting fix.

- Dedicated encrypted `website-remote-work` version-2 records, strict admission and inert restore. Private previews and execution bindings stay local. Only exact previously approved typed disclosure templates enter immutable publication outboxes.
- Private sharing defaults off. Enabling requires current parent, disclosure scopes and confirmed approvers; every new activation gets a fresh UUID. Disabling fences live execution immediately and durably queues cancellation. Earlier reviews cannot regain authority after re-enabling.
- Shared exclusive coordinator runs enrollment synchronization before work synchronization. Enabled headless work refreshes connection metadata before full authority admission; status/default-off do not probe connections.
- Review publication, online claims, status events and cancellation use durable exact intents. Each dispatch uses the existing executor and request key. Cold-start ambiguous claim/dispatch intent is reconciled through existing lookup or held interrupted; it never starts a replacement worker.
- Private capability checks pin marker, workspace/member, installation, parent, worker/configuration, disclosure and approver identity. Unchanged enrollment observations preserve a live capability; revocation and semantic changes invalidate it.
- A held workspace can reconcile existing remote status without uploading, claiming or preparing work. Running work is cancelled through the existing executor. Accepted cancellation preserves uncertainty; already started/completed executor evidence reports accepted → running → actual terminal outcome without a new claim.
- Renderer views omit credentials, private bindings and outboxes. Backup validation/graph wiring, index provider provenance, website/SQL and actual GUI integration remain parent-owned.

Verification: 102/102 focused tests across four files passed; server TypeScript check passed. Final receipt: `domain-tests.json`. Earlier 101-test receipt preserved as `domain-tests-before-accepted-reporting-fix.json` and at `../portal-identity-2026-09-22/remote-work-domain-tests.json`.

These are local domain/transport tests using fictional connections and executor fixtures. They do not establish deployed website/SQL compatibility, actual Hermes/Gmail execution, Windows/macOS packaging or customer acceptance. Those integration layers remain separate proof gates.

Read-only index review found one concrete await gap: after `websiteWork.check`, re-resolve `websiteRequests.executionBinding` before returning provider instructions, so revocation during adapter probes cannot escape the permission fence. Parent owns that fix and verification.

## Final enqueue audit

The plan binds claim validity to durable enqueue, not every later source/provider call. The adapter previously awaited an already synchronous lookup between the domain's deadline check and enqueue. This unnecessary yield is removed: `lookupExisting` is synchronous, while public `lookup` retains its asynchronous recovery API. Both adapters now persist their existing executor run before the first yield; later source/worker guards remain active. No new execution namespace or lease renewal was added.

Adapter regression receipt: `adapter-enqueue-tests.json`, 15/15 passed. The two new cases queue clock expiry and revocation on the next microtask, verify durable enqueue happened before that boundary, preserve duplicate lookup identity, and confirm no worker call after revocation. Server TypeScript passed after the change. Adapter source refrozen for parent integration verification.

## Committed claim with no executor

Cold recovery previously marked the local row interrupted but could leave the website at accepted with cancellation requested. The desktop now acknowledges accepted → interrupted with a null run reference when lookup finds no durable executor. Pending interruption receipts remain retryable across another restart, using the same event UUID/body. This records uncertainty without fabricating execution, enqueueing a replacement, or acquiring a new claim.

`no-run-recovery-tests.json`: 25/25 remote-work tests passed. The committed-claim/no-enqueue case now asserts portal interruption, null run reference, one claim, zero dispatches and no running event; an additional test covers lost interruption acknowledgement followed by a second restart. Server TypeScript passed. Parent owns actual process-kill/Next/SQL verification and the final full-suite rerun.
