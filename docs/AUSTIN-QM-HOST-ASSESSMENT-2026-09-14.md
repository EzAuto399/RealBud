# Auston: assessing QM on an existing office desktop

14 September 2026 · Source assessment and bounded feasibility plan

**Follow-up source review and decision:** the [company-platform plan](REALBUD-COMPANY-PLATFORM-PLAN-2026-09-14.md) supersedes the open-ended full-QM adoption spike below. Keep RealBud + stock Hermes, and evaluate small attributed extractions of grants/memory revision and durable-queue patterns. `@yc-software/qm` publishes its deployment CLI with only a contract export, not reusable runtime services. The source also includes Docker deployment, email invitations and a background-work disable switch; the original review below missed these details. All findings remain source-only; no QM runtime was installed or tested.

## Recommendation

Keep the user's chosen physical arrangement: **one of the two existing Windows desktops hosts the office service, and both desktops access it**. No third computer or cloud-server subscription is a baseline requirement. The hosting PC must pass capacity and availability checks while staff continue normal work.

QM means [yc-software/qm](https://github.com/yc-software/qm), a shared-work agent system. It is a credible candidate for the staff/office infrastructure we would otherwise build. Evaluate that reuse before implementing a new membership, scope and workspace system in RealBud. Adoption is not yet established: its local deployment, Hermes compatibility and RealBud's computer/action boundaries need proof.

This is an assessment of upstream commit **`361a6c0095dcd3d156aca91353f3ffba0bb8b69b`**, dated 14 September 2026 00:54:44 UTC. Selected sources and their URLs are preserved in [the evidence folder](../outputs/qm-architecture-review-2026-09-14/). Upstream instructions to deploy are documentation, not authority to deploy it here.

## What QM can contribute

QM describes personal and shared scopes, web/Slack access, grants, memory, skills and background work. Its deployment directory separates organisation-specific configuration from core. These are relevant to making the same product deployable for another office without distributing Auston's data. They are upstream features to evaluate, not proof of RealBud integration. [QM overview](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/README.md).

| Need | Source finding | Implication |
|---|---|---|
| One host serving multiple people | QM has an identity service, scoped state and web-facing services. | Potentially substantial reuse for staff access; test two real authenticated browser clients and revoke one membership. |
| Durable office state | Config selects Postgres for sessions and runs; default memory storage is not persistent. | A QM deployment needs durable Postgres and backups even if CRM is never purchased. This replaces the earlier assumption that the existing RealBud store is necessarily sufficient for every candidate. |
| Local execution without cloud infrastructure | `local-sandbox.ts` implements Docker containers, per-scope home volumes, CPU/memory options and lifecycle calls. | A local substrate exists in source. A supported, repeatable Windows-host installation still needs to be built/verified. |
| Repeatable new-customer setup | Deployment configuration is separated from upstream; CLI supports Fly, AWS and single-host Docker. Docker backend requires a Unix socket. | Do not infer a native Windows installer or device enrolment. RealBud host packaging/service/auth/restore still needs implementation and proof. |
| Member-scoped files and state | Personal/shared scopes and grants exist; Docker volumes are named by scope. | Test private markers, shared reports, grants and revocation across all active tool routes. Product marketing or directory names alone are not isolation evidence. |

Sources: [identity implementation](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/identity/identity-service.ts), [persistence configuration](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/config.ts), [local Docker backend](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/sandbox/local-sandbox.ts), [deployment contract](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/docs/deploy-directory.md).

Follow-up sources: [Docker CLI target](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/cli/README.md#L31-L70), [Unix socket requirement](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/cli/src/backends/docker.ts#L119-L130), [package exports](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/cli/package.json), [invitations](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/api/routes/admin/users.ts#L77-L205), [background disable gate](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/index.ts#L67-L70).

## Three integration decisions before adoption

### 1. QM does not currently list Hermes as a harness

The inspected `HARNESS_IDS` are `pi`, `opencode`, `codex`, `claude` and `mock`. There is a harness interface, but configuration/model validation uses this closed set. A generic interface is not evidence of a supported drop-in Hermes plugin. [Supported IDs](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/model/pi-models.ts#L24), [interface](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/harness/harness.ts), [routing](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/src/harness/harness-router.ts).

Compare two explicit paths: retain stock Hermes through a maintained, testable integration boundary, or assess one of QM's supported engines against the existing RealBud workflow cases. Engine replacement is a separate product decision. Do not implement a nested agent calling another agent through a terminal as the shortcut: it obscures authority, cancellation, state and cost. Preserve the functioning Hermes path during the evaluation and keep its source unmodified.

### 2. QM sandboxes are not the staff Windows desktops

The local image is a container with `/root` as its home and a sandbox daemon. Its command execution and files do not automatically refer to Kevin's open Windows browser, Excel or REI session. A Windows execution companion is still needed for the accepted native workflows, with a specific device/session, bound actions and local Stop. [Local image](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/local/Dockerfile), [Windows session requirements](https://cua.ai/docs/how-to-guides/driver/windows-ssh).

The first feasibility arrangement should put the QM service, Postgres and isolated sandbox resources on Desktop 1 using a verified local substrate, while both PCs connect through authenticated RealBud-facing access. A Windows-compatible Linux-container route is a deployment candidate, not an already proven installer. Measure the exact two-scope workload while staff use the host. The host being off remains an office-service outage.

### 3. RealBud's action rules need their own authoritative enforcement

QM defaults to Auto security and Isolated sharing. Its security document explicitly identifies limitations in shell-command rules, usable sandbox credentials and browser actions that do not pass through some core approval gates. These are material to bank/PMS work. Strict mode alone does not establish RealBud's no-send/no-pay/no-sign/no-statutory contract. [Defaults](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/.env.example), [documented limits](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/SECURITY.md#known-limitations).

A viable integration keeps the RealBud job ID, actor, exact source/account, permitted operation, reviewer decision and device generation enforced at actual dispatch. Sandbox/browser/terminal paths must not gain independent access to business credentials or bypass those checks. Begin with synthetic inputs and no external communication capability. This is an integration acceptance condition, not an instruction to enable unrestricted QM in the office.

## One authority for each responsibility

If QM is adopted, reuse it for the accepted identity/scope/session/sandbox responsibilities. RealBud owns the office workflows, operational cases, action authority, approval/result verification, recovery and customer experience. Map the stores explicitly rather than allowing both systems to own independent copies of the same business job.

RealBud keeps the office clock under the current product contract. QM has its own background scheduling facilities; identify and enforce a way to keep those from independently running the same business workflows. Do not create two active clocks or rely solely on hiding a schedule button. If this separation cannot be achieved cleanly through maintained interfaces, that is a reason to reject the combined architecture or separately review a migration of responsibility, not to layer around it silently.

Keep the product persona Bud. Staff profiles are people/scopes, not a roster of competing assistants. Slack is optional; two PCs can first use authenticated clients without requiring an additional messaging deployment. CRM remains optional and its care fee unresolved.

## Smallest useful feasibility build

Complete this before spending the main implementation effort on either a fresh RealBud team layer or a full QM migration:

1. Pin a reviewed QM revision in a disposable local environment. Use durable Postgres and two synthetic member scopes, with external actions disabled. Set up real authentication for both clients; the documented localhost development login bypass is not a LAN sign-in system. [Service/auth separation](https://github.com/yc-software/qm/blob/361a6c0095dcd3d156aca91353f3ffba0bb8b69b/docs/combined-services.md).
2. Load a sanitised Auston preparation fixture. Demonstrate two private conversations and one deliberately shared accounts case. Verify denied access by requesting the other member's IDs, files and memory. Remove a member and prove pending work is invalidated.
3. Map one RealBud job and decision through the candidate. Decide whether it can keep Hermes through a maintained adapter or whether an approved engine comparison is necessary. A candidate must preserve no-effects on denial, stop/cancel, source identity and verified results.
4. Add one synthetic Windows companion operation. Read a harmless test file/window, name the executing PC in the receipt, stop it locally and disconnect/reconnect without replaying an uncertain action. Prove that the sandbox cannot bypass the approved device broker.
5. Close both client windows, restart the host, then restore to a clean replacement environment. Retain accounts scopes, the accepted pack version and one job occurrence. Demonstrate a fresh client join and that the old host cannot resume control.
6. Compare measured setup effort, ordinary-PC responsiveness, ongoing maintenance and successful-work cost with extending the existing RealBud/Hermes path. Adopt QM only if it reduces the total delivery burden while meeting those controls.

The packaging outcome is one RealBud installer with **Set up this office**, **Join this office** and **Move/restore this office**. A new office gets reusable application/pack assets and new private configuration; an existing-office backup is confidential. Local Postgres and container volumes are infrastructure to package and maintain, not customer-facing CRM features or a reason to sell CRM.

## What this review proves

The repository metadata, tree and selected pinned sources were read and saved. This pass did not install dependencies, run QM, use a model, create infrastructure, expose a service, access office credentials or establish Windows compatibility. It supports a concrete feasibility build, not a production-readiness or zero-running-cost claim.

The [two-desktop plan](AUSTIN-TWO-DESKTOP-PLAN-2026-09-14.md) still governs the physical topology, member/device boundaries and restore requirements. Its existing RealBud implementation gaps remain valid; use this assessment to decide which of those capabilities to reuse from QM before rebuilding them.
