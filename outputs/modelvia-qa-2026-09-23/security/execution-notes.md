# Execution notes

All inputs and transport responses were fictional. Existing desktop tests used a disposable HOME and the gateway tests injected upstream adapters or loopback test servers. No hosted/provider request was sent. No PostgreSQL or build ran in this packet.

The first standalone-probe launch used an incorrect relative repository root and failed module loading. The second used the macOS temporary-directory alias; private profile validation correctly refused that noncanonical path. The harness was corrected to use the canonical owned fixture root and then reproduced all four issues. These were harness setup failures, not product regression fixes. The completed original negative observations remain in `failure-probes.json`; the probe deliberately asserts the old defects and is not the post-fix acceptance command.

The first new lifecycle regression run passed 56 and failed one assertion because its existing mock counted the disconnect response as a usage reply. The test now measures the expected fresh read relative to that mock count. The subsequent run passed 57. One additional POSIX-only private-directory refusal case was then added; final counts are in `lifecycle-fixed-tests.json`.
