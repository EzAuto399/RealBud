# Approval settings and phone approvals: spec, 7 October 2026

**What this does not establish:** this is a design spec drawn from source reading. Nothing has been built, run or reviewed in the app. Workstreams P5 and P6 in [Platform gaps plan](PLATFORM-GAPS-2026-10-07.md).

**Owner decisions (7 Oct):**
- Approval policy is set per department. Anyone with **edit** on a department sets it; the owner can reset any department.
- Phone approvals are wanted. v1 covers reads, in-app writes, and sends with the full message shown.
- Defaults taken for momentum (the owner can change these):
  - A member in several departments gets the strictest merge of those departments.
  - Direct connections keep "Ask every time" as the recommended default.
  - In v1, Bud's proposals change only the office's own settings.
  - Quiet hours hold back live cards.
  - Tool cards go to one-to-one chats only.
  - `DESIGN.md:128` ("never offer always-allow") is retired for reads only.

## 1. Current flows

**Connected apps**
- Entry is `connected-apps-broker.ts:248`, then `connectedAppPolicy` (`:30`).
  - Direct connections are "review" for everything (`:48`, `:54`).
  - Managed connections go through `classifyAppToolCall` (`shared/app-tool-policy.ts:208`).
  - The Gmail reader cards each of its 3 reads (`:262`).
- Cards show raw JSON (`:285`). They come from `reviewOnce` (`core.ts:951`), which emits `request.opened` (`:969`). `index.ts:1512` pushes the card.
- The answer returns through `/api/threads/:id/respond` (`index.ts:5196`), then `guardPermissionDecision` (`permission-policy.ts:42`), then `respondToRequest` (`core.ts:1429`).
  - `reviewOnce` turns "session" into deny (`:960`).
  - The receipt is written before dispatch (`operations.start`, `:324`).

**ACP permission requests** (`core.ts:723-815`)
- Workroom auto-approve, full-auto, or approve once.
- In `index.ts:1349`, browser and computer tools go through `fenceDecision` (`portal-fence.ts:228`, `loadRules()`). Other tools go through `evaluateRules` (`rules.ts:167`), then a card.

**Browser**
- The broker gate (`browser-broker.ts:307`) calls `authorizeBrowserAction` (`browser-authority.ts:1128`).
- It checks site rules (`:1209`) and read-only task scope (`:1192`). Consequential actions are approved once (`:1170`).

**Rules**
- The card's site rule calls `addPortalRule` inside respond (`index.ts:~5222`). The renderer's "Always allow" posts to `/api/rules` (`store.tsx:1151`).
- No role check anywhere: `index.ts:3365-3405`.

**Phone**
- `notifyDeskSnapshot` calls `pushFromSnapshot` (`remote-decisions.ts:439`), which checks quiet hours (`:97`) and the fingerprint (`:424`).
- Telegram sends the card (`telegram.ts:293`, `d:<id>:allow`). The callback (`:650`) calls `decideRemotely` (`:179`), which checks the paired key and that the card is still current.

## 2. Data model

No database migration. No change to `shared/contracts.ts`.

**New `shared/approval-settings.ts`:**

```ts
type ApprovalChoice = 'allow'|'ask'|'ask-writes'|'deny';
interface ApprovalSettings { version:1; purpose:'approval-settings';
  groups: Record<string,ApprovalChoice>;   // 'app:gmail','site:<host>','connector:<id>'
  tools:  Record<string,ApprovalChoice>;   // 'app:GMAIL_FETCH_EMAILS','connector:<id>:<tool>'
  reviewedReads: string[] }                // owner-only
```

**Validation**
- Exact keys only. At most 200 entries and 16 KiB.
- `allow` is accepted only for tools that are reads, by `classifyAppTool`, the connector tool class or `reviewedReads`.
- Tools that always need approval accept only `ask` or `deny`.

**`decide(settings, {group, tool, cls})`** returns run, card or refuse:
- `blocked`: always refuse.
- Always-approve classes: deny → refuse; anything else → card.
- Reads: allow or ask-writes → run; ask → card; deny → refuse.
- Writes: deny → refuse; anything else → card.
- A tool setting overrides its group setting.

**Department storage**
- Kept in the department scope's records under key `realbud-approval-settings:v1`. Inserts already require `scope_allowed(scope,'write')`; owners pass through `actor_is_owner`.
- Append-only: `schema.ts:528` revokes UPDATE and DELETE. Each revision records author and time, and consecutive revisions give the before and after.

**Single desktop**
- `DATA_DIR/approval-settings.json`, written with `writePrivateJson`: `{revision, settings, receipts[≤500]}`.
- Each receipt is `{at, by, department:null, before, after, note?}`.

**"Always" rules**
- Stay in `rules.ts` under a new allow-only key, `app:read:<SLUG>`.
- Adding or removing one appends a receipt.

**Which settings apply on a desktop**
- The strictest merge of the departments the member is granted.
- Otherwise, the office's local settings.
- The verified copy is cached. Any widening lapses after 12 h without a refresh.

## 3. Enforcement points

| Point | Change |
|---|---|
| `connected-apps-broker.ts:262` | After the blocked check, run `decide()` on every batch row and take the strictest result. Then check this-task grants and `app:read` rules; the note reads "allowed by rule · Reading Gmail". |
| `connected-apps-broker.ts:285` | Plain-English lines. The exact request moves under "Exact request". |
| `browser-authority.ts:1128` | Site Deny refuses. Site Allow becomes a `portal:read` rule; site Ask becomes a deny-rule key. The engine is unchanged. |
| `browser-broker.ts:263`, `index.ts:1400` | `loadRules` becomes `effectiveRules()`. |
| `portal-fence.ts:228` | Site Deny check (one line). |
| `mcp-connector-broker.ts:~95` | Can only make things stricter. Trust marking stays in the owner's connector review. |

**Must not move**
- Blocked classes, and the gateway refusal (`composio-apps.ts:163`).
- `MAIL_SENDS`: one card per message, never inside a batch, full review, credential refusal, saved-draft recheck.
- `assertCapability` before and after the card; the receipt written before dispatch.
- `allowedOfficeAppCall`, and the shared mailbox's read-only grant.
- `reviewOnce` refusing "session"; the 285 s limit.
- `guardPermissionDecision`, `requiresOnceApproval`, and the reserved memory key.
- `looksDestructive` and `looksSensitive`.
- Browser:
  - credentials, scope, expiry and budget checks
  - consequential actions once only, with verified facts
  - unusual names never allowed by rule
  - uploads always approved once
  - submit never allowed by rule
  - unattended loop reads ignore rules
- Password handover (`index.ts:1361`). With no saved job, deny (`:1375`).
- The respond live-card check (`:5203`), `portalRespondRuleError`, and allow-only site rules.
- Consequential connectors stay unavailable in Ask.
- `scope_allowed` stays in SQL.

## 4. UI

**Workspace → Approvals**
- `you-approvals` replaces the "Bud's rules" card (`YouPage.tsx:359-405`).
- Intro: "Bud always asks before it sends, pays, signs, files a notice, changes an account or deletes. Choose how often it asks about everything else."
- "Settings for: [Accounts ▾]" appears only when the office has departments. People without edit rights see: "Only people who can edit Accounts can change these."
- Rows for apps, websites and office connectors, each with one control:
  - "Read without asking" (greyed out when the row has no read tools)
  - "Ask before changes (Recommended)"
  - "Ask every time"
  - "Don't use"
- Expanding a row shows each tool with the same control.
- Locked blocks: "Always asks, every time" (choices: Ask or Don't use) and "Never allowed".
- "Saved on this computer": the rules, each with Revoke.
- A history of changes.
- One primary action, **Save changes**. "Reset to recommended" is a link with a confirmation.
- Owners also see a "This only reads" link on tools they have reviewed.

**Approval card** (`PendingApproval.tsx:215-276`)
- For eligible reads the server adds `readOffer`.
- Buttons: **Allow once** · Allow for this task · Always allow reading Gmail (editors only) · Deny · Stop.
- Footnote: "Undo in Workspace → Approvals."

**Bud card** (`approval_policy` target)
- Title "Change approval settings", with one before → after line per tool, then "Why:".
- Bud may propose anything stricter.
- To widen, it must name each read tool. No group-level widening, and no `reviewedReads`.

**Right panel** (`ContextPanel.tsx:40-58`)
- "Bud is waiting on you: 2", with rows like "Gmail · Send email · 2 min left", above the Desk rows.

## 5. Phone

**Which cards go to the phone.** The server classes each card read, write, send or not eligible.
- Connected-app cards state their class through `cardMeta.remote`. A broker that doesn't state one stays desktop-only.
- Browser read and navigate count as reads.
- Not eligible: browser consequential actions, memory, scripts, settings and policy changes, uploads, submits, account confirmation.

**Messages**
- **Read:** "Bud wants to read — Gmail. Search mail: … Account: … Waiting until 2:41 pm." Buttons: [Allow once] [Allow for this task] [Deny].
- **Write:** "Bud wants to change something — Google Calendar. Create event: …" Buttons: [Allow once] [Deny].
- **Send:** the full To, Cc, subject, body and attachments, with [Send it] [Don't send]. Over 1800 characters it goes without buttons: "Open RealBud to decide."
- **Not eligible:** "Bud is waiting in RealBud: a payment on portal.example. Open RealBud to decide." No buttons, no amounts.

**Safeguards**
- Each push gets a 12-hex id and a fingerprint of the stored, redacted card.
- A tap is accepted only if the paired key matches, the card is still live, the fingerprint matches and the id is unused. The first answer wins.
- An accepted tap calls `answerLiveRequest`, the same function the desktop uses.
- During quiet hours nothing is pushed, and the desktop card says "Not sent to your phone: quiet hours".
- Receipts are kept in `remote-tool-decisions.json`.

**Refusal replies**
- "This card is no longer current. Nothing was changed."
- "Timed out at 2:41 pm. Bud did not do it."
- "Already decided on the computer (Allowed)."
- "RealBud restarted, so this request ended. Nothing was changed."

**On the desktop**
- An answered card reads "Allowed once by Sam via Telegram · 2:16 pm". The same line goes into the evidence note and the receipt's `approval`.
- While a card is on the phone, the desktop card shows "Also on Telegram".

## 6. Packets

Order: A, then B and C in parallel, then D. All of them start after P1 and P3 merge.

**A — Store and who may change it**
- Files:
  - new `shared/approval-settings.ts` and `server/approval-settings.ts` (+tests)
  - `server/rules.ts`
  - `server/company/index.ts`: typed read, history and save. The generic knowledge save at `:403` refuses the key.
  - `server/company-host.ts`: 3 routes near `:286`
  - `server/index.ts`, 3 spots:
    - editor check on `/api/rules` POST and DELETE (`3368`, `3398`)
    - delegate `/api/approvals`
    - check before `addPortalRule` (`~5222`)
- Tests:
  - the validator refuses Allow on review, blocked and always-approve tools
  - receipts survive a reload
  - Postgres-gated: an edit member, a read member and an owner reset
  - an editor can save; a read-only member gets 403

**B — Enforcement**
- Files:
  - `connected-apps-broker.ts`, `connected-app-operations.ts`, `browser-authority.ts`, `browser-broker.ts`, `portal-fence.ts`, `mcp-connector-broker.ts`, `request-decision.ts`
  - `server/contracts.ts` (`cardMeta`), `server/store.ts`
  - `core.ts`: a 3rd argument on `reviewOnce` (`:951`), and `cardMeta` in the emit (`:969`)
  - `index.ts`, 4 spots:
    - `:1400` `effectiveRules`
    - `:1512` copy `cardMeta`
    - respond handles the app-read task grant and the rule
    - `turn.completed` clears task grants
- Tests:
  - every check on the must-not-move list still fails closed
  - a direct read runs under Allow
  - a denied site is refused
  - no JSON in the card's main text

**C — Bud and the settings screens**
- Files:
  - `workflow-settings-broker.ts`
  - new `ApprovalSettings.tsx`
  - `YouPage.tsx`, `you-navigation.ts`, `PendingApproval.tsx`, `ContextPanel.tsx`, `store.tsx`
  - new `scripts/qa-approvals.mjs`
- Tests:
  - the broker refuses group-level widening and widening a write
  - static markup tests
  - QA at 390 px with zero page errors

**D — Phone**
- Files:
  - new `server/remote-tool-cards.ts`
  - `remote-decisions.ts`: unknown ids go to tool cards; the grammar gains `task <id>`
  - `telegram.ts:309` and `discord.ts:222`: an optional 3rd button
  - `connected-apps-broker.ts`: a `reviewId` on the card, carried into the receipt
  - `index.ts`, 4 spots:
    - extract `answerLiveRequest` from `5196-5235`
    - bind after `:2240`
    - notify at `:1529` and `:1556`
    - `answeredBy` on resolve
- Tests:
  - a stale, double, expired or wrong-chat tap does nothing
  - receipts survive a restart
  - the phone and desktop share one path

## 7. Risks

- `index.ts` and `core.ts` conflict with work already in flight, so each packet touches only the spots named above.
- The 285 s limit is tight for answering on a phone.
- Card text leaves the computer: email bodies and recipients go to Telegram, Discord or Slack.
- A phone approval is recorded under the chat display name, not a RealBud member.
- A department tightening reaches another desktop only when that desktop next refreshes.
