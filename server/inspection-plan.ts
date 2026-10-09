// Draft a six-month routine-inspection plan (Sherry's W5). Pure and
// deterministic: same input, same output, no clock, no I/O. It proposes;
// booking in Property Inspect is a later, reviewed step and is not built here.

export type CycleBasis = 'completed' | 'planned';

export interface InspectionProperty {
  id: string;
  address: string;
  area: string;
  lastPlanned?: string; // YYYY-MM-DD
  lastCompleted?: string; // YYYY-MM-DD
  /** Weekdays (0 = Sunday … 6 = Saturday) access is possible; omitted = any working day. */
  accessWeekdays?: number[];
  accessNote?: string;
}

export interface InspectionRules {
  planStart: string; // first day the plan may book, YYYY-MM-DD
  horizonMonths: number; // usually 6
  cycleMonths: number; // usually 6
  cycleBasis: CycleBasis; // Sherry confirmed 'completed' (5 Oct); 'planned' kept as a setting
  workingDays: number[]; // weekdays, e.g. [1,2,3,4,5]
  closedDates?: string[];
  inspectors: string[];
  dayStart: string; // HH:MM
  appointmentMinutes: number;
  travelMinutes: number;
  dailyCapacity: number; // per inspector
}

/** A booking already accepted (or a time a person set by hand). Never moved by a rerun. */
export interface PinnedAppointment {
  id?: string;
  propertyId: string;
  date: string;
  time: string;
  inspector: string;
  externalId?: string;
}

export type ManualChange =
  | ({ kind: 'move' } & PinnedAppointment)
  | { kind: 'hold'; propertyId: string; note: string };

export interface PlannedAppointment {
  id: string;
  propertyId: string;
  address: string;
  area: string;
  date: string;
  time: string;
  inspector: string;
  dueDate: string | null;
  status: 'accepted' | 'manual' | 'draft';
  externalId?: string;
  reason: string;
}

export interface PlanHold {
  propertyId: string;
  kind: 'overdue' | 'no-history' | 'unschedulable' | 'manual-hold' | 'unreadable';
  dueDate: string | null;
  reason: string;
}

export interface PlanDay {
  date: string;
  inspector: string;
  areas: string[];
  appointments: PlannedAppointment[];
}

export interface InspectionPlan {
  appointments: PlannedAppointment[];
  days: PlanDay[];
  holds: PlanHold[];
  notDue: { propertyId: string; dueDate: string }[];
  /** Existing bookings stay pinned; changed rules and conflicting pins need human review. */
  diagnostics?: PlanDiagnostic[];
}

export interface PlanDiagnostic {
  kind: 'closed-day' | 'capacity' | 'collision';
  date: string;
  inspector: string;
  propertyIds: string[];
  reason: string;
}

export interface InspectionPlanInput {
  properties: InspectionProperty[];
  rules: InspectionRules;
  accepted?: PinnedAppointment[];
  manual?: ManualChange[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDate(value: string | undefined): Date | null {
  if (!value || !DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value ? date : null;
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (value: string, days: number) => { const d = parseDate(value)!; d.setUTCDate(d.getUTCDate() + days); return iso(d); };
export function addMonths(value: string, months: number): string {
  const d = parseDate(value)!;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // 31 Aug + 6 → 28 Feb
  return iso(d);
}
const weekday = (value: string) => parseDate(value)!.getUTCDay();
const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeMinutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
/** Both the appointment and reviewed travel allowance reserve the inspector's time. */
export const inspectionTimesOverlap = (a: string, b: string, rules: Pick<InspectionRules, 'appointmentMinutes' | 'travelMinutes'>) =>
  Math.abs(timeMinutes(a) - timeMinutes(b)) < rules.appointmentMinutes + rules.travelMinutes;

/** Next inspection due date, or null when the chosen basis has no readable date. */
export function dueDate(property: InspectionProperty, rules: Pick<InspectionRules, 'cycleBasis' | 'cycleMonths'>): string | null {
  const basis = rules.cycleBasis === 'completed' ? property.lastCompleted : property.lastPlanned;
  return parseDate(basis) ? addMonths(basis!, rules.cycleMonths) : null;
}

export function checkRules(rules: InspectionRules) {
  const positive = (n: number) => Number.isInteger(n) && n > 0;
  if (!parseDate(rules.planStart)) throw new Error('Plan start must be a date like 2026-10-05.');
  if (!positive(rules.horizonMonths) || !positive(rules.cycleMonths)) throw new Error('Plan length and inspection cycle must be whole months.');
  if (rules.cycleBasis !== 'completed' && rules.cycleBasis !== 'planned') throw new Error('Choose whether the cycle follows the completed or planned date.');
  if (!rules.workingDays.length || rules.workingDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Choose at least one working day.');
  if (!rules.inspectors.length) throw new Error('Add at least one inspector.');
  if (!TIME.test(rules.dayStart)) throw new Error('Day start must be a time like 09:00.');
  if (!positive(rules.appointmentMinutes) || !positive(rules.dailyCapacity) || !Number.isInteger(rules.travelMinutes) || rules.travelMinutes < 0) {
    throw new Error('Appointment length, travel allowance and daily capacity must be whole numbers.');
  }
  const [h, m] = rules.dayStart.split(':').map(Number);
  if (h * 60 + m + rules.dailyCapacity * (rules.appointmentMinutes + rules.travelMinutes) > 24 * 60) throw new Error('Daily capacity does not fit in one day.');
}

export function draftInspectionPlan(input: InspectionPlanInput): InspectionPlan {
  const { rules } = input;
  checkRules(rules);
  const windowEnd = addMonths(rules.planStart, rules.horizonMonths); // exclusive
  const closed = new Set(rules.closedDates ?? []);
  const byId = new Map(input.properties.map((p) => [p.id, p]));
  const appointments: PlannedAppointment[] = [];
  const holds: PlanHold[] = [];
  const notDue: InspectionPlan['notDue'] = [];
  // Per inspector-day: which times are taken and which areas it already serves.
  const days = new Map<string, { times: Set<string>; areas: Set<string>; count: number }>();
  const day = (date: string, inspector: string) => {
    const key = `${date}|${inspector}`;
    if (!days.has(key)) days.set(key, { times: new Set(), areas: new Set(), count: 0 });
    return days.get(key)!;
  };

  // 1. People's decisions first: a manual change beats an accepted booking for the same property.
  const pinned = new Map<string, { appt: PinnedAppointment; status: 'accepted' | 'manual' }>();
  for (const appt of input.accepted ?? []) pinned.set(appt.propertyId, { appt, status: 'accepted' });
  const manualHolds = new Map<string, string>();
  for (const change of input.manual ?? []) {
    if (change.kind === 'hold') { manualHolds.set(change.propertyId, change.note); pinned.delete(change.propertyId); continue; }
    const previous = pinned.get(change.propertyId)?.appt;
    pinned.set(change.propertyId, { appt: { ...change, id: change.id ?? previous?.id, externalId: change.externalId ?? previous?.externalId }, status: 'manual' });
  }
  for (const [propertyId, { appt, status }] of [...pinned].sort(([a], [b]) => a.localeCompare(b))) {
    if (!parseDate(appt.date) || !TIME.test(appt.time) || !appt.inspector) throw new Error(`The booking for ${propertyId} needs a date, time and inspector.`);
    const property = byId.get(propertyId);
    // Preserve the person's booking. Diagnostics below name conflicts rather than moving it silently.
    const slot = day(appt.date, appt.inspector);
    slot.times.add(appt.time);
    slot.count++;
    if (property) slot.areas.add(property.area);
    appointments.push({
      id: appt.id ?? `insp-${propertyId}-${appt.date}`, propertyId, address: property?.address ?? '', area: property?.area ?? '',
      date: appt.date, time: appt.time, inspector: appt.inspector, dueDate: property ? dueDate(property, rules) : null, status,
      ...(appt.externalId ? { externalId: appt.externalId } : {}),
      reason: status === 'accepted' ? 'Accepted booking; kept as booked.' : 'Changed by hand; kept as set.',
    });
  }

  // 2. Classify everything else.
  const toDraft: { property: InspectionProperty; due: string; target: string }[] = [];
  for (const property of [...input.properties].sort((a, b) => a.id.localeCompare(b.id))) {
    if (pinned.has(property.id)) continue;
    if (manualHolds.has(property.id)) {
      holds.push({ propertyId: property.id, kind: 'manual-hold', dueDate: dueDate(property, rules), reason: manualHolds.get(property.id)! });
      continue;
    }
    const basis = rules.cycleBasis === 'completed' ? property.lastCompleted : property.lastPlanned;
    if (basis === undefined || basis === '') {
      holds.push({ propertyId: property.id, kind: 'no-history', dueDate: null, reason: `No ${rules.cycleBasis} inspection date on file; confirm when it was last inspected.` });
      continue;
    }
    const due = dueDate(property, rules);
    if (!due) { holds.push({ propertyId: property.id, kind: 'unreadable', dueDate: null, reason: `The ${rules.cycleBasis} inspection date "${basis}" could not be read.` }); continue; }
    if (due < rules.planStart) {
      // ponytail: overdue is held for a person rather than squeezed into the first free slot; notice lead time is theirs to judge.
      holds.push({ propertyId: property.id, kind: 'overdue', dueDate: due, reason: `Overdue since ${due}; book the earliest date that suits the tenant.` });
      continue;
    }
    if (due >= windowEnd) { notDue.push({ propertyId: property.id, dueDate: due }); continue; }
    toDraft.push({ property, due, target: due });
  }

  // 3. Group by area and due month; the group aims for its earliest due date so
  // neighbours share a day. ponytail: month buckets and a flat travel allowance,
  // no routing or drive times; add a geo/route step if travel varies a lot.
  const groups = new Map<string, string>();
  for (const item of toDraft) {
    const key = `${item.property.area}|${item.due.slice(0, 7)}`;
    if (!groups.has(key) || item.due < groups.get(key)!) groups.set(key, item.due);
  }
  for (const item of toDraft) item.target = groups.get(`${item.property.area}|${item.due.slice(0, 7)}`)!;
  toDraft.sort((a, b) => a.target.localeCompare(b.target) || a.property.area.localeCompare(b.property.area) || a.due.localeCompare(b.due) || a.property.id.localeCompare(b.property.id));

  const [startH, startM] = rules.dayStart.split(':').map(Number);
  const step = rules.appointmentMinutes + rules.travelMinutes;
  const slotTimes = Array.from({ length: rules.dailyCapacity }, (_, i) => minutesToTime(startH * 60 + startM + i * step));

  // 4. Fill forward from each target: first working, open, accessible day with a free slot whose inspector serves this area or nobody yet.
  for (const { property, due, target } of toDraft) {
    let placed = false;
    for (let date = target; date < windowEnd && !placed; date = addDays(date, 1)) {
      const wd = weekday(date);
      if (!rules.workingDays.includes(wd) || closed.has(date)) continue;
      if (property.accessWeekdays?.length && !property.accessWeekdays.includes(wd)) continue;
      for (const inspector of rules.inspectors) {
        const slot = day(date, inspector);
        if (slot.count >= rules.dailyCapacity) continue;
        if (slot.areas.size && !slot.areas.has(property.area)) continue;
        const time = slotTimes.find((t) => ![...slot.times].some(taken => inspectionTimesOverlap(t, taken, rules)));
        if (!time) continue;
        slot.times.add(time);
        slot.count++;
        slot.areas.add(property.area);
        const why = [`Due ${due}.`];
        if (date !== due) why.push(date < due ? `Grouped with ${property.area} visits.` : 'Earlier days were full or unavailable.');
        if (property.accessNote) why.push(`Access: ${property.accessNote}`);
        appointments.push({ id: `insp-${property.id}-due-${due}`, propertyId: property.id, address: property.address, area: property.area,
          date, time, inspector, dueDate: due, status: 'draft', reason: why.join(' ') });
        placed = true;
        break;
      }
    }
    if (!placed) holds.push({ propertyId: property.id, kind: 'unschedulable', dueDate: due, reason: `No free ${property.area} slot from ${target} to the end of the plan.` });
  }

  appointments.sort((a, b) => a.date.localeCompare(b.date) || a.inspector.localeCompare(b.inspector) || a.time.localeCompare(b.time) || a.propertyId.localeCompare(b.propertyId));
  const grouped = new Map<string, PlanDay>();
  for (const appt of appointments) {
    const key = `${appt.date}|${appt.inspector}`;
    if (!grouped.has(key)) grouped.set(key, { date: appt.date, inspector: appt.inspector, areas: [], appointments: [] });
    const entry = grouped.get(key)!;
    entry.appointments.push(appt);
    if (appt.area && !entry.areas.includes(appt.area)) entry.areas.push(appt.area);
  }
  const diagnostics: PlanDiagnostic[] = [];
  for (const entry of grouped.values()) {
    const base = { date: entry.date, inspector: entry.inspector, propertyIds: entry.appointments.map(a => a.propertyId) };
    if (closed.has(entry.date) || !rules.workingDays.includes(weekday(entry.date))) diagnostics.push({ ...base, kind: 'closed-day',
      reason: `${entry.inspector} has ${entry.appointments.length} kept booking${entry.appointments.length === 1 ? '' : 's'} on ${entry.date}, ${closed.has(entry.date) ? 'when the office is closed' : 'outside the working days'}. Review and move them if needed.` });
    if (entry.appointments.length > rules.dailyCapacity) diagnostics.push({ ...base, kind: 'capacity',
      reason: `${entry.inspector} has ${entry.appointments.length} kept bookings on ${entry.date}; the daily limit is ${rules.dailyCapacity}. Review and move the excess bookings.` });
    for (let i = 0; i < entry.appointments.length; i++) for (let j = i + 1; j < entry.appointments.length; j++) {
      const a = entry.appointments[i]!, b = entry.appointments[j]!;
      if (inspectionTimesOverlap(a.time, b.time, rules)) diagnostics.push({ ...base, kind: 'collision', propertyIds: [a.propertyId, b.propertyId],
        reason: `${entry.inspector}'s kept bookings at ${a.time} and ${b.time} on ${entry.date} overlap the ${rules.appointmentMinutes} minute visit and ${rules.travelMinutes} minute travel allowance. Review and move one.` });
    }
  }
  return { appointments, days: [...grouped.values()], holds, notDue, diagnostics };
}
