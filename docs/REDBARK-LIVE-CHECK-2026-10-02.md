# Redbark live check — 2026-10-02

Evidence from an owner-authorised, read-only live check using an authorised bank connection. This was not an office account or a RealBud runtime test. No account identifiers, provider or account-type details, references, amounts or credentials are recorded here.

| Question | Result |
|---|---|
| Fixed date range | `from=2026-09-01&to=2026-09-30` returned only rows dated in that range, newest first. |
| Paging | `limit=2` returned a `next_page_url` with an opaque `page` token. Its host was `api.redbark.internal`, not `api.redbark.com`. Clients must reuse only the token against their configured base URL. |
| Amount sign | Signed integer minor units inside `{amount, currency}`; negative for `direction: debit`, positive for `credit`. |
| Status | Only `posted` seen with `include_pending=false`. |
| Dates | `date`/`post_date` are bare local calendar dates (user timezone). `datetime`/`post_datetime` are UTC instants, so a 17:18Z instant falls on the next local day. CSV dates must use `post_date`/`date`. |
| Optional fields | `value_date`, `extended_description`, `category`, `merchant_*` were null; `reference` was present on every row. |
| Account metadata | Live-mode metadata and a masked account-number field were present. Identifiers, provider and account-type details are omitted. |

Still open for W1: ANZ business/trust account eligibility, Redbark's written OK for the office-held arrangement (see the 2026-10-02 research), REI CSV format, and a REST-API run with the office key in RealBud.
