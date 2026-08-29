// en-AU formatting for all user-visible dates and times. The product is
// Australian property management; the host locale must never leak through.
const AU = "en-AU";

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(AU, { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(ms: number, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  try {
    return new Date(ms).toLocaleString(AU, timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return new Date(ms).toLocaleString(AU, opts);
  }
}

export function fmtTimeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(AU, { hour: "numeric", minute: "2-digit" });
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "today at 3:04 pm" / "tomorrow at 7:30 am" / "yesterday at …" / "Fri 28 Aug at 4:00 pm". */
export function whenLabel(ms: number): string {
  const date = new Date(ms);
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  const time = fmtTimeOfDay(ms);
  if (day === today) return `today at ${time}`;
  if (day === today + DAY_MS) return `tomorrow at ${time}`;
  if (day === today - DAY_MS) return `yesterday at ${time}`;
  const label = date.toLocaleDateString(AU, { weekday: "short", day: "numeric", month: "short" });
  return `${label} at ${time}`;
}
