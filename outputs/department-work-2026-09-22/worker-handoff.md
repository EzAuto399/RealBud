# Assigned-case worker isolation — 2026-09-22

Implemented `askDepartmentWorker(prompt, options)` in `server/department-worker.ts`. It returns the existing `{ok,stdout|detail}` shape. The caller must supply both `beforeLaunch` and `beforeRequest`; absent hooks hold an otherwise supported runtime. Root owns company-claim checks, job integration and UI.

The selected current member profile supplies inference routing and credentials. The admitted runtime is commit `345cd2b057a452236de401d3534b8502a7465e8d`, with version checks and eleven checked routing/context/tool source hashes. There is no private-ask fallback. The dedicated packaged Python helper resolves only the managed inference route, then launches a second interpreter with a fresh private home/cwd/session, no inherited profile configuration or prior messages, context/memory/SOUL/background-review disabled, and only native `todo_list`. The only generated config disables progressive tool discovery; it contains no copied profile fields or credentials.

The isolated interpreter receives a per-run relay token, not the provider key. The authenticated loopback relay pins endpoint/model, accepts only Chat Completions POSTs and todo schemas, bounds request/response bytes, refuses redirects, and awaits current caller authority plus managed-service checks for every inference request. Native socket audit denies direct non-relay egress, including automatic metadata and credential-refresh attempts. Local metadata probes receive 404 without forwarding. Cancellation/deadline abort forwarding and reap the process tree; normal completion/cancellation removes the temporary home.

Reviewed allowances up to 300000 ms and 12 turns are honored, with defaults 120000 ms and six turns. This adapter currently admits API-key Chat Completions routes only. Other wire modes, OAuth/opaque pools, arbitrary provider aliases and external CLI/cloud SDK modes hold until separately verified. Credentials are resolved from the actual selected profile; localhost routing cannot silently substitute `no-key-required`.

## Verification

Command: `REALBUD_DEPARTMENT_TEST_RUNTIME=/Users/yoda/.realbud/hermes/runtimes/345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7/hermes-agent npx vitest run server/department-worker.test.ts --reporter=json --outputFile=outputs/department-work-2026-09-22/worker-final-11b.json` using Node 24.19.0.

**11 passed, zero failed/skipped.** Native tests use the installed Hermes Python runtime and fictional loopback SSE provider. Assertions inspect complete outgoing messages: selected case present; profile MEMORY/USER/SOUL/rules/skill/prefill/config/environment and runtime dotenv canaries absent; exact selected member key/model/endpoint; only todo_list. Additional tests cover second-request revocation, cancellation during awaited admission, cancellation of an active forwarded request, denied launch, unsupported provider/runtime, mandatory authority hooks, fresh-run history separation and temporary-home cleanup, and eight separately guarded inference requests under a twelve-turn allowance. Server TypeScript check passed. Source hashes are recorded in `worker-source.json`.

Earlier failed receipts are preserved. Startup failures exposed native local metadata probes and default progressive tool discovery; the final implementation answers metadata locally and fixes the generated tool policy. A failing key assertion exposed the resolver's localhost no-key shortcut, now rejected. The first long-turn fixture repeated identical tool calls and hit Hermes's loop protection; the corrected fixture advances distinct planning steps without relaxing production checks.

`scripts/testing/department-worker-fixture.mjs` provides stock-pack/synthetic-provider setup and valid SSE replies for root's actual GUI test. `server/helpers/department-worker.py` follows the existing automatically copied Python resource pattern. Root is responsible for final packaged resource receipt and integrated GUI checks.

## Limits

This is local macOS native-runtime/fake-provider evidence, not Windows installed-device or live-provider proof. Runtime source pinning covers reviewed adapter seams, not protection from an operating-system administrator modifying executable code. Abrupt host termination can leave a private temporary directory; future runs never reuse it. An already forwarded inference request cannot be unsent; subsequent requests require fresh admission, and explicit cancellation aborts the active transport. Ordinary `recipe-draft.ts` private-worker behavior is unchanged.
