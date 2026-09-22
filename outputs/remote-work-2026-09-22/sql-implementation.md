# Protocol 2 remote work: SQL checkpoint

Migration: `website/supabase/migrations/202609220004_remote_work.sql`

Migration SHA256: `9bf243d8ffac46d376f6a396d7b0138ed76671a46638646f1bce7fa3eda7c423`

Verification: **422 assertions passed**, Node v24.19.0, PostgreSQL 16.15 (Homebrew), disposable private Unix-socket database. The exact loaded migration hashes and test source hash are in `sql-verification.json`. No deployment, provider request, or customer operation occurred.

## Authority and state

All eleven public work entry points are service-role-only SECURITY DEFINER functions with a fixed `pg_catalog,public` search path. Browser operations accept `(p_actor jsonb,p_body jsonb)` and desktop operations accept `(p_hash text,p_body jsonb)`. Internal helpers, tables, UUID reservation registry, and sequence deny direct service-role access as well as public/anon/authenticated access. RLS is enabled on every new table.

Current stable person assertions are checked inside browser RPCs; decisions and browser cancellation require authentication less than ten minutes old. Current confirmed enrollment, exact public person, descriptor revision and disclosure scope determine authority. Billing ownership alone provides no work permission. Catalog entries map one enrollment to only its eligible descriptors. Full review disclosure and decision require explicit audience membership; a requester excluded from that audience gets status only.

The established global identity advisory lock precedes company, installation, billing owner, parent, sorted enrollment and request locking. Requests and changes use ascending server sequence pagination, 32 rows per page. One immutable review and one decision slot exist per request. Review publication leaves work delivered and awaiting a decision. Approval itself does not accept work; online claim does. A claim receipt is immutable, includes original issued server time, and has a fixed maximum 60-second deadline bounded by the request/review expiry. Replay checks current authority, cancellation, state and expiry first. The same request cannot obtain another claim or replace a review.

Requests have a fixed 24-hour deadline. Observed identity/audience/revocation changes latch held state using committed `remote_work_stale` responses. Cancellation or staleness after a claim keeps accepted/running factual state with cancellation requested; acknowledgements can reconcile a run that dispatched before its running acknowledgement arrived. Such acknowledgement never mints acceptance, renews a claim or authorizes a new effect. The desktop execution guard remains responsible for effect admission and fencing locally discovered running work.

Both protocol request tables reserve a nonreusable executor UUID in one immutable registry. Insert races serialize with the same identity lock; deleting a historic request cannot free its identity. Request IDs cannot be renamed through the legacy backend's broader UPDATE grant. Existing v1 RPC and envelope semantics remain partitioned.

## Canonical representations and retention review

Wire `reviewDigest` and `templateDigest` are the shared JavaScript canonical SHA256 representations; the authenticated website route verifies those hashes before SQL admission and on full review responses. SQL checks their exact syntax, descriptor binding and immutable enrollment scope digest. SQL intentionally does not substitute JSONB text hashing for the wire canonical algorithm.

SQL stores a separate SHA256 of the JSONB full review solely to compare publication replay after content pruning. This private digest is not returned or used as provider/effect authority. Full template content has one storage location: `office_remote_work_reviews.projection`. The rest of the review metadata excludes the template. Claim/event/cancel receipts contain status and audit metadata, never full template sections.

Projection content is pruned seven days after terminal state or fixed request expiry, whichever retention boundary occurs first. Poll, account, read and explicit prune invoke the same retention logic. A pruned review returns null plus `prunedAt`; exact publication replay cannot rehydrate it. Requester/audience, descriptor, decision and receipt audit metadata remain. Poll/account do not disclose full review content.

## Meaningful verification

The suite executes both morning-review and prepare-recipe through submission, publication, reading, approve/reject, claim, running and completion. It validates outputs against the shared TypeScript contracts and covers strict malformed input, cross-company denial, absence of billing-owner fallback, audience subsets, stale provider identity, fixed deadlines, reject and claim idempotence, conflicting review/decision/claim IDs, cancellation before first upload, receipt replay, immutable request identities, and table/function permissions.

Actual held transactions are observed waiting on PostgreSQL advisory locks before release for decision contention, cancellation versus late publication, both protocol UUID collision orderings, identical claim retries, identity disable versus decision, and parent revocation versus claim replay. Rollback verifies that an uncommitted submission leaves neither a request nor a reservation. Retention tests freeze only the disposable database clock and restore its original definition, then verify content deletion and no replay rehydration. Pagination drains more than one page without duplicate IDs. Revoked accepted work can report its factual run outcome while claims remain denied.

## Remaining proof layers

SQL is locally verified and frozen at the hash above. Root-owned HTTP/SDK integration, desktop restore/encrypted backup, GUI behavior, packaged Windows/macOS operation and any live deployment are separate proof layers. Capacity limits are bounded (10,000 company requests and 128 active requests per parent), but the functional fixture is not a production load test. No additional concrete correctness defect remained from this source review.
