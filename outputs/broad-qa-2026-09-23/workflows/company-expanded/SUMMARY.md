# Expanded local company and department QA

**12 additional files /111 tests passed,0 failed,0 skipped in42.16 seconds.** Combined with the earlier disjoint3 files/16 cases: **15 files /127 unique PostgreSQL cases passed**. Assertion identities were compared to verify no overlap.

Covered: office setup and separate-client joining; one-use invitations and independent sign-in; leave/rejoin another office without changing private work; host/client restart and lost-host recovery; private notes (including owner denial); read/write/removed department authority; member offboarding; stale claims and concurrent revisions; explicit scoped execution and lost replies; backup integrity, inert restore, authority rotation and owner-reviewed cutover.

Evidence: `vitest-results.json`, `vitest.log`, `runner.json`, `selection.json`, `summary.json`. The normal company-host harness creates a unique fixture under the older evidence directory. Its exact path and stopped:true receipt are mirrored in `historical-path-receipts.json`; no previous fixture was overwritten.

Only the verified REALBUD_TEST_POSTGRES describe.runIf suites were selected. Five URL-only PostgreSQL suites (44 cases), native Hermes suites (51 cases) and native Windows cases (30) from the original skip inventory were excluded. These remain unproven by this packet.

Execution used Node24.19, PostgreSQL16.15, LC_ALL=C/LANG=C, an allowlisted environment with no provider/account settings, a disposable HOME, serial files, private databases and localhost HTTP/TLS. No paid/external calls, customer data, package/build or product edits. All owned fixture processes were stopped before notifying root. This is source integration evidence, not installed-device, physical LAN, Windows or customer acceptance.
