# Office setup simplification — 7 September 2026

The “PMS brand” selector stored a software label. It did not connect a PMS, select a CSV parser, configure row matching or grant portal access. The surrounding eight-field checklist originated in pilot preparation. The prior disclosure opened whenever any checklist item was filled; a sample jurisdiction alone was enough to expose all the technical fields.

## What belongs in the normal journey

| Information | Actual purpose | Presentation |
| --- | --- | --- |
| Agency name | Names the office/book | Main form |
| Property states and territories | Agency jurisdiction context | Main form, plain-language label |
| Software and office contact | Office reference / pilot metadata | Optional, collapsed |
| Export contact, frequency and usual identity column | CSV handover / pilot metadata; does not configure imports or scheduling | Optional, collapsed |
| Computer OS and test account label | Assisted pilot setup metadata | Technical disclosure, collapsed |

The underlying metadata remains backward-compatible and editable. No records were deleted. Legacy pilot-contract helper checks remain intact; the normal UI no longer presents them as eight required steps. The software selector says “Choose later / not sure” and explains that it does not connect or import anything. No profile name is silently saved as the responsible PM; a profile name can appear as a placeholder suggestion.

## Save and recovery behavior

The form overlays only edited fields on the latest snapshot. Background updates refresh untouched fields without wiping drafts. Saves send only edited keys, preserving hidden metadata and unrelated changes. An in-flight guard prevents duplicate submissions, controls are disabled during saves, failures retain edits, and Discard restores the current server snapshot. Server validation now completes before changing agency, jurisdiction or office fields, preventing a rejected office field from partially changing the agency in memory.

Concurrent edits to the same field retain the existing last-save behavior; this does not introduce field-level collaboration locks. Server authentication, recovery checks, persistence format and integration authority are unchanged.

## Verification

- 111 tests passed across office validation, Desk, stored book compatibility, product-mode helpers and authenticated HTTP behavior.
- 21 browser checks passed against isolated synthetic settings: collapsed optional sections even with saved values, basic-only saves, hidden-field preservation, concurrent snapshot updates, optional software clearing, failed-save retry, discard, duplicate-submit guard, reload and 900/640-pixel overflow checks.
- TypeScript and production build passed; existing Vite chunk warnings remain.
- No browser runtime errors occurred. The first browser harness attempt had an interceptor cleanup error; it was corrected and the final run passed. The initial failure log is retained.
- Scoped diff and whitespace check passed. Existing unrelated work was preserved.

Evidence is in `outputs/pm-office-simplification-2026-09-07/`. API port 18982 and UI port 5202 used `/tmp/realbud-office-simplification-20260907`, separate from the installed app. The installed native application was not replaced, and no live PMS connection was made.
