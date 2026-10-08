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

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short relative stamp for session lines: "2 min ago", then hours, then the date. */
export function relativeAgo(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "1 h ago";
  if (hours < 24) return `${hours} h ago`;
  return fmtDateTime(ms);
}
