# RealBud staff conversations and connection ownership

13 September 2026 · Proposed architecture, not implemented multi-user acceptance

**14 September update:** two-desktop and member-profile planning is now requested. Follow [the current post-meeting plan](AUSTIN-TWO-DESKTOP-PLAN-2026-09-14.md) and [QM assessment](AUSTIN-QM-HOST-ASSESSMENT-2026-09-14.md). The earlier Kevin-only deferral remains commercial history, not a reason to postpone the requested architecture work. Staff count is unconfirmed; QM is the identified yc-software candidate, with compatibility still to prove. CRM and both retainers remain undecided/negotiable.

**Hermes and Composio provide the building blocks. RealBud must supply the staff identity, permission and shared-work contract.** A separate DM is a conversation boundary. It does not itself isolate persistent memory, authorise a mailbox or grant approval authority.

## What is verified

Current upstream documentation describes per-DM sessions and isolated profiles. Hermes native memory and USER.md are profile-scoped. The selected local 0.21 source also resolves native memory through the profile home, while gateway session keys include chat/user identity. Latest gateway documentation is not proof that every newly documented feature is available in the selected release. [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

Hermes pairing and allowlists govern gateway admission. Its documented admin/user roles mainly control gateway commands; RealBud still needs to decide which office records and tools a staff member can use. Agent delegation or multiple workers is also distinct from authenticated human users. [Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).

Composio accounts belong to stable application user IDs. Sessions may pin exact connected-account IDs. An unpinned default can select the most recently connected account, so an account name in a prompt is insufficient. Composio also documents experimental shared connections with per-user ACLs and explicit session pinning. Evaluate compatibility before adopting that feature. [Authentication](https://docs.composio.dev/docs/authentication), [multiple accounts](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts), [shared connections](https://docs.composio.dev/docs/extending-sessions/shared-connections).

## Current RealBud gaps

| Boundary | Current source behaviour | Required change before staff rollout |
|---|---|---|
| Phone conversation | `server/channels/telegram.ts` admits one paired chat and routes accepted asks into the canonical product Bud thread. | Bind verified platform sender IDs and chat type to authenticated office members. Separate member conversations and continuations. Never identify authority by display name. |
| Memory | `server/drivers/acp/hermes.ts` launches the shared `property` profile. | Separate private member memory/profiles and transcripts, with deliberate shared operational facts. Multiple transcript IDs alone do not isolate memory. |
| Connection owner | `server/composio.ts` uses one configured user ID, otherwise an email or project-key-derived fallback. `server/config.ts` has one office connection object. | Stable agency/member identity and explicit account ownership/delegation records. A secret-derived fallback is not a multi-user identity model. |
| General account selection | General session creation does not pin `connected_accounts`; selected IDs are passed in the worker prompt. | Server-owned allowed accounts and tools, exact session pinning, and revalidation at execution. No latest-account or first-account fallback. |
| Bounded Gmail | `server/composio-gmail.ts` verifies owner, auth configuration and exact active PRIVATE account ID. It rejects SHARED accounts. | Reuse this strict boundary for each accepted account. Shared support requires an explicit new contract and provider checks. |
| Review decisions | Existing remote decisions bind card/fingerprint/revision, but do not implement staff-role authorisation. | Authoritative authenticated reviewer grants on each operation, alongside existing one-decision and stale-state checks. |
| One computer | The lease is in-process, and actual ACP computer containment remains open. | An enforced queue and device lease with Stop/takeover revocation. Two private chats cannot both drive one foreground desktop. |

## Smallest useful Austin configuration

Keep RealBud as one office product. Begin the fit check with Kevin as the sole operator and reviewer, one nominated company source and one computer. Continue Kevin's own work between desktop and the paired DM. The up-to-two agreed Gmail accounts and selected phone route in Stage 1 still require full verification before acceptance. The [command-centre direction](REALBUD-TEAM-USAGE-2026-09-13.md) extends this to later staff messaging without adding a second operator to the current proposal.

If a different person must approve remotely, build a narrowly scoped reviewer route: assigned decision, necessary source evidence and a recorded outcome. It should not inherit Kevin's entire conversation or mailbox tools. Broader private staff assistants remain separately assessed scope.

This serves the observed finance/operations split and the need to know who owns the next step. For later company buyer records, favour explicit submission coverage and post-call updates over assuming that more connected mailboxes solve missing information. The transcript says Kevin cannot see all staff email and that buyer preferences are enriched after calls. Those facts support deliberate company-source permissions; they do not authorise all-staff access.

## Contract for a later private staff DM

1. Resolve an incoming verified sender to an active `agencyId/memberId`. Keep platform IDs, member roles and channel bindings server-owned. Reject unknown people and ambiguous/group contexts.
2. Resolve a member-scoped conversation and Hermes profile. Make company-shared operational facts explicit and provenance-backed. Do not copy private mail, raw conversations or personal preferences into shared memory by default.
3. A request such as “connect my work Gmail” starts a member-bound connection intent. Generate the authorised connection URL for that identity. The person signs in privately. Verify OAuth state, expected member and actual returned account ownership before binding it. A forwarded link or wrong signed-in identity must not attach another person's mailbox. [Account authentication](https://docs.composio.dev/reference/v3/api-reference/connected-accounts).
4. Resolve source grants for that task. Pin the exact account IDs and allowed operations outside the model, with revision and expiry. Recheck at actual dispatch and on resumed work. Reads, drafting and sending are separate grants.
5. If computer control is needed, queue for the named device, acquire its current lease and verify the active tab/window/account. Release on Stop, human takeover or a sign-in checkpoint. Keep private login input and sensitive capture outside the agent turn.
6. Store a proposal with source references and the required reviewer. The approving actor must have authority for that exact operation and current revision. One decision owns the result across every surface. Retrying a notification cannot repeat execution.
7. On member removal, account revocation or changed delegation, invalidate warm sessions, queued work and pending actions. Reconnection creates a new grant; old approvals cannot revive it.

Hermes profiles organise separate files and state. They are not an operating-system security sandbox. A worker with unrestricted terminal/filesystem access could read another profile. RealBud must constrain those alternate routes, artifacts, session search and learned skills too, or use separate restricted execution environments where necessary. Do not claim privacy from directory naming alone.

Keep one RealBud clock and transport. Do not start an independent Hermes messaging gateway alongside RealBud to bypass these gaps. Keep upstream Hermes code unmodified, and test profile/ACP compatibility when promoting its release.

## Shared mailbox versus personal mailboxes

A company mailbox is a nominated shared source with an owner and explicitly delegated staff. A personal mailbox belongs to a staff member and does not become company-wide data merely because that person works at Austin. The office defines which records may become shared work evidence.

Composio connection sharing and the mail provider's native delegation are different layers. For example, Microsoft shared-mail access depends on the relevant Graph permissions and target mailbox identity. Verify the actual provider before choosing an approach. [Microsoft shared/delegated mail](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders).

Do not place OAuth credentials in DMs, prompts or model memory. Persist tokens through the provider-supported secure mechanism, and keep diagnostics limited to actor/account IDs, operation types, revisions and sanitised failure codes.

## Acceptance before claiming multi-staff support

- Two staff interleave private DMs. Replies, history, attachments, continuations and pending decisions stay with the correct member.
- A private synthetic marker cannot cross through chat, memory, session search, skills, artifacts, file tools or delegated workers. Approved shared office facts remain available as intended.
- With two private mailboxes, a prompt, forged ID, alias, cached session or batch cannot select the other person's account. Connecting a newer mailbox cannot redirect a saved job.
- A shared mailbox admits only explicit grantees. Every receipt records actor and actual mailbox. Read permission does not allow sending.
- Spoofed display names, wrong sender IDs, group callbacks, forwarded approval cards, old pairing codes and stale revisions execute no action.
- Removing a member/account while work waits revokes pending calls, warm sessions and scheduled work. Reconnect does not restore old approvals.
- Two computer requests serialize. Stop/takeover revokes the current lease before the next task begins, including across restart.
- A wrong-person OAuth callback fails without creating an ownership binding. Test cancellation, duplicate callbacks, expired intents and unknown provider outcomes.

No staff account model, new connection, remote reviewer or shared mailbox was activated during this design review. These requirements are future implementation work. Monday's proposal should explain the useful office workflow first and describe private staff DMs as an option requiring its own scope and acceptance.
