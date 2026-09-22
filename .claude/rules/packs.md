---
paths:
  - "pack/**"
  - "server/customer-pack*.ts"
  - "server/office-core-pack.ts"
  - "shared/agency-workflow-packs.ts"
---

# pack/ conventions

- `pack/property/` is the pinned headless Hermes profile. `config.yaml` is locked policy (`approvals.mode: manual`, `cron_mode: deny`); `SOUL.md` carries product rules (draft only, no notices or trust movement, no invented legal clocks). Treat both as policy, not prose. `distribution.yaml` declares the Hermes floor and the owned file set.
- Published packs are versioned JSON with a fixed envelope (`format: realbud-customer-pack`, `version: 1`, `revision`, `dependencies.runtime: hermes-property`, `schedules: off`); importers reject anything else. Never hand-edit `realbud-office-core-v1.json` or `realbud-austin-office-v1.json`: an installed revision is immutable and a digest mismatch is a conflict. `austin-office` is generated from `server/customer-pack-definition.ts`; changing content means a new reviewed revision. `office-core` is loaded verbatim from disk, never re-derived from an installation.
- Plan IDs are namespaced per pack (`wf-office-core-*`, `wf-austin-accounts-*`) and the agency selects a pack explicitly (`shared/agency-workflow-packs.ts`); titles, first-installed order or model replies never bind a role. Native instruction skills install under `realbud-<packId>-<skillId>` (≤ 64 chars). Adding or changing office-core must leave Austin bytes unchanged.
- Validation rejects credentials, credential-shaped strings and machine paths (`/Users/`, `C:\`) anywhere in a pack and caps it at 500 KB. Vendored upstream skills are byte-for-byte upstream; an edit must update `support/provenance.json`. `austin-phase-1` fixtures (Brisbane timezone, sample CSV) are test inputs, not accepted customer settings.
