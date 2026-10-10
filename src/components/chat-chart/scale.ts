// Pure geometry for chat charts: tick picking, linear scales, label thinning
// and bar paths. No DOM, so it is unit-tested and safe under SSR.

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count: number, integer = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.5;
    min = min > 0 ? 0 : min - pad;
    max = max > 0 ? max + pad : 0;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 2.5, 5, 10, 20].map((m) => m * power).filter((s) => !integer || (s >= 1 && Number.isInteger(s)));
  const step = steps.find((s) => span / s <= count) ?? steps[steps.length - 1] ?? 10 * power;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let i = 0, v = start; v <= end + step / 2 && i < 50; i++, v = start + i * step) {
    ticks.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Every `step`-th label so labels never overlap at this width. */
export function labelStep(count: number, available: number, labelWidth: number): number {
  if (count <= 1 || available <= 0) return 1;
  const fits = Math.max(1, Math.floor(available / Math.max(1, labelWidth)));
  return Math.max(1, Math.ceil(count / fits));
}

let context: CanvasRenderingContext2D | null | undefined;
let family = "";
function measurer(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  try {
    context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    family = context ? getComputedStyle(document.body).fontFamily || "sans-serif" : "";
  } catch {
    context = null;
  }
  return context;
}

/** Rendered width of system-sans text: measured in a browser (plus a pixel of
 * slack), estimated on the wide side elsewhere (tests, server render). */
export function textWidth(text: string, size = 12): number {
  const estimate = Math.ceil(text.length * size * 0.62);
  try {
    const ctx = measurer();
    if (!ctx) return estimate;
    ctx.font = `${size}px ${family}`;
    // tabular figures are at least as wide as proportional ones
    const width = ctx.measureText(text).width;
    return Number.isFinite(width) && width > 0 ? Math.ceil(width * 1.04) + 1 : estimate;
  } catch {
    return estimate;
  }
}

/** The longest prefix (with an ellipsis) that fits in `px` at `size`. */
export function fitText(text: string, px: number, size = 12, min = 4): string {
  if (textWidth(text, size) <= px) return text;
  let lo = min, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(truncate(text, mid), size) <= px) lo = mid; else hi = mid - 1;
  }
  return truncate(text, Math.max(min, lo));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** A bar whose data end is rounded (radius r) and whose baseline end is square.
 * Vertical: x/width across, `base` and `end` are y values. Horizontal: y/height
 * across, `base` and `end` are x values. */
export function barPath(across: number, thickness: number, base: number, end: number, horizontal: boolean, radius = 4): string {
  const length = Math.abs(end - base);
  const r = Math.max(0, Math.min(radius, thickness / 2, length));
  const dir = end < base ? -1 : 1;
  const a0 = across, a1 = across + thickness;
  const f = (n: number) => Math.round(n * 100) / 100;
  if (!horizontal) {
    // y grows downward; the data end is `end`
    return `M${f(a0)},${f(base)}L${f(a0)},${f(end - dir * r)}Q${f(a0)},${f(end)} ${f(a0 + r)},${f(end)}L${f(a1 - r)},${f(end)}Q${f(a1)},${f(end)} ${f(a1)},${f(end - dir * r)}L${f(a1)},${f(base)}Z`;
  }
  return `M${f(base)},${f(a0)}L${f(end - dir * r)},${f(a0)}Q${f(end)},${f(a0)} ${f(end)},${f(a0 + r)}L${f(end)},${f(a1 - r)}Q${f(end)},${f(a1)} ${f(end - dir * r)},${f(a1)}L${f(base)},${f(a1)}Z`;
}
