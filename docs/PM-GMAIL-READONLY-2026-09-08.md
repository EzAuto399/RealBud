# Gmail read-only setup and workflow — 8 September 2026

This continues the [connected-tools walkthrough](PM-CONNECTED-TOOLS-2026-09-08.md). The consumer connection successfully exposed live Composio tools, but its Google consent requested mailbox write and permanent-delete access. The new optional developer-project connection requests Gmail read-only access and exposes a bounded reading workflow to Hermes/Bud.

## User journey

1. In **You → Connected apps → Optional: Gmail read-only setup**, the administrator enters a private project API key and the Gmail auth config ID. The server verifies that they belong to an enabled Gmail OAuth configuration whose visible scopes contain `gmail.readonly` and only basic sign-in scopes. Invalid, hidden or broader permissions leave the previous settings intact.
2. Saving does not change the connection Bud uses. **Use Gmail read-only** explicitly selects the verified project connection. The previous consumer key remains available through **Use Connected apps**.
3. **Connect Gmail** in Ask creates a provider sign-in link. RealBud owns the connection identity and persists the exact account and pending link before opening consent. The Google consent screen still needs inspection; a requested-scope snapshot is not proof of the actual grant.
4. **Check access** reports only the bound account. Pending consent stays disconnected without a false tool error. Another active account cannot enable preparation. Changes and stale observations invalidate access.
5. **Prepare email follow-ups** stages a task without replacing the PM's existing draft. Bud can read the selected mailbox through three tools, review at most ten threads within seven days, and prepare courtesy drafts in Ask. Each reading call retains RealBud's approval and durable outcome receipt.

Uncertain settings responses hold app actions across Settings/Ask navigation until **Refresh saved settings** confirms the server's actual configuration. No settings mutation retries itself. The new setup controls have 44-pixel minimum targets; browser checks cover 390- and 1,440-pixel widths.

If app settings change during a connection check, a queued instruction is persistently paused before the new settings are saved. Late callbacks and restart cannot run it against different access. **Edit queued** restores it for explicit review and sending; the draft survives an uncertain queue-removal response.

## Authority and execution

- The private project key stays in the RealBud server. Hermes receives a local authenticated MCP descriptor. Neither the project key nor the consumer key is placed in its tool descriptor, Ask instruction or inherited environment.
- The server accepts only `GMAIL_GET_PROFILE`, `GMAIL_LIST_THREADS` and `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`. Bud cannot supply a different account, search range, result limit, tool version or provider endpoint.
- A thread must originate in that turn's bounded list before Bud can fetch it. Responses omit attachment contents, limit body size and identify truncation. Empty, revoked, malformed, oversized and unavailable responses fail or report an empty result without invented data.
- The broker accepts Hermes's MCP protocol metadata while preserving strict tool argument validation. Write tools, raw proxy execution, arbitrary remote workbench commands and unknown tool envelopes cannot enter the read-only adapter.
- Reads require review of the exact call and display the bound account plus the ten-thread/seven-day limit. Duplicate RPCs share one outcome within a session. Cancellation, timeout and uncertain outcomes do not trigger automatic replay.
- Ask task and approval mutations require the current RealBud session; the connection-intent shortcut cannot bypass that gate.
- An OAuth creation intent is saved before its provider request. A lost response retains an unknown-outcome hold through restart. An explicit Connect can reconcile a unique account without creating another. A missing original consent URL, no matching account or multiple possible accounts requires resolution in Composio. There is no automatic reset. Fixed recovery messages preserve this distinction; general worker errors no longer promise that nothing changed after earlier tool activity.

## Provider preparation

The existing Composio organization now contains a separate **RealBud** project and a saved **RealBud Gmail read-only** auth config (`ac_n6tdkDvLqXdb`). Its saved managed-OAuth scopes were checked in the provider's own UI:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

The provider execution allowlist was saved with only the same three reading tools. The configuration has zero connected accounts. Creating this blueprint did not grant mailbox access.

A scoped project key named **RealBud Gmail read-only review** is prepared in the provider form, awaiting authorization to create and save it. The selected API permissions are Tools read, Auth configs read, Connected accounts read/write, and Tool execution write. Composio classifies tool invocation as an API write even for a Gmail read. Proxy execution, auth-config writes, sessions, triggers, webhooks and other permission areas are unselected. Connection-management permission is required to create the OAuth link; it is distinct from Gmail mailbox write permission. [Composio permission definitions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).

## Evidence and remaining gates

Focused adapter, real-server HTTP, broker, ACP, session and browser checks exercise isolated fixtures. They do not establish actual Gmail response compatibility or consent. Test logs and browser evidence are in [this continuation's output directory](../outputs/pm-gmail-readonly-2026-09-08/) and [HTTP setup checks](../outputs/pm-gmail-setup-api-2026-09-08/).

The final [actual-Hermes canary](../outputs/pm-gmail-readonly-canary-2026-09-08/real-hermes-run-3/result.json) passed in 47 seconds against frozen source and a fictional Gmail REST provider. Hermes completed four approved reads using all three fixed tools, one bound account and the ten-thread/seven-day limit. The resulting [drafts](../outputs/pm-gmail-readonly-canary-2026-09-08/real-hermes-run-3/draft.md) reproduce unpredictable source-only references, group the fictional property follow-ups and omit attachment/old-message contents. All four operation receipts succeeded. The run made zero live Composio calls, zero live mailbox reads and zero external writes. Earlier failed attempts remain preserved: they exposed the MCP metadata incompatibility and an in-flight source change rather than being counted as successful runs.

The final [real-server HTTP suite](../outputs/pm-gmail-setup-api-2026-09-08/frozen-source-api-tests.log) passed 26 tests, including session rejection, verified setup, settings races, consent-link reuse, unsafe/expired links, unknown-outcome reconciliation and queued-work recovery through restart. [Responsive browser evidence](../outputs/pm-gmail-readonly-2026-09-08/browser-results.json) records the nine journey checks and control measurements.

The frozen-source [full suite](../outputs/pm-gmail-readonly-2026-09-08/full-tests-frozen.log) passed **1,639 tests across 157 files**, with eight skipped. Earlier full runs are retained; they caught legacy test clients without session headers and copy assertions collected while recovery messages were being updated. The final run uses the corrected clients and final expectations.

[Production preparation](../outputs/pm-gmail-readonly-2026-09-08/package-prepare.log), [arm64 packaging](../outputs/pm-gmail-readonly-2026-09-08/package.log), [strict signature verification](../outputs/pm-gmail-readonly-2026-09-08/package-codesign.log), [491-file compiled-resource parity](../outputs/pm-gmail-readonly-2026-09-08/package-parity.json) and [isolated native smoke](../outputs/pm-gmail-readonly-2026-09-08/package-smoke.log) passed. The candidate is Developer ID signed; notarization was skipped. The installed app was not replaced. Follow the [review launch instructions](../outputs/pm-gmail-readonly-2026-09-08/START-HERE.md).

The actual persistent browser review was refreshed with this build. Bud answered its private readiness check, the saved consumer key still discovered seven live Composio tools, and Gmail/Outlook remained unconnected with email preparation disabled. The new private project field is empty; the prepared auth-config ID is entered but not saved. This is live setup/metadata verification, not a live Gmail read.

When free disk space fell below 200 MB, four inactive generated review bundles were checked for open files and removed under the requested obsolete-version cleanup. The newest previous candidate, installed app, credentials, data and evidence logs were retained. The [cleanup receipt](../outputs/pm-gmail-readonly-2026-09-08/obsolete-bundle-cleanup.json) records the exact paths. About 1.5 GiB became available before building the replacement; final free space also reflects other laptop activity.

Live proof still requires creating the scoped credential, saving and verifying it through RealBud, inspecting and approving the new Google consent screen, then completing an approved mailbox read and reviewing the resulting drafts. No live mailbox read or email send has occurred in this continuation. The old broad consumer consent remains unapproved.

This is one attended email task. Recurring email scheduling, large-book throughput, real-phone handoff and live-office acceptance are separate work and are not proved by these tests. Gmail read-only prevents mailbox changes; it does not make generated drafts automatically correct. Sources and drafts must remain reviewable.
