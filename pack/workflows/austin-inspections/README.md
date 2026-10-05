# Austin inspections (W5): planning core

Spec: `docs/SHERRY-WORKFLOWS-BUILD-PLAN-2026-10-02.md`, section W5.

## Built (source + local tests only)

- `server/inspection-plan.ts`: `draftInspectionPlan()` is a pure, deterministic function. It turns properties,
  office rules, accepted bookings and manual changes into a six-month draft:
  - appointments by day, inspector and time, each with a reason;
  - holds (overdue, no history, unreadable date, no free slot, held by hand) — nothing is silently dropped;
  - `notDue` for properties whose next visit falls after the plan window.
- Accepted bookings and manual moves are kept exactly as set on every rerun; a manual change wins over an
  accepted booking for the same property and keeps its external booking id. Draft ids are
  `insp-<propertyId>-due-<dueDate>`, so they stay stable while the history does not change.
- Same-area properties due in the same month aim for the group's earliest due date and share a day, up to
  daily capacity, then overflow to the next working day. Weekends, closed dates and per-property access
  weekdays are respected.
- `fixtures/synthetic-portfolio.json`: fictional portfolio (12 `SYN-P` properties, 3 areas) and example
  rules used by `server/inspection-plan.test.ts`. These are test inputs, not Austin data or accepted settings.

Deliberate simplifications (marked `ponytail:` in source): flat travel allowance and no routing; month
buckets for grouping; overdue properties are held for a person instead of auto-booked; a pinned booking on a
closed day or over capacity is kept without a warning.

## Pending

- Property Inspect through Zapier MCP: account connection, tool qualification, sample read, controlled
  booking/date change, readback of external ids, calendar and notice behaviour. Nothing here calls Zapier,
  MCP or Property Inspect.
- Wiring into RealBud (a Schedule loop, Desk view, saved plan and edits). Not started in this packet.

## Inputs needed from Sherry

1. ~~Completed or planned date?~~ Sherry confirmed **completed** (5 Oct). Her other working rules get collected by Bud during her onboarding.
2. Working days, closed dates, inspectors, appointment length, travel allowance, daily capacity, day start.
3. Area groups for each property, and any per-area inspector assignment.
4. Access constraints per property (days, times, tenant notes) and minimum entry notice lead time.
5. Overdue properties: hold for her (current behaviour) or auto-book into the first free slot?
6. Is booking a few weeks early to group an area acceptable, and how early at most?
7. How a missed visit or a reschedule should reset the next due date.
