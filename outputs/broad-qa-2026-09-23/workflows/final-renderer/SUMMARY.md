# Final rebuilt-renderer workflow rerun

**Five scripts pass: 49 workflow assertion groups + 16 second-office contract checks.** PostgreSQL suites now total [15 files /127 unique passes](../company-expanded/SUMMARY.md), no failures or skips in those selected suites.

| Script | Result | Evidence |
|---|---:|---|
| Bank original bytes and review/history errors | 13 groups pass | `bank-bytes/result.json` |
| Bank amendments and actual restart | 7 groups pass | `bank-amendments/receipt.json` |
| Source bills, duplicates, draft/retry recovery and calendar | 25 groups pass | `source-bills/receipt.json` |
| Morning priorities and follow-ups | 4 groups pass | `morning-mail/receipt.json` |
| Two disposable fresh homes | 16 checks pass | `second-office-contract.log` |

The five QA scripts now match current source behavior: scoped durable onboarding fixture state replaces browser-local flags; bill manual collection asserts one extra scan after the automatic history baseline; malformed morning requests must return exact400/message with no new run. The bank amendment harness accepts installed Chrome explicitly. Shared helper validates scope, exact revision advancement and persisted final state. Node syntax and diff whitespace checks pass. Historical failing receipts and the output-only probe remain in the parent folder.

Proof: current source HTTP service with the root's final rebuilt renderer, deterministic synthetic worker/connector, disposable headless Chrome. All four rendered scripts report zero JavaScript errors. Bank correction after restart (desktop) and morning priorities (390px) were visually inspected.

Limits: scoped onboarding was seeded, not manually walked through; the mail-history coverage group composes production service seams in process; no live bank browsing/download, Modelvia, Gmail OAuth, REI upload, native installed-device, Windows, cross-device LAN or installed backup/restore proof. Local source backup/restore integration is covered by the expanded PostgreSQL packet. No customer data/accounts or external calls. All owned fixture processes were cleaned up before performance testing.
