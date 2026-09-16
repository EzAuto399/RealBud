# RealBud: using Hermes for scripts, monitors and recurring work

13 September 2026 · Source review and verified compatibility update · Installed activation remains a separate gate

**The linked post is useful. RealBud can use more of Hermes in its operational workflows, but the gap is uneven: Ask already exposes substantial native capability, while scheduled Prepare deliberately uses a narrow CLI worker.** We should connect the useful capabilities to verified results and review, and measure that integration before building more parallel infrastructure.

The [HermesWatcher post](https://x.com/HermesWatcher/status/2098759680692822370) links an [article about avoiding unnecessary model work](https://x.com/HermesWatcher/article/2098170172997869943). It is community commentary, not a vendor release announcement. Its three mechanisms were checked against official documentation and both admitted source commits: 0.20.3 (`7339f5f160db5c96657a3bab60151227cc61f66c`) and 0.21.0 (`29112bef099274229cadff79cdff7bf7b99c4b77`). An engine upgrade is not required merely to obtain these mechanisms.

## What the post offers

| Mechanism | What it does | Austin use |
|---|---|---|
| Script-only scheduled job | Runs fixed code without starting a Hermes model turn | File integrity, exact reference mapping, expected-arrival date checks and service health |
| Monitor before model dispatch | Checks a source and skips inference when the relevant observation is unchanged | Wake Bud for new bill evidence or a new export instead of repeatedly asking it whether anything changed |
| `execute_code` during a task | Uses code to batch supported tool calls and processing; returns selected printed results to the model | Extract/filter a collection of approved files and give Bud the exceptions and evidence it needs to interpret |

The first two are documented in [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron). Script-only execution avoids Hermes inference charges for that run; a script or delivery that itself calls an AI service can still cost money. `execute_code` runs inside an active agent task and reduces intermediate context; it is not zero-model execution. Its supported RPC tools do not include arbitrary MCP/Composio/Cua calls. [Code execution documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution).

Version-specific source confirms the [baseline script branch](https://github.com/NousResearch/hermes-agent/blob/7339f5f160db5c96657a3bab60151227cc61f66c/cron/scheduler.py#L4494), [0.21 script branch](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/cron/scheduler.py#L5513), [baseline monitor](https://github.com/NousResearch/hermes-agent/blob/7339f5f160db5c96657a3bab60151227cc61f66c/cron/monitor.py#L148) and [0.21 code execution](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/tools/code_execution_tool.py#L1519). The monitor's agent-facing arguments differ between these releases; bind an adapter to its admitted version.

## What we already use and what is missing

| Capability | Current evidence | Decision |
|---|---|---|
| Native ACP agent, tools and sessions | Ask uses unmodified Hermes ACP. Native ACP chooses its own curated toolset. | Retain this integration; measure actual available tools rather than infer them from profile comments. |
| Persistent memory and reusable skills | A retained 12 September real-model test saved and recalled synthetic memory and skills across fresh ACP processes. This was a temporary private profile test. | Reuse native learning. Add review/versioning for business procedures; memory is not the authority for bank attribution or payment state. |
| Delegation | Present in native ACP; absent from Prepare's permitted CLI toolsets. | Use selectively for independent document analysis with bounded budgets. Multiple agents must not compete for one desktop session. |
| Deterministic bank processing | Existing TypeScript validates CSV, proposes rule matches, preserves source rows and produces a reviewed reference-only output. | Connect this tested service to Bud's workflow. Do not recreate its financial integrity checks as freshly generated code on every run. |
| Scheduled Prepare | Permits only `todo`, `file` and `web`, selected by job capability; fresh model invocation follows preconditions. No content-change gate or script-only branch is present in this executor. | Add a checked decision before model dispatch and connect domain handlers to durable results. |
| Hermes script/monitor scheduler features | Present upstream in both admitted versions; not connected to RealBud routines. | Compare reuse through a single scheduling backend with a small preflight step on the existing clock. |
| Automatic extensions and gateway | Configured MCP/plugins/hooks are deliberately suppressed; RealBud mounts explicit connections and owns its channel routes. | Preserve explicit connection authority. Assess approved extensions individually; turning on another gateway is not multi-user product acceptance. |

Evidence: [Ask adapter](../server/drivers/acp/hermes.ts:17), [native learning result](../outputs/realbud-hermes-upstream-2026-09-12/native-learning.json), [bank service](../server/bank-reference.ts:76), [Prepare toolsets](../server/job-executor.ts:49), [worker invocation](../server/recipe-draft.ts:98), [Prepare dispatch](../server/job-executor.ts:207), [prior upstream integration review](REALBUD-HERMES-UPSTREAM-2026-09-12.md).

The Prepare `file` toolset includes writes and patches; a narrow tool list is not proof of read-only filesystem enforcement. Absence of the memory tool also does not by itself prevent native memory context from loading. Test the effective data and action boundary for each route.

### Ask whole-script approval: finding and verified adapter repair

The earlier source review found a real discrepancy: the profile omitted `code_execution`, but Hermes ACP constructs its native `hermes-acp` bundle independently and includes `execute_code`. The whole-script guard distinguished gateway/ask from ACP's interactive callback and could return approved before that callback. This was present in both 0.21.0 and the latest 0.21.2; omitting a profile toolset did not disable it. The original finding remains useful evidence, rather than a claim that a prompt or working directory supplied enforcement. [0.21 ACP bundle](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/acp_adapter/session.py#L637), [latest whole-script guard](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/tools/approval.py#L1063).

RealBud now forces upstream-supported `HERMES_EXEC_ASK=1` in its child environment, alongside safe mode. For actual ACP this routes the whole-script request through the existing permission callback. The generic ACP responder additionally limits Hermes native scripts and unidentified actions to a provider `allow_once` option, even when a session choice or full-auto configuration is supplied. If that narrow option is absent, it cancels; clearly identified terminal-command session semantics are preserved. The profile comment now states the actual CLI-versus-ACP distinction. No Hermes source was changed. [Adapter](../server/drivers/acp/hermes.ts), [permission boundary](../server/drivers/acp/core.ts).

Real-model tests on stock 0.21.2 used only harmless marker files in disposable private workrooms. They proved a permission arrived before any marker effect, explicit denial prevented the effect, a requested session grant was narrowed to one shot, and a different script in the **same warm ACP session** required a new decision. Denial of that second script and disconnect during a pending request both prevented effects. A separate stock-tool test with no callback returned a blocked result without creating its marker. The prior selected 0.21.0 also passed actual deny/allow/disconnect compatibility checks for the forced ask setting. These are enforced approval tests, not a claim that native Python is an operating-system sandbox. [Latest real ACP result](../outputs/realbud-hermes-latest-2026-09-13/execute-code-approval.json), [missing callback](../outputs/realbud-hermes-latest-2026-09-13/no-approval-callback.json), [rollback release check](../outputs/realbud-hermes-latest-2026-09-13/execute-code-rollback-021.json).

The new recommended release is the official 0.21.2 / `v2026.9.11`, commit `939e45c91d751fadd94dcd1b873ac3cb44846213`. Exact source, installer hashes, ACP, safe-mode configured-versus-explicit MCP isolation, real model/file output, native memory/skills and restart recovery passed. The fresh runtime candidate is retained without changing the installed selection until the updated RealBud package is ready. Installed-app activation, Windows acceptance and real-office permissions remain distinct gates. [Release evidence](../outputs/realbud-hermes-latest-2026-09-13/README.md).

## Proposed workflow design

Use one accepted routine and run identity through this sequence:

1. Check the selected device, account, source availability and coverage.
2. Compare stable evidence, relevant dates, accepted rule versions and pending work.
3. Run a validated deterministic handler when rules determine the result. Invoke Hermes when interpretation or unfamiliar evidence requires it.
4. Validate the artifact or proposed business changes, then present any required review.
5. Save what was checked, what changed, what remains unresolved and the measured cost. Notify according to the accepted policy.

For **ANZ references**, code should parse and preserve the original export, identify overlap/possible duplicates, apply accepted mappings and verify the output. Bud helps explain ambiguous payer evidence and propose a mapping for review. Identical-looking bank rows are not automatically deletable duplicates; the current validator correctly preserves them.

For **expected bills**, code should check the accepted arrival windows and evidence coverage. Bud interprets new invoice content or conflicting evidence. The wake decision must include time: a bill can become missing today even when the inbox has not changed. A failed inbox check must produce incomplete coverage, not a healthy no-change result.

For the **weekly summary**, assemble the verified run and case records mechanically. Use a model for the narrative only when it adds value. An existing unresolved case should stay one case rather than become another daily alert.

Observed source state and successfully processed work need separate records. The inspected upstream monitor advances its observation before agent execution, so unchanged input after a downstream failure cannot be assumed to retrigger the unfinished work. RealBud must retain that pending obligation and its bounded recovery policy. Comparison is by output hash, so normalize ordering and omit incidental timestamps. The URL monitor performs an ordinary HTTP fetch; it does not inherit Kevin's authenticated browser. Bank/inbox acquisition still needs its accepted connection or attended browser path. [Pinned monitor implementation](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/cron/monitor.py#L112).

## Reuse choices before further scheduler work

There are two reasonable implementation candidates:

- Keep the existing RealBud clock and add a small deterministic preflight/domain dispatch, reusing the bank service and calling Hermes only for the remaining work. This fits the current run/approval model and is the smallest initial delivery change.
- Use Hermes as the underlying scheduling/execution service, with RealBud owning the accepted job version, staff authority, review and displayed outcome. This could replace more custom scheduling work if the adapter passes recovery and lifecycle tests.

The second deserves a bounded compatibility experiment. Pinned Hermes exposes `run_one_job` and a replaceable scheduling-provider interface, but that interface is experimental. A processed return also does not establish successful execution. Do not depend on an internal function as if it were a stable public API, and do not leave two independently active schedulers for one routine. [Pinned scheduler](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/cron/scheduler.py), [provider contract](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/cron/scheduler_provider.py).

Assess memory, skills, delegation and supported tool execution for upstream reuse before adding substitutes. Keep RealBud's business-specific responsibilities: approved source/identity, reference integrity, bill evidence, human decisions and verifiable outcomes. The [staff-session design](REALBUD-STAFF-SESSIONS-2026-09-13.md) remains separate work; enabling Hermes messaging alone would not supply office permissions.

## First proof to build after scope confirmation

Start with one expected-bill routine using synthetic office files and the real model. Record whether each run used code, invoked Hermes or held for review, along with source coverage, output hashes, runtime, model calls/tokens and notifications.

Exercise unchanged evidence, a newly arrived bill, a deadline crossed without new mail, missing source access, a human correction, changed rules, a failed run followed by unchanged input, duplicate triggers, restart and Stop. Unchanged complete checks should avoid an agent turn; failures and pending work must remain visible. Verify the saved case and artifact against expected answers kept outside Bud's inputs.

Then run the ANZ preparation through the existing checked-copy service. Compare successful outcomes, cost, correction effort and recovery across the same fixtures. Native capability availability, source checks, synthetic testing and customer Windows acceptance are separate evidence levels.

The original review did not activate schedules, gateways, plugins or model connections. The subsequent source update closes the recorded whole-script approval gap through the existing adapter; packaged activation is tracked separately in the linked release evidence. Commercial scope remains controlled by the [current engagement](AUSTIN-ENGAGEMENT-2026-09-10.json).
