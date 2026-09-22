# Independent final portal identity review — 2026-09-22

**Initial source review found no remaining concrete finding, but missed two integration defects subsequently demonstrated by actual HTTP execution: SDK authority mutation and streamed admin child content despite a denied layout. Both findings are fixed and separately reviewed below.** Scope is the stable portal identity foundation, not remote approval enablement, platform release, or live provider acceptance. Exact reviewed source hashes are in `review-source-fingerprints.json`; later source changes require their own assessment.

## Findings resolved during review

- Seven server-rendered account pages initially still mapped `session.email` directly to billing data despite the new v2 identity API gate. All now resolve `getSessionAccount` before data access, and admin layout invokes `requireOperator`. Valid v2 cookies cannot fall through to legacy email authority after current identity denial. Coarse middleware remains only a signed-cookie admission gate.
- The role parser initially coerced values through `String`, accepting a JSON array as a role. It now validates the exact string enum; malformed array/object responses are covered.
- The successful callback now requires supported OTP type, immutable provider identity and confirmed email metadata. Failed binding clears prior cookie and creates no legacy fallback. A specifically unprovisioned, explicitly allowlisted operator keeps its prior legacy behavior; this does not obtain person/workspace permission.
- A BEFORE INSERT registry write would have created permanent unused tombstones on each idempotent `ON CONFLICT UPDATE` provision. Registration now occurs AFTER a real INSERT. The real PostgreSQL test asserts unchanged registry count on no-op upsert.
- SQL admission now matches account/company boundary whitespace and UTF16 length limits before first binding can commit, including valid/nonvalid astral cases. Malformed legacy rows reject login with no saved binding.
- RPCs explicitly require READ COMMITTED. Higher-isolation stale snapshots are rejected, including an actual held repeatable-read transaction spanning account revocation. This documents and preserves the current PostgREST transaction contract.

## Authority and recovery checks read

Immutable provider/account binding; permanent subject incarnation/tombstones; account-email ambiguity including disabled duplicates; direct-service account mutation epochs; company/email/role/disabled A→B→A; same-provider exact replay; competing providers and one provider/two accounts; observed advisory-lock contention; rollback of first binding; delete/recreate; no old subject reuse; strict v2 cookie schema; current deployment issuer; service-only RPC permissions; no memoized current person lookup; bounded no-store errors; and explicit separation from remote execution authority.

The global advisory lock serializes short identity/account-write transactions across agencies. This is a deliberate current consistency tradeoff, not a claim of large-scale load testing. Future remote approval/effect transactions must recheck stable identity and current epoch at their own authoritative commit/claim boundary; a prior successful HTTP gate is insufficient.

## Verification actually performed by reviewer

- Read current session/callback/auth, SQL migration, account/admin wiring, new identity-only endpoint, bounded sign-in UI, and root's actual Next/PostgreSQL/browser QA harness.
- Independently ran the focused session/person Node tests: **9 passed, 0 failed**, recorded in `review-auth-tests.log`.
- Reviewed SQL owner's real PostgreSQL adversarial harness and reported 110-assertion run evidence; no duplicate full SQL run was performed by this reviewer. Owner/root final receipts remain authoritative for their executions.
- Root's browser/HTTP run and screenshots must be evaluated in their own receipt; source review alone does not claim those executed successfully.

## Grok disposition

Requested one new isolated `grok-4.7` / `xhigh` ACP session. The CLI returned `grok-4.6` / `xhigh`, so the harness refused before sending any prompt. **No Grok review was produced and no retry was issued.** Owned process was reaped, owned descendants absent, temporary home removed and global config unchanged. See `grok-review-disposition.md` and matching JSON evidence.

## Remaining scope boundaries

Legacy email sessions deliberately retain existing billing/protocol-v1 behavior and cannot enter the person gate. Real provider OTP/email delivery, deployed SQL, live customer acceptance, attended approver enrollment, disclosure/review/decision transactions and shared-department execution are not established by this identity feature. No remote approval capability is enabled by successful sign-in or by the identity-only endpoint.

## Supplemental review after actual callback failure

Root's real built Next callback hit `identity-unavailable` because the installed Supabase SDK's successful `verifyOtp` stored the user's access token in the same client's memory. `persistSession:false` prevents persistent storage, not this in-memory authority change. The subsequent service-only binding RPC therefore used user authority and was correctly denied; no binding was saved. Evidence: `callback-auth-diagnosis.json`. **The original source review missed this behavior**, and its earlier no-findings statement was not proof that callback integration worked.

The callback now uses the OTP client only for authentication and constructs a fresh `getSupabaseAdmin()` client for the service-only binding RPC. The existing factory creates a fresh SDK instance on every call with persistence and refresh disabled; it is not a singleton. Verified immutable user data remains the input, and failure still clears the cookie without authority fallback.

The added regression exercises the actual installed SDK with fictional transport: reused OTP client sends user authority and is denied; a new admin client sends service authority and succeeds. Reviewer independently ran **only this new test: 1 passed, 0 failed**, recorded in `review-sdk-regression.log`. The prior independent 9 tests were not rerun. Supplemental exact source hashes are in `review-supplemental-source-fingerprints.json`; earlier hashes remain historical. No new concrete source issue found in this fix. Root's rebuilt actual Next/HTTP/browser run is still the necessary end-to-end verification and is not inferred from this isolated SDK test.

## Final supplement: streamed admin child content and observed HTTP result

The rebuilt callback exposed a second integration defect: a stale bound operator was refused by the admin layout, but Next rendered child page content into the streamed response/RSC data anyway. **The prior source review incorrectly treated the layout gate as sufficient for admin page confidentiality.** Root preserved the failing run in `http-ui-before-admin-page-guards/` and its log.

All three actual admin pages (`/admin`, `/admin/offices`, `/admin/margin`) now independently await `requireOperator()` and invoke `notFound()` on denial before calling `operatorReady` or constructing any protected content/form. The layout guard remains supplementary. Existing admin POST routes independently call `requireOperator` before body handling or mutation. Read-only review found no remaining concrete guard bypass in these routes.

The updated QA checks the **raw full response body** of each stale admin route for its known protected child-content canary, not just status or visible DOM; this covers the original streamed-content failure. It also checks a stale operator POST returns 403, confirms a fresh bound operator can enter admin, and verifies the explicitly allowlisted unprovisioned operator's legacy exception cannot obtain person authority.

Reviewer inspected the final current `http-ui/receipt.json`: **ok=true, 10 check groups, cleanup=true, zero browser errors, zero off-origin requests, zero fixture authority rejections**, with migration hash `17d9df75b244cb13e356ccfff3c27591aaf7a38aec0f0c4ce003d671cb79904d`. The receipt proves the actual built Next handlers/pages and disposable PostgreSQL path with fictional provider responses; it does not prove live Supabase/email delivery or deployed service behavior. SQL receipt records **110 actual PostgreSQL assertions passed** at the same migration hash. No full tests or application builds were rerun by this reviewer. Final reviewed files and observed receipts are fingerprinted in `review-final-source-fingerprints.json`; earlier hashes and missed-finding history are retained.
