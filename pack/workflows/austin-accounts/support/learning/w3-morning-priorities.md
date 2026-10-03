# W3: morning priorities (what we learned before the first live run)

Notes for Bud. Facts from fictional QA runs on 2 October 2026 (45 fictional conversations, a fictional mailbox connector, a deterministic stand-in for the model). No real mail was read and nothing was sent. These notes grant nothing.

## What happens, step by step

| Step | What it needs | Who acts |
|---|---|---|
| 1. Setup | The office's Gmail account connected and selected, the morning plan reviewed, the reviewer named, workdays, start time and timezone. | Office, once |
| 2. History check | When the account is checked, up to 90 days of approved history are read in 30-day windows, each window saved as it finishes. A repeat check does not re-read finished windows. | RealBud |
| 3. Collect | The reviewed inbox and sent mail since the last run. Original messages are kept. | RealBud |
| 4. Prepare | Conversations in batches of 20, at most five batches (45 conversations ran as 20, 20 and 5). | RealBud |
| 5. Morning list | Urgent decisions, unanswered requests, waiting on others, and for-reference items, each linked to its source. | RealBud |
| 6. Review | The person marks items done, waiting or reviewed. Those choices are kept when mail is collected again. | The person |

## Things that go wrong, and what RealBud does

- Same mail again tomorrow: no new model work; the result is marked quiet.
- A staff decision then a rescan: the decision stays.
- Settings changed after approval: the clock pauses until the plan is reviewed again.
- Mail access revoked or the source not reviewed: collection is refused.
- An edit made from an old copy of an item: refused as stale.
- Attachments: their contents are not read for W3; the item says so and stays for the person.
- 08:00 is when the work starts, not when it is guaranteed finished. The computer and RealBud must be running.

Known gaps (from the 2 October gap plan, not re-tested here): a large unresolved backlog can crowd out new mail; a new reply to an already-reviewed item may keep its old, low priority.

## Decisions Kevin must make

1. Which mailbox (personal or shared) and whether sent mail is included.
2. Who reviews the morning list.
3. Examples of urgent, action, waiting and for-reference mail for this office.
4. Follow-up interval for unanswered requests.
5. Workdays, start time and timezone; whether the brief must be ready by a time (then start earlier).
6. Whether desktop notifications are allowed on the office computer.

## Preflight checklist for the first live run

1. Office's own data directory; Gmail account selected and checked; history check finished with nothing left unchecked.
2. Morning plan reviewed for the current setup.
3. Run W3 once by hand with the clock paused. Spot-check ten items against Gmail.
4. Mark a few items; run again; confirm the marks stayed and no extra model work ran.
5. No REI login and no CSV are needed for W3.
6. Note how long the run took; set the start time early enough for the ready-by time.
7. Turn the clock on only after the owner approves the time.
