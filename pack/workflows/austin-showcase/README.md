# Austin showcase seed (synthetic)

This folder holds one fictional, Austin-shaped office for demos and rehearsal. It is not customer data and not a workflow pack, and RealBud never loads it on its own.

- `fixtures/seed.json` contains:
  - the office and 6 SYN-P properties, with tenants, owners and REI tenant references
  - the REI ledger stub
  - the mailbox: W3 morning mail, W2 invoices (including a forwarded copy and a corrected version), and W4 maintenance invoices with a repeat supplier
  - Redbark-shaped bank rows that pay those references
  - Sherry's rules and the scripted rule change
- `fixtures/supplier-directory.csv` is the W4 supplier list.
- `fixtures/inspection-history.csv` is the W5 history. Its columns are those of `/api/inspections/history/import`.
- `demo-worker.mjs` is the deterministic stand-in for Bud's model. It covers one-shot workflow answers and a scripted Ask peer for the rule change.

Use:
- `scripts/seed-austin-demo.mjs` runs the presenter's demo host.
- `scripts/qa-austin-showcase.mjs` runs the rehearsal.
- The talk track is in `outputs/austin-showcase-2026-10-05/DEMO-SCRIPT.md`.
