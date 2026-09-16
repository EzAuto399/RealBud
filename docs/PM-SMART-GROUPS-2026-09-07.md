# PM portfolio grouping — 7 September 2026

Properties now has All properties, Buildings, Suburbs and Portals views. A building with 60 units occupies one overview entry. Opening it shows its properties using the existing cards/table preference, with property editing, group tasks and group batch preparation available from that context. Grouping preference survives reload; row limits apply to group overviews as well as the property list.

## Engineering scope

The change affects DeskBook, DeskPage task scopes, BatchWorkspace draft entry, workspace preferences, address grouping and the display-only book snapshot. It uses the existing tokens, controls, editors, pagination, batch service and authenticated Desk API. It adds no dependency and no persisted server schema migration. Existing user work was preserved.

Groups are derived navigation, not property-record merges. Explicit unit prefixes, case, whitespace and common full street suffixes are normalized; locality remains part of building identity. Addresses without an identified locality remain separate building entries. Lot identifiers are preserved because a lot is not necessarily a unit in the same building. This is conservative address matching, not geocoding or a cadastral building database. Unusual formats can remain separate.

Portal groups use exact saved property-to-recipe-version bindings. The server projects only local property IDs, sanitized HTTP(S) origins and an unresolved flag. It excludes archived properties, URL credentials, query strings, remote property/account IDs, recipe steps and action capabilities. Missing/unpublished recipes and invalid URLs remain visibly unresolved. Notification preference is never treated as a binding. Multiple portal origins form a distinct combination group so each property is counted once. The view does not establish that a connection works or create a portal link.

Search runs across the whole book before grouping and pagination. Counts and weekly-rent totals represent matching properties across every page. A removed group shows an empty state rather than silently broadening the scope. Group task handoff uses exact property IDs and provides a clear return to all properties. Navigation captures membership at that moment; it does not silently add newly imported properties to an existing task or batch scope.

Preparing group work opens batch setup without starting a job. Existing draft instructions and selections stay intact; selections outside the group are shown. The explicit “Use this group only” action replaces the selection, bounded by the existing 500-property batch limit. The normal server checks still enforce property validity, source revision, idempotency and permissions. Missing/removed properties are handled by existing server validation. Returning to Batch work restores saved progress; only an explicit group-work handoff opens a new draft. Active server jobs and their history are not cancelled by that navigation.

## Verification

- TypeScript and production build passed. Existing Vite chunk-size warnings remain.
- 168 tests passed across grouping, preference validation, safe portal projection, Desk, task queue, HTTP and durable batches.
- 30 browser checks passed on a separate synthetic 306-property book with a 60-unit building, a 40-unit building and 200 additional addresses, plus the six original sample properties.
- Browser coverage includes bounded group/property pages, full-book search, group totals, property editor access, scoped task navigation through the last page, clearing scope, draft preservation, explicit full-group selection, units beyond the first page, portal presentation, remembered grouping and empty search recovery.
- Saved batch progress restoration was checked using a mocked read-only progress response; no worker job was started by this browser run.
- Page overflow checks passed at 1200, 900 and 640 pixels; no browser runtime errors occurred. Wide screenshots were visually inspected.
- The touched-file whitespace check passed. An existing whitespace warning in the unrelated telegram-channel test was left unchanged.

Evidence: `outputs/pm-smart-groups-2026-09-07/` contains screenshots, build/test logs, browser checks, result counts, before copies and the scoped diff. Test servers used isolated data under `/tmp/realbud-smart-groups-20260907`, API port 18981 and UI port 5201.

The installed native app was not replaced. Live portal connection behavior, real-office address quality and live-model throughput remain separate proof gates. This change adds portfolio navigation to the existing durable preparation flow; it does not expand Bud's authority or imply operation while RealBud is closed.
