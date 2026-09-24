# Independent skill-history implementation review

Owner: independent reviewer. Production edits prohibited. Tests and evidence remain in this directory; synthetic local fixtures only, no network/provider/customer data. Schema/source review starts after backend handoff. One Grok 4.7 xhigh call will review the concrete implementation packet, not the prior abstract design.

Target evidence:
1. An already-near-2MB legacy journal can durably record compact archive intent without relaxing the normal-data bound; a stopped/failed write cannot prune inline history.
2. First archival sets an explicit format gate that old v1 admission rejects. New v1 compatibility remains intact and future writes preserve the gate.
3. Append/revert retains the exact archive root; same numeric revisions from removed/reintroduced skills cannot bypass preview binding; rollback retains the correct historical root.
4. Shared immutable batches referenced by current/recent/archived configurations remain valid once per identity; missing, foreign, detached, tampered or cyclic references fail. A retired skill's only remaining root survives backup.
5. Scope changes at asynchronous boundaries and staged-file failures preserve prior bytes and hold exact recovery. Lost replies/restart retries do not create another batch, change the active instruction or alter plan authority.

Existing fixtures available: customer-pack-archive.review.test.ts private-json fault hooks, customer-packs.test.ts supplied recipe dependencies, private-backup-pack-upgrade.test.ts real encrypted v1/v2 capture/restore. New tests will focus on independently observed boundaries rather than replicate the implementers' matrix.
