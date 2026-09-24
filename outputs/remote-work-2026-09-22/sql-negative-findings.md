# Observed negative findings before final verification

These are observations from this implementation's disposable PostgreSQL runs, preserved separately from the passing receipt. They are not current unresolved failures.

- The initial enrollment fixture reused a challenge hash for two people; the existing enrollment boundary correctly rejected the second with `remote_enrollment_conflict`. The fixture now creates distinct challenge hashes.
- Executing the new decision and prune functions exposed PL/pgSQL variable/column naming collisions. Variables/table aliases were disambiguated. Both functions are exercised by the final suite.
- Exact wire claim expiry exposed a submillisecond mismatch: PostgreSQL stored fractional microseconds beyond the millisecond deadline serialized to the client, and an exact-millisecond expiry test still returned the claim. Claim issuance is now truncated to milliseconds before deriving the persisted deadline. Exact expiry now denies; replay does not renew.
- Adding pagination exposed an incorrect test assumption that a later changed request must appear in the first 32 rows. The test now starts at the request's preceding sequence, while separate tests drain all pages and prove uniqueness/direction.
- Final source review found that legacy service-role UPDATE grants could rename a request ID around insert-only reservation checks. Both protocol request IDs now reject identity changes, including legacy service-role UPDATE. The final suite verifies this denial.

No live database, provider, or customer account was used. Fixture source values and account identities are fictional.
