---
paths:
  - "pack/**"
  - "server/customer-pack*.ts"
  - "server/office-core-pack.ts"
  - "shared/agency-workflow-packs.ts"
---

# pack/ conventions

- `pack/property/` is the pinned headless Hermes profile. `config.yaml` is locked policy (`approvals.mode: manual`, `cron_mode: deny`); `SOUL.md` carries product rules (draft only, no notices or trust movement, no invented legal clocks). Treat both as policy, not prose. `distribution.yaml` declares the Hermes floor and the owned file set.
- Published packs are versioned JSON with a fixed envelope (`format: realbud-customer-pack`, `version: 1`, `revision`, `dependencies.runtime: hermes-property`, `schedules: off`); importers reject anything else. `office-core` and the Austin packs (`pack/workflows/austin-office/realbud-austin-{office,accounts,property}-v1.json`) are loaded verbatim from disk, never built in code or re-derived from an installation. Never change a published revision in place: an installed revision is immutable and a digest mismatch is a conflict (Austin digests are pinned in `server/customer-pack-definition.test.ts`); changing content means a new reviewed revision.
- Plan IDs are namespaced per pack (`wf-office-core-*`, `wf-austin-accounts-*`) and the agency selects a pack explicitly (`shared/agency-workflow-packs.ts`); titles, first-installed order or model replies never bind a role. Native instruction skills install under `realbud-<packId>-<skillId>` (≤ 64 chars). Adding or changing office-core must leave Austin bytes unchanged.
- Validation rejects credentials, credential-shaped strings and machine paths (`/Users/`, `C:\`) anywhere in a pack and caps it at 500 KB. Vendored upstream skills are byte-for-byte upstream; an edit must update `support/provenance.json`. `austin-phase-1` fixtures (Brisbane timezone, sample CSV) are test inputs, not accepted customer settings.
