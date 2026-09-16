# Austin — guided routines, recovery and shared approvals

10 September 2026 · Revision 6 · Design and implementation plan; not a deployed capability claim

## Decision

Deliver Austin a completed, preconfigured workflow pack for **Payment preparation**, **Daily inbox review** and **Expected bills**. We implement its typed steps, account checks, retries, handovers and acceptance fixtures. Kevin connects accounts, confirms business rules and accepts the rehearsed version; he is not asked to build the automation. Later Ask edits become reviewable drafts, not an initial setup dependency. Installation alone does not activate a routine.

Keep schedules, checkpoints, permissions, approvals, delivery receipts and recovery in RealBud. Hermes performs bounded tasks through the existing adapter; Cua supplies approved computer control. This design does not require a Hermes source fork. Compatibility gaps should be addressed at the adapter or through an upstream change if one is later demonstrated. Do not introduce a second Hermes cron for the same workflow.

RealBud owns versioned templates and Austin-specific settings. Updating the app, Hermes or a template must preserve Kevin’s saved routines, decisions and checkpoints. A proposed template change becomes a reviewable revision; it does not overwrite local edits or silently widen authority. Removing/reinstalling the engine leaves routine records intact and unavailable work visibly paused until compatibility and required consent are verified.

This extends Phase 1 to daily inbox review and organising internal work. Sending replies, modifying mailbox labels, archiving/deleting email, changing bank details, importing financial records and making payments each require separately defined authority. A general approval for a routine does not approve every consequential action it might propose.

## The handover Kevin should see

1. **We prepare the routines.** Configure the verified bank/REI route, references, bill cycles, mailbox scope, cadence, limits and reviewer in Austin's settings, separate from reusable pack code.
2. **Kevin connects the accounts.** Owners sign in and consent in their original services. Demonstrate the [login/MFA handover](AUSTIN-HUMAN-HANDOFF-2026-09-10.md): pause, alert, human sign-in, Continue, correct-account check, saved-step resume.
3. **Review one plain-language card.** Show source/account, property scope, schedule/timezone, next runs, output, approvals, limits and notification route. Explain any unsupported step.
4. **Rehearse the prepared workflow.** We demonstrate normal output, an uncertain row, interrupted login and recovery. Kevin confirms the result; a static preview is not rehearsal evidence.
5. **Accept and activate this version.** Save current approval at the server. Show pause, run once, last result and support. Later material changes produce a new reviewable revision.

Use first-party workflow packs with typed input/output and execution contracts; agency settings supply the local differences. A visual builder, marketplace or “ask Bud to invent the workflow” is not required for first delivery.

## Payment preparation — recurring download to verified REI result

The current workflow described by the user already uses REI Cloud's recognition/reconciliation. RealBud improves the input and flags exceptions; the proposal does not replace REI's existing processing or promise every payment will match.

1. At the agreed time, obtain the bank export for the selected account and covered date range. Daily is the proposed starting point; every one or two days is configurable after Kevin confirms whether this means calendar days or selected working days. An anchored two-day interval is not the same as Mon/Wed/Fri, and must not silently reset each week.
2. Use only the approved download route. If MFA, an expired bank session, secure desktop or an unsupported download blocks it, request Kevin's intervention. An authorised manual upload can continue the same run with provenance; it is not proof automatic download works.
3. Save the original immutably with its hash, source/account, time and coverage. Verify a complete CSV/Excel file rather than accepting a clicked Download button, partial file, old file or login HTML. Distinguish **no new transactions** from **download/check failed**.
4. Track source coverage separately from REI processing. Repeated and overlapping exports must not create duplicate work. Prefer stable source transaction IDs. If only date/amount/reference are available, handle collisions explicitly: identical-looking real payments must not be silently discarded. Reversals, late-posted transactions and changed rows reopen a reconciliation exception.
5. Look up proposed property/payment references from the approved versioned mapping and authorised evidence. Preserve leading zeros. Do not invent missing references or alter amounts, dates or payee/bank details. Ambiguous tenancy, split, reversal or property matches remain held.
6. Kevin reviews the changed rows and exceptions. Produce an approved import copy linked to the original and the exact mapping/review version; record row counts and unchanged money totals.
7. Hand off/import through the agreed REI route. REI continues its own recognition and reconciliation. Record accepted and rejected rows and verify the result there. “File prepared”, “imported”, “matched” and “paid” are different states. Retry only rows whose outcomes are known; unknown import outcomes require reconciliation first.

## Daily inbox review — one organised work list

Read the agreed Gmail accounts daily at Kevin's chosen time. Proposed initial organisation: payment questions, bills/levies, maintenance, people to follow up with, and needs review. These are internal RealBud work categories. Creating Gmail labels, moving/archiving messages or sending replies is not included implicitly.

Link each task to its source message/thread and property when supported, with an owner, suggested priority, due date only when evidenced, next action and last checked time. Confidence is not enough to invent a deadline or reference. Repeated reads update the same item; preserve Kevin's edits, completion and dismissal. Reopen only when materially new evidence warrants it and explain why. Unreadable attachments and incomplete pages stay visible, not “inbox clear”. Maintenance identification is included in this list; trade booking and dispatch remain a later workflow.

Bills and payment routines reuse this evidence rather than ingesting the same message independently into duplicate cases. Email bodies, attachments and web pages are task data, never authority to change the routine, grant access or issue a payment.

## Recovery policy — useful problem solving within limits

| Situation | RealBud response | Human visibility |
|---|---|---|
| Temporary connection/rate limit | Up to two automatic retries after the initial attempt; respect provider Retry-After and a configured elapsed/cost ceiling | “Retrying; next attempt at …” and retained attempt history |
| Bad/partial download | Recheck the source and completed file; bounded re-download only within the same authorised account/range | Show failure if no verified file; never claim no new payments |
| Login/MFA/device locked | Save a Needs you intervention, release input and sensitive capture; the owner signs in/unlocks in the original app. Continue checks current scope and correct-account access before resuming the saved step. | One case across desktop/phone; no credential collection, polling loop or blind replay. See the [human-handover contract](AUSTIN-HUMAN-HANDOFF-2026-09-10.md). |
| Missing/ambiguous reference | Search approved mappings and authorised context; present evidence and candidate explanation | Kevin resolves the held row; no guessed financial edit |
| Changed app layout or unknown error | Diagnose within approved read scope; suggest a repair or revised plan | A new action/site/permission requires review before use |
| Unknown external side effect | Inspect the existing result and reconcile before another action | “Outcome unconfirmed”; avoid duplicate import/send/payment |
| App asleep/offline | Record missed coverage and resume a bounded catch-up from the last verified source checkpoint | Show the gap; merge overlapping work instead of replaying every missed slot |
| Retry/cost limit reached | Pause the affected routine step; keep unrelated safe work available | Notify owner with what failed, what was tried and one next action |
| Stop, takeover or revoked consent | Revoke authority and cancel owned work where supported; stale queued actions cannot start | Preserve partial evidence and reconcile any in-flight unknown result |

These retry numbers are proposed template defaults, to tune after the Windows demonstration. Keep occurrence identity, logical operation identity and attempt identity separate. A retry must not mint another logical bank import or approval. One active download/batch per account/range; one controller owns the desktop at a time. Awaiting a human must not hold an execution thread or monopolise Cua; resume only from the latest approved checkpoint.

## One approval shown in two places

A desktop card and a phone card are views of **one durable RealBud decision**. Link each to agency, routine/run, specific action, evidence hash, revision, allowed approver, expiry and current state. Distinguish routine activation, a financial-reference review, an external write and Hermes tool permission; do not reuse the existing draft-wording approval as bank-import authority.

1. Persist the pending decision and notification intent together, using a transaction or recoverable journal.
2. Deliver desktop and paired-mobile views. Save each transport's message/notification ID, generation and delivery outcome. Default lock-screen text is minimal; detailed review needs verified identity and current evidence.
3. Kevin approves or declines on either surface. Authenticate the actor and current scope at the RealBud server. Atomically compare-and-set the current pending revision; only the first valid decision wins. A double tap or simultaneous opposite decision returns the persisted outcome, not a second action.
4. Commit the decision and required action intent with an idempotent operation identity. If an external action is needed, mark the approval **approved** and the operation **queued/running**; approval alone does not mean the action succeeded. Preserve actual executed/verified/failed outcomes.
5. Broadcast the authoritative state to desktop. Queue updates for every mirrored mobile message: mark resolved, remove/disable its buttons, and remove it from RealBud's pending count. Keep the decision receipt for audit.
6. If a notification edit fails or a device is offline, the decision remains final. Retry the view update independently, rechecking the newest revision. An old message/button must always resolve to “already handled/changed”, never execute again. Reconnect refreshes current state.

The product promise is **resolve once, no longer actionable anywhere**. Do not promise that every phone OS notification banner can be remotely erased. Telegram supports editing bot-message markup ([Bot API](https://core.telegram.org/bots/api#editmessagereplymarkup)); the Windows notification surface must be tested with the packaged app ([Electron notifications](https://www.electronjs.org/docs/latest/api/notification)). Edit/close where supported and retain a resolved history entry rather than erasing evidence.

A notification being accepted by a provider is not proof Kevin saw it. Acknowledgement is not approval, and approval is not successful execution. Define reminder and escalation times with Kevin/Danny; quiet hours should not silently bury a selected urgent failure. An offline desktop cannot receive a remote decision unless the approved reachability/relay route exists. Do not use a localhost phone link or store bank sessions on the phone.

## Current code evidence and gaps

| Existing source | Reuse | Work still required |
|---|---|---|
| `server/routines.ts`, `server/routine-persistence.ts` | Durable occurrence claims, overlap protection, missed/interrupted states, approved-recipe checks and bounded historical catch-up | Calendar-day interval semantics, resumable multi-step bank acquisition, distinct checkpoints and typed recovery. Current named loops explicitly do not launch Cua; wire the attended adapter as an owned job stage, not an unrestricted loop call. |
| `server/recipes.ts`, `server/recipe-draft.ts`, `src/components/schedule/JobWorkspace.tsx` | Draft/save/review/approve jobs, revision conflicts and invalidation of changed plans | Austin templates, complete routine cards, prerequisites, sample proof and one setup path shared by Ask/Schedule. Existing Ask schedule routing does not itself enable a routine. |
| `server/remote-decisions.ts` | Paired recipient checks, content fingerprints, stale refusal, authoritative Desk writes | Durable decision/delivery identities, all-surface settlement and bank/routine/tool approval kinds. Pending push tracking and deferred digests are currently in memory. Existing remotely decidable kinds are a limited set of wording drafts. |
| `server/channels/telegram.ts` | Callback handling edits the tapped Telegram message and removes its buttons | Send adapter currently returns no persisted message ID; desktop or other-channel resolution cannot reliably retract every mirrored card. Add receipt storage and independent update retry. |
| `src/lib/notify-desktop.ts`, `server/index.ts` | Desktop digest notification and server broadcast/request-resolved updates | Per-decision notification handles, read/review navigation, terminal-state cleanup, permission-denied fallback and actual Windows proof. Current digest count notification is not a full decision lifecycle. |

Focused existing-source verification in this pass: **98 passed, 1 failed across 5 files**. The failure is the existing schedule-recovery wording assertion at `server/routines-recovery.test.ts:196`: expected “another clock or revision”, received “another schedule or version”. No runtime code was changed by this planning pass, and this check is not proof that the proposed routines or notification sync are implemented. The evidence JSON records the checked file hashes and failure.

## Implementation and acceptance

Extend the existing register with P00 (recurring bank acquisition), U01 (prepared workflow packs and activation), U02 (durable step recovery), U03 (login/MFA human handover), M03 (daily inbox work list), and A03 (shared approval completion). Complete the demonstrated Windows slice first, then join these paths; keep the current proposed A$1,750/A$299 pricing while confirming bank route, mailbox volume and routine limits before commitment. Measure provider cost including retries and inbox scope, then calibrate the A$75 budget.

Acceptance must cover: repeated/overlapping/late exports and genuinely identical payments; missing references and unchanged money totals; no-new-data versus failed checks; weekdays versus anchored two-day intervals, timezone changes and missed runs; same email/thread across accounts and preserved human edits; simultaneous allow/deny across devices, expired/wrong-person decisions and changed evidence; reboot during decision/action/view delivery; failed notification cleanup and stale button rejection; Stop/takeover during retries; actual phone plus matching Windows 11 installer. Obtain Kevin's demonstration and handover acceptance on the joined workflow.

See [operating plan](AUSTIN-OPERATING-PLAN-2026-09-10.md) and [task register](AUSTIN-DELIVERY-PLAN-2026-09-10.json). Revisit the Hermes boundary only if the exact admitted adapter cannot provide the required cancellation, permissions or task events; document the minimal gap before proposing an upstream change.
