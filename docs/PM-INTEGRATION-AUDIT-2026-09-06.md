# PM workflows and connected-app verification

**Follow-up:** the Bud-owned MCP checkpoint now passes the previously failing write-gate negative control. See [Bud identity and agentic-work review](PM-BUD-AGENTIC-REVIEW-2026-09-06.md) for implementation, current proof and remaining office gates. The initial findings below are retained as the audit record.

Date: 6 September 2026. Scope: RealBud source, installed runtime metadata, integration tests and an isolated real-Hermes MCP canary. No real customer data, account authorization, email, calendar or PMS writes.

## Product direction

Build around completed PM work, not a catalogue of integrations. The PM should be able to say “prepare today's follow-ups” and review a property-grouped work queue with the supporting sources, missing information and next action. They should not have to choose an API, MCP tool or Composio operation.

| PM request | Sources needed | Useful work Bud prepares | Human decision / completion evidence |
|---|---|---|---|
| “Sort this morning's inbox and show what needs me.” | Gmail or Outlook, authoritative property/lease/contact records | Group related threads, suggest property matches, separate urgent issues, prepare replies and a short decision queue | Confirm ambiguous matches; approved sends need provider message IDs |
| “Chase outstanding maintenance across my portfolio.” | Work orders, email threads, quotes/photos in Drive or SharePoint | Identify who owes the next response, compare quotes, draft follow-ups, flag missing access and owner approval | Contractor selection, dispatch and spending remain decisions; receipt must identify each work order |
| “Get tomorrow's inspections ready.” | Calendar, property details, previous inspection report, access instructions | Per-property checklist, unresolved access questions, draft reminders and schedule conflicts | Confirm actual access and scheduling changes; calendar event IDs and versions establish completion |
| “Prepare weekly updates for these 30 owners.” | PMS ledger/export, maintenance status, recent correspondence | One sourced update per property, consistent structure, individual exceptions and a reviewable batch | Confirm recipients and content; no claim of live rent status from an old export |
| “What has gone quiet that I need to follow up?” | Sent threads, replies, work orders, task state | Aged follow-up queue with the last contact, next draft and reasons to wait | Recheck for a newer reply immediately before any approved send; prevent duplicates |
| “Prepare my lease review queue.” | Lease dates and documents, property records | Dated queue, missing documents, questions and draft briefing notes | PM/licensee owns decisions and statutory process; source dates remain visible |
| “Match these invoices to jobs before I review them.” | Invoice PDFs, work orders, quote/approval records | Match suggestions, duplicate detection, discrepancies and an approval pack | No payment; verify supplier identity, amounts and approval records separately |

Recommended first vertical slice: **read-only inbox triage → verified property matching → maintenance follow-up drafts → batch review**. It tests real daily value across mail, PMS facts and drafts without requiring automatic external writes. Choose the first office's actual Google or Microsoft stack before expanding both.

## Current evidence and gaps

| Layer | Observed evidence | What it does not establish |
|---|---|---|
| Installed runtime | `/api/hermes` reported ready; redacted `/api/config` reported Composio not configured | No live Composio authentication or office access |
| RealBud connection setup | HTTP API tests exercise canonical Ask “connect Gmail”, missing-key guidance and already-connected handling against a local broker | Real OAuth browser completion, expired consent, provider-side refresh or account selection |
| Direct Connect client | Focused tests cover account status, JSON/SSE, RPC/tool errors, malformed/truncated/oversized bodies, interrupted requests, HTTP 401/403/429/5xx, concurrency and secret-safe failures | Current real Connect response shapes and successful provider operations |
| Hermes MCP wiring | Fake ACP test asserts endpoint, transport type, credential header and redacted native logs; opt-in canary exercises real Hermes against loopback MCP | The local fixture is not Composio, Gmail, Outlook or a PMS |
| Batch preparation | Uses immutable supplied Desk snapshots and the model-only worker, with per-property results and recovery | Does not mount Composio, retrieve an inbox, paginate provider data or refresh source records |
| PMS integration | Source search found portal-oriented workflows and local book/import paths | No dedicated live PropertyMe/PropertyTree API adapter was established in this audit |
| App permissions | RealBud can display/deny ACP permission requests | This alone does not prove every Composio meta-tool or nested write triggers a request |

`GET /api/connectors` returning 403 in product mode is intentional: the public product uses canonical Ask for connection requests. It is not evidence that a provider rejected authentication.

## Defects corrected in source

1. Substring matching treated `INACTIVE` and `not active` accounts as active. Only exact ACTIVE now qualifies; explicit account facts outrank aggregate status. Malformed result/account collections fail rather than start a misleading sign-in flow.
2. The Connect client ignored MCP `isError`, sometimes returning failure text or an error URL as a successful result. Tool/RPC failures now throw sanitized errors.
3. Response parsing assumed the first SSE data line was the result and waited for the entire HTTP stream to close. It now handles notifications, matching IDs, multi-line/chunked frames, UTF-8 and structured results, then cancels the stream after the matching response.
4. Response bodies were unbounded and errors could echo provider payloads. The client now caps response data at 2 MB, preserves the existing 30-second timeout, cancels readers and uses safe error text. It performs no automatic retries, especially after an uncertain action outcome.
5. HTTP MCP descriptors lacked the ACP-required `type: "http"`. The real Hermes canary initially failed with `Invalid params` before any MCP request. The descriptor and regression expectation now include the required transport discriminator.

These are source changes, not a repackaged or installed app release.

## Verification result

- New connection tests initially reproduced **22 failures / 14 passes** against the previous client. After fixes and additional cases: **42 connection tests passed**.
- Combined connection/client/API/ACP/product-boundary suite: **118 passed across 5 files**.
- Real Hermes canary: initial handshake failed with `Invalid params`, with zero requests reaching MCP. After adding the HTTP discriminator, **initialization, tool discovery, authenticated tool execution, unpredictable source reference, quote arithmetic, missing-fact handling and credential redaction passed**.
- **Release blocker for connected-app writes:** the negative control observed **0 permission requests**, and the inert tool marked write-capable **reached the test endpoint**. The canary exited nonzero as designed. It performed **0 real writes**. This is a confirmed missing gate on this runtime path, not merely absent test coverage.
- Final TypeScript checks and canary syntax checks passed. The changed tracked files passed whitespace checks; a repository-wide check also reported an unrelated existing blank line at EOF in `src/lib/telegram-channel.test.ts`, which this audit did not modify.

Do not describe the integration as end-to-end ready, or enable office sends/bulk mutations, based on these results. A server-enforced action/account policy must be added and the negative control must pass. The installed app was not changed by this audit.

## Required workflow acceptance matrix

| Scenario | Expected result / evidence |
|---|---|
| First connection / wrong account | Browser consent; explicit account identity and scopes; no credentials in chat/logs; do not silently choose another account |
| Expired, revoked or removed account | Mark unavailable; keep prepared work; request reconnect; verify account again before continuing |
| One read spanning several pages | Bounded pagination with source IDs and timestamps; do not describe a truncated page as the full inbox |
| Duplicate webhook, message or batch click | Same source/action identity cannot produce duplicate work or sends |
| Rate limit or temporary failure | Bounded read retry honoring provider policy; visible waiting state; no blind replay of uncertain writes |
| Partial batch success | Retain successful rows, show failed/held rows, retry only eligible failures |
| New reply or changed source while reviewing | Invalidate stale proposed actions; re-read the relevant version before approval/execution |
| Shared names, multiple properties, ambiguous addresses | Request one targeted match decision; no cross-property facts or recipients |
| Missing, corrupt or large attachment | Useful partial output; attachment-specific error; bounded size/type handling |
| Malicious instructions inside email/documents | Treat content as source data, never permission to execute tools, reveal secrets or alter recipients |
| Nested Composio batch with one write | Classify every nested operation at the authoritative boundary; exact account/action approval before transport |
| Restart or lost response during execution | Durable operation ID and reconciliation; unknown outcome stays unknown until provider state confirms it |
| Disconnect during an active session | Remove capabilities/rotate worker session; no reuse of an old account credential |
| Honest user-facing status | Distinguish connected, reading, partial, ready for review, held and confirmed complete |

## Architecture boundary before live office work

RealBud currently passes the Connect MCP directly to Hermes. Tool availability is not an authorization policy. Inspect the actual nested operations in `COMPOSIO_MULTI_EXECUTE_TOOL`; do not grant broad remote workbench/bash access on the assumption it is read-only. A reviewed plan and a system prompt are not an authoritative write boundary.

For an application, evaluate account-bound Composio sessions and explicitly allowed tools, or a RealBud-owned broker enforcing equivalent controls. Preserve Hermes as an independently managed worker. Keep approvals bound to the exact action, source version, account and recipient. Do not migrate endpoints or grant scopes just to make a connectivity check pass.

Other unclosed items: authorization URL extraction still uses a permissive response search; disconnect cleanup has no durable partial-success receipt; exact real-service error envelopes and multi-account semantics need provider fixtures and authorized live checks.

## Reproduction and references

- Focused regressions: `fnm exec --using=24 pnpm exec vitest run server/composio.test.ts server/connection-intent.test.ts server/index.test.ts server/drivers/acp/acp.test.ts server/product-mode.test.ts`
- Real worker / local MCP: `fnm exec --using=24 node --experimental-strip-types scripts/qa-connected-apps.mjs`
- Permission-boundary negative control: append `--probe-write-gate`. The fixture's write-capable tool is inert; the test denies all permission prompts and fails if the call reaches the fixture or no gate is observed. No customer system can be changed by this endpoint.
- Type checks: `fnm exec --using=24 pnpm typecheck`
- Logs: `outputs/pm-integrations-2026-09-06/`. Canary uses disposable RealBud data and a synthetic credential; fixture requests contain no customer content.
- [Composio Connect documentation](https://docs.composio.dev/docs/composio-connect): Connect meta-tools, OAuth flow and application integration guidance.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): structured content, tool errors and tool annotations.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): JSON and SSE transport behavior.

Live office tests require the Connected apps key configured through You and an authorized test account. Do not paste credentials into Ask or substitute unrelated Codex app connections for RealBud's connection proof.
