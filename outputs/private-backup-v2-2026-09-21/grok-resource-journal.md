Add durable backup resource allocations and internal cleanup/release/retire lifecycle to the existing encrypted journal, with optional legacy-compatible allocations, CAS/owner/clone-safe methods, and tests. No HTTP, no generic framework, no filesystem deletes.

- Physical deletion, fsync, and marker files stay outside this module; Codex's helper must abort/drain writers before begin/finish and must not treat a restarter `deleting` row as already gone.
- Generic update can still zero `reservedBytes` on legacy records with no `allocations`; once allocate() has run, releaseCleanedReservation is the only legal release path.
- Foreign failed/interrupted rows are not cleanup-eligible until retireForeign cancels them; held incomplete restores (including foreign ones after control.workspaceId changes) stay reserved until a later completion path.
- Allocation id uniqueness is allocate-time only, not a SQL constraint; the randomId test seam must never be bound to customer or serialized input.
- Completed records can now be pruned after release, but allocated/deleting metadata cannot, so unfinished cleanup can pin the 1000-record journal cap.
- Prepared directory layout is documented here; other role directories are not invented in this patch and must bind to the existing helper paths without storing state on the marker.