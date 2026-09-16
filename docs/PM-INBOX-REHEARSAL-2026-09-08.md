# PM inbox rehearsal — 8 September 2026

Manual browser rehearsal of RealBud with the installed Hermes agent and its existing model connection. Gmail REST responses were fictional, isolated from live Composio and real mail. Scheduled work was paused. No email was sent, mailbox changed, contractor booked or payment made.

## What was exercised

- Onboarding, real private readiness ping, connected-app discovery, editable account scope and a PM morning review.
- Ten email threads: urgent water near a light, related building dampness, contractor quote and duplicate, rent dispute, owner update, locksmith invoice, malicious bank-change instructions, inspection rescheduling and newsletter noise.
- Twelve individually approved reads: one profile, one list, ten thread reads. Source references and amounts were reproduced; attachments and older messages were explicitly excluded. The malicious payment instructions were treated as untrusted content.
- Draft refinement, persisted conversation after a backend restart, queued follow-up surviving a page reload and dispatching once.
- A denied profile read, empty inbox, one HTTP 503, revoked account and restored access. Stopping a pending read settled Bud idle; a reload did not resume or execute the read. These produced distinct outcomes; old messages were not reported as fresh results.

## Bugs found and fixed in source

1. The watchdog compared shortened tool display names. It stopped five different thread reads as a repeated loop. ACP now supplies a stable argument-aware SHA-256 identity; identical loops still stop, and the overall tool/time limits remain. The next browser run completed all ten reads.
2. A draft edit mentioning bank details and “Do not call tools” was routed into portal-job creation. Negated instructions no longer supply a positive portal action/target. The exact same edit then went through Hermes in Ask.
3. The bundled law sheet supplied broad numerical shortcuts; the original review repeated its incorrect generic ACT inspection timing. Replaced it with a current-source verification guide. Known legacy content is upgraded atomically, preserving appended office/drift notes and independently authored files. The active rehearsal workroom migrated and Bud subsequently left the email property's jurisdiction and notice requirement unverified.
4. The backend cleared a dispatched queued follow-up, but the UI merged a snapshot with an omitted queue field and retained the badge. Complete server snapshots now explicitly clear that optional field. The next queued edit started once and the badge disappeared.

The ACT Government distinguishes standard inspections from other entry reasons; its [during-a-tenancy guidance](https://www.act.gov.au/housing-planning-and-property/renting/during-a-tenancy#Inspections) contradicts the old generic shortcut. This rehearsal is not statutory advice or approval to enter a property.

## Environment findings

The laptop twice ran out of writable disk space. Onboarding retained its form; the private readiness screen exposed a raw filesystem error. An inactive superseded RealBud bundle and two inactive older Playwright browser caches were removed under the existing cleanup request. The newest packaged candidate, installed app, credentials and office data were retained. Subsequent swap release restored several GB of free space. The browser automation session also had to be reconnected. These are reliability findings, not successful setup runs.

## Validation and evidence

- Full suite: **1,645 passed, 8 skipped, 158 test files**.
- Focused watchdog/ACP: 46 passed; API/broker/read-only: 216 passed; routing/reference migration: 40 passed.
- Typecheck and production web build passed; build retains a large-chunk warning.
- Final service receipts: 13 succeeded, 1 unknown outcome after the simulated HTTP 503, 2 denied/stopped, zero unfinished. The harness export initially held an expired session after the deliberate backend restart; a fresh local session recovered all 16 receipts. The original export failure is preserved alongside its recovery receipt.
- Evidence: `outputs/pm-inbox-rehearsal-2026-09-08-run4/` (morning review, messages, UI checks, REST calls, operations, source hashes and test/build logs). Run3 preserves the original false-loop failure. Run1/run2 document harness setup limitations, not product readiness.

## Remaining limits

- This is simulated Gmail service proof with a real agent. Live OAuth, actual mailbox reads, Outlook, calendar, PMS writes and real mobile messaging were not proved by this rehearsal.
- The first owner draft used internal Desk language and needed an explicit recipient correction. It remains a draft requiring PM review.
- Twelve approval cards for ten messages are cumbersome; source IDs should become useful source links and related work needs a more compact presentation.
- The original unsafe inspection paragraph remains in the historical test transcript as failure evidence, not approved wording.
- Changes are tested in source/the rehearsal. The previously signed application candidate and installed app do not yet contain these new fixes.
