# Reservation review — 23 September 2026

This is analysis of preserved live QA receipts and current source, not a review of an accepted customer plan.

The largest observed hold was **A$0.524948**. The six completed requests together used **A$0.000908 at the fictional QA rate**; this is not the actual supplier bill. At the A$0.60 QA cap, only **A$0.075052** of settled usage can accumulate before another request requiring that largest hold is refused. Two such simultaneous holds need A$1.049896 even before existing usage.

Modelvia reserves the declared full provider bound because it must enforce a financial upper limit. It checks monthly exposure before concurrency, so a second request under the A$0.60 fixture can return a monthly-limit error instead of a busy error. The new app copy explains reserved capacity separately from a busy request. No financial fence was weakened.

For comparison only, the same hold occupies 52.4948% of an A$1 cap, 5.24948% of A$10, and 0.524948% of A$100. RealBud copies its configured tenant caps to each installation project; there is no universal real-customer default established by this review. The local QA script's A$10/A$1 settings are fictional fixture values.

An operational reduction requires a smaller **enforced** context bound supported by the admitted route, with provider conformance tests. Counting the prompt locally or assuming typical usage would not safely reduce the reservation. Changing real customer limits requires their intended account/terms; this review makes no such change.

Evidence: `reservation-analysis.json`; prior `outputs/modelvia-live-2026-09-23/{receipt,stream-followup}.json`; Modelvia candidate `managed-gateway/ledger.ts:258` and `accounts.ts:145`; RealBud `managed-gateway/provisioning.ts:211`.
