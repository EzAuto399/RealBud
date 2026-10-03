# Real estate department case reviews

Portable pack `department-starters`, revision 1. Five short plans prepare one assigned case for human review:

| Group | Plan ID suffix | Review |
|---|---|---|
| Accounts, including administration | accounts-invoice | Invoice issue and maintenance clarification |
| Accounts, including administration | accounts-admin | Supplied message excerpts and administrative follow-ups |
| Accounts, including administration | accounts-bank | Bank or rent-reference exception |
| Property Management, including maintenance and inspections | pm-property | Property exception and owner-update draft |
| Property Management, including maintenance and inspections | pm-maintenance | Maintenance or inspection issue and Accounts clarification |

Full recipe IDs begin with `wf-department-starters-`. The single `case-review` skill is instruction text only; the portable JSON embeds the exact support text and license.

Each plan uses only the assigned case title and description. Source references and dates are claims recorded in that case, not independently retrieved or verified evidence. Missing, stale or conflicting evidence remains a named hold. Plans do not request private files, inboxes, browsers or account access.

Capabilities are analysis and drafting only, with no website origins, no schedule, at most five minutes and twelve reasoning turns. Import installs unapproved local plans. A member must still request preparation and the owner must approve the exact case, plan, instructions and assigned instance. Preparing a review does not send a message, hand off ownership, save a bill, pay, post, reconcile, book, dispatch or close a case. Human decisions and their recorded effects remain separate.

These plans are independent of the office-core and customer add-on packs. They contain no agency identities, customer records, property mappings, account bindings, private paths, credentials, approvals or active schedules.

The focused loader tests validate the existing strict CustomerPack schema, department review admission after explicit plan approval, refusal without approval, instruction integrity and byte budgets for the three Accounts or two Property Management plans. Service-level tests also verify that case-only guidance is embedded in the worker context without a support-file read, imports remain unapproved, and the instruction binding survives restart. Existing file-based pack wrapper bytes remain unchanged; mixed-capability packs continue to use their file-based wrapper.

Tests do not prove model answer quality, a live connector, a performed financial action or a completed cross-department workflow. No such execution is claimed by this pack.
