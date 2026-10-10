// Charts in chat: Bud writes a fenced ```chart block holding a small JSON spec.
// This module is the only reader of that block. It never throws, never evals,
// and either returns a fully validated chart or the readable parts as a table.
// The renderer (src/components/chat-chart) draws only what passes here; plain
// text paths (Copy, Send to phone, channel relays) use the text helpers below
// so nobody ever receives raw chart JSON.

export const CHAT_CHART_LIMITS = {
  bytes: 32 * 1024,
  series: 8,
  points: 200,
  stats: 12,
  heatmapSide: 31,
  heatmapCells: 31 * 24,
  horizontalBars: 50,
  label: 60,
  title: 120,
  subtitle: 160,
  source: 160,
  unit: 24,
  statText: 24,
  note: 80,
  magnitude: 1e15,
} as const;

export type ChatChartKind = "bar" | "line" | "area" | "stats" | "heatmap";
export interface ChatChartSeries { name: string; values: (number | null)[] }
export interface ChatChartStat { label: string; value: number | string; note?: string }
interface ChartBase { title: string; subtitle?: string; unit?: string; source?: string }
export type ChatChartXY = ChartBase & {
  type: "bar" | "line" | "area";
  x: string[];
  series: ChatChartSeries[];
  stacked: boolean;
  horizontal: boolean;
};
export type ChatChartStats = ChartBase & { type: "stats"; stats: ChatChartStat[] };
export type ChatChartHeatmap = ChartBase & { type: "heatmap"; rows: string[]; cols: string[]; cells: (number | null)[][] };
export type ChatChart = ChatChartXY | ChatChartStats | ChatChartHeatmap;

/** Whatever could be read from a block that cannot be drawn, as plain cells. */
export interface ChatChartTable { title?: string; columns: string[]; rows: string[][] }
export type ChatChartParse =
  | { ok: true; chart: ChatChart }
  | { ok: false; reason: string; partial?: ChatChartTable };

const L = CHAT_CHART_LIMITS;
const TYPES: readonly ChatChartKind[] = ["bar", "line", "area", "stats", "heatmap"];

class Invalid extends Error {}
const fail = (reason: string): never => { throw new Invalid(reason); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if ((value === undefined || value === null) && !required) return undefined;
  if (typeof value !== "string") return fail(`The ${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return required ? fail(`The ${field} is empty.`) : undefined;
  if (trimmed.length > max) fail(`The ${field} is longer than ${max} characters.`);
  return trimmed;
}

function label(value: unknown, field: string): string {
  // Years and quarter numbers arrive as numbers often enough to accept them.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value, field, L.label, true)!;
}

function amount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`Every ${field} must be a number or empty.`);
  if (Math.abs(value) > L.magnitude) fail(`A ${field} is too large to draw.`);
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") return fail(`"${field}" must be true or false.`);
  return value;
}

function list(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) return fail(`The ${field} list is missing.`);
  if (value.length < min) fail(`The ${field} list is empty.`);
  if (value.length > max) fail(`The chart has more than ${max} ${field}.`);
  return value;
}

// Fields a chart doesn't use are ignored, never read or passed on: models often
// add harmless extras ("color", "description") and the chart should still draw.

function validate(spec: unknown): ChatChart {
  if (!isRecord(spec)) return fail("The chart data isn't a chart description.");
  const type = spec.type;
  if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type)) return fail("The chart type isn't one RealBud can draw.");
  const kind = type as ChatChartKind;
  // A missing title is common in model output; draw the chart with a plain
  // default rather than fall back to a table.
  const fallbackTitle = kind === "stats" ? "Key figures" : kind === "heatmap" ? "Heat map" : "Chart";
  const base: ChartBase = { title: text(spec.title, "title", L.title, false) ?? fallbackTitle };
  const subtitle = text(spec.subtitle, "subtitle", L.subtitle, false);
  const unit = text(spec.unit, "unit", L.unit, false);
  const source = text(spec.source, "source", L.source, false);
  if (subtitle) base.subtitle = subtitle;
  if (unit) base.unit = unit;
  if (source) base.source = source;

  if (kind === "stats") {
    const stats = list(spec.stats, "figures", 1, L.stats).map((raw): ChatChartStat => {
      if (!isRecord(raw)) return fail("Each figure needs a label and a value.");
      const value = typeof raw.value === "string" ? text(raw.value, "figure value", L.statText, true)! : amount(raw.value, "figure value");
      if (value === null) return fail("Each figure needs a value.");
      const note = text(raw.note, "figure note", L.note, false);
      return { label: label(raw.label, "figure label"), value, ...(note ? { note } : {}) };
    });
    return { ...base, type: kind, stats };
  }

  if (kind === "heatmap") {
    const grid = list(spec.cells, "rows", 1, L.heatmapSide).map((row) => list(row, "columns", 1, L.heatmapSide).map((cell) => amount(cell, "cell")));
    const width = grid[0]!.length;
    if (grid.some((row) => row.length !== width)) fail("The rows of the grid have different lengths.");
    if (grid.length * width > L.heatmapCells) fail(`The grid has more than ${L.heatmapCells} cells.`);
    if (!grid.some((row) => row.some((cell) => cell !== null))) fail("The grid has no values.");
    const rows = spec.rows === undefined ? grid.map((_, index) => String(index + 1)) : list(spec.rows, "row labels", 1, L.heatmapSide).map((v) => label(v, "row label"));
    const cols = spec.cols === undefined ? Array.from({ length: width }, (_, index) => String(index + 1)) : list(spec.cols, "column labels", 1, L.heatmapSide).map((v) => label(v, "column label"));
    if (rows.length !== grid.length) fail(`The grid has ${grid.length} rows but ${rows.length} row labels.`);
    if (cols.length !== width) fail(`The grid has ${width} columns but ${cols.length} column labels.`);
    return { ...base, type: kind, rows, cols, cells: grid };
  }

  const series = list(spec.series, "series", 1, L.series).map((raw): ChatChartSeries => {
    if (!isRecord(raw)) return fail("Each series needs a name and values.");
    return {
      name: label(raw.name, "series name"),
      values: list(raw.values, "values", 1, L.points).map((value) => amount(value, "value")),
    };
  });
  const length = series[0]!.values.length;
  if (series.some((s) => s.values.length !== length)) fail("The series have different numbers of values.");
  if (!series.some((s) => s.values.some((value) => value !== null))) fail("The chart has no values.");
  const x = spec.x === undefined ? Array.from({ length }, (_, index) => String(index + 1)) : list(spec.x, "labels", 1, L.points).map((v) => label(v, "label"));
  if (x.length !== length) fail(`The chart has ${x.length} labels but ${length} values in each series.`);
  const stacked = (kind === "bar" || kind === "area") && flag(spec.stacked, "stacked");
  const horizontal = kind === "bar" && flag(spec.horizontal, "horizontal");
  if (stacked && series.some((s) => s.values.some((value) => value !== null && value < 0))) fail("A stacked chart can't show values below zero.");
  if (horizontal && length > L.horizontalBars) fail(`A sideways bar chart can show at most ${L.horizontalBars} bars.`);
  return { ...base, type: kind as ChatChartXY["type"], x, series, stacked, horizontal };
}

// ---------------------------------------------------------------- fallback

const PARTIAL_ROWS = 200;
const PARTIAL_COLS = 9;
const cellText = (value: unknown, unit?: string): string => {
  if (typeof value === "number") return Number.isFinite(value) ? formatChartValue(value, unit) : "—";
  if (typeof value === "string") return value.trim().slice(0, L.label) || "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
};

function salvage(spec: unknown): ChatChartTable | undefined {
  if (!isRecord(spec)) return undefined;
  const title = typeof spec.title === "string" && spec.title.trim() ? spec.title.trim().slice(0, L.title) : undefined;
  const unit = typeof spec.unit === "string" ? spec.unit.trim().slice(0, L.unit) : undefined;
  let table: ChatChartTable | undefined;
  if (Array.isArray(spec.stats)) {
    const rows = spec.stats.slice(0, PARTIAL_ROWS).filter(isRecord).map((stat) => [cellText(stat.label), cellText(stat.value, unit)]);
    table = { columns: ["Figure", "Value"], rows };
  } else if (Array.isArray(spec.series)) {
    const series = spec.series.filter(isRecord).slice(0, PARTIAL_COLS - 1);
    const xs = Array.isArray(spec.x) ? spec.x : [];
    const length = Math.min(PARTIAL_ROWS, Math.max(xs.length, ...series.map((s) => (Array.isArray(s.values) ? s.values.length : 0))));
    const rows = Array.from({ length }, (_, index) => [
      index < xs.length ? cellText(xs[index]) : String(index + 1),
      ...series.map((s) => (Array.isArray(s.values) ? cellText(s.values[index], unit) : "—")),
    ]);
    table = { columns: ["", ...series.map((s, index) => (typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, L.label) : `Series ${index + 1}`))], rows };
  } else if (Array.isArray(spec.cells)) {
    const grid = spec.cells.filter(Array.isArray).slice(0, PARTIAL_ROWS) as unknown[][];
    const rowLabels = Array.isArray(spec.rows) ? spec.rows : [];
    const colLabels = Array.isArray(spec.cols) ? spec.cols : [];
    const width = Math.min(PARTIAL_COLS - 1, Math.max(0, ...grid.map((row) => row.length)));
    table = {
      columns: ["", ...Array.from({ length: width }, (_, index) => (index < colLabels.length ? cellText(colLabels[index]) : String(index + 1)))],
      rows: grid.map((row, index) => [index < rowLabels.length ? cellText(rowLabels[index]) : String(index + 1), ...Array.from({ length: width }, (_, col) => cellText(row[col], unit))]),
    };
  }
  if (!table || !table.rows.some((row) => row.slice(1).some((cell) => cell !== "—"))) return undefined;
  return title ? { title, ...table } : table;
}

const byteLength = (value: string) => {
  try { return new TextEncoder().encode(value).length; } catch { return value.length * 3; }
};

/** Read one ```chart block body. Never throws. */
export function parseChatChart(source: unknown): ChatChartParse {
  try {
    if (typeof source !== "string" || !source.trim()) return { ok: false, reason: "The chart has no data." };
    if (source.length > L.bytes || byteLength(source) > L.bytes) return { ok: false, reason: "The chart data is too large to draw." };
    let spec: unknown;
    try { spec = JSON.parse(source); } catch { return { ok: false, reason: "The chart data isn't complete." }; }
    try {
      return { ok: true, chart: validate(spec) };
    } catch (error) {
      const reason = error instanceof Invalid ? error.message : "The chart data couldn't be read.";
      let partial: ChatChartTable | undefined;
      try { partial = salvage(spec); } catch { partial = undefined; }
      return partial ? { ok: false, reason, partial } : { ok: false, reason };
    }
  } catch {
    return { ok: false, reason: "The chart data couldn't be read." };
  }
}

// ---------------------------------------------------------------- numbers

// Intl accepts any well-formed three-letter code, so only real currencies
// an Australian office meets are formatted as money.
const CURRENCIES = ["AUD", "NZD", "USD", "GBP", "EUR"];
const currencyCode = (unit: string | undefined) => (unit && CURRENCIES.includes(unit) ? unit : null);
/** Money and % read inline on every tick; a word unit ("days") is said once. */
export const chartUnitIsInline = (unit: string | undefined) => !unit || unit === "%" || currencyCode(unit) !== null;

/** A value as office staff read it: $12,400 for AUD, 12.5%, 14 days. */
export function formatChartValue(value: number, unit?: string, options: { compact?: boolean } = {}): string {
  try {
    if (!Number.isFinite(value)) return "—";
    const currency = currencyCode(unit);
    const whole = Number.isInteger(value);
    // money keeps its cents; other large figures drop decimals
    const fraction = whole ? 0 : currency || Math.abs(value) < 100 ? 2 : 0;
    const format: Intl.NumberFormatOptions = options.compact && Math.abs(value) >= 10_000
      ? { notation: "compact", maximumSignificantDigits: 3 }
      : !currency && !whole && Math.abs(value) < 1
        // 0.012 stays 0.012 rather than rounding to 0.01
        ? { maximumSignificantDigits: 3 }
        : { minimumFractionDigits: currency ? fraction : 0, maximumFractionDigits: fraction };
    if (currency) return new Intl.NumberFormat("en-AU", { ...format, style: "currency", currency }).format(value);
    const number = new Intl.NumberFormat("en-AU", format).format(value);
    if (!unit) return number;
    if (unit === "%") return `${number}%`;
    // "1 day", not "1 days"
    return `${number} ${Math.abs(value) === 1 && /^[a-z]{2,}s$/.test(unit) ? unit.slice(0, -1) : unit}`;
  } catch {
    return String(value);
  }
}

const valueText = (value: number | string | null, unit?: string) =>
  value === null ? "no value" : typeof value === "string" ? value : formatChartValue(value, unit);

// ---------------------------------------------------------------- plain text

export function chartToTable(chart: ChatChart): ChatChartTable {
  if (chart.type === "stats") {
    return { title: chart.title, columns: ["Figure", "Value", "Note"], rows: chart.stats.map((s) => [s.label, valueText(s.value, chart.unit), s.note ?? ""]) };
  }
  if (chart.type === "heatmap") {
    return { title: chart.title, columns: ["", ...chart.cols], rows: chart.rows.map((row, r) => [row, ...chart.cells[r]!.map((v) => (v === null ? "—" : formatChartValue(v, chart.unit)))]) };
  }
  return {
    title: chart.title,
    columns: ["", ...chart.series.map((s) => s.name)],
    rows: chart.x.map((x, i) => [x, ...chart.series.map((s) => (s.values[i] === null ? "—" : formatChartValue(s.values[i]!, chart.unit)))]),
  };
}

const head = (chart: ChatChart) => [chart.title, chart.subtitle].filter(Boolean).join(" — ");
const foot = (chart: ChatChart) => (chart.source ? [`Source: ${chart.source}`] : []);

/** A chart as readable lines, for copy, phone and anywhere a picture can't go. */
export function chartToText(chart: ChatChart): string {
  try {
    const lines = [head(chart)];
    if (chart.type === "stats") {
      for (const s of chart.stats) lines.push(`${s.label}: ${valueText(s.value, chart.unit)}${s.note ? ` (${s.note})` : ""}`);
    } else if (chart.type === "heatmap") {
      chart.rows.forEach((row, r) => {
        lines.push(`${row}: ${chart.cols.map((col, c) => `${col} ${valueText(chart.cells[r]![c]!, chart.unit)}`).join(", ")}`);
      });
    } else if (chart.series.length === 1) {
      const only = chart.series[0]!;
      chart.x.forEach((x, i) => lines.push(`${x}: ${valueText(only.values[i]!, chart.unit)}`));
    } else {
      for (const s of chart.series) lines.push(`${s.name}: ${chart.x.map((x, i) => `${x} ${valueText(s.values[i]!, chart.unit)}`).join(", ")}`);
    }
    return [...lines, ...foot(chart)].join("\n");
  } catch {
    return chart.title;
  }
}

export function chartTableToText(table: ChatChartTable): string {
  const [, ...names] = table.columns;
  const lines = table.rows.map((row) => {
    const [first, ...cells] = row;
    return `${first}: ${cells.map((cell, i) => (names[i] ? `${names[i]} ${cell}` : cell)).join(", ")}`;
  });
  return [table.title ?? "Chart data", ...lines].join("\n");
}

/** The readable text for one block body, valid or not; never raw JSON. */
export function chartBlockText(source: string): string {
  const parsed = parseChatChart(source);
  if (parsed.ok) return chartToText(parsed.chart);
  if (parsed.partial) return chartTableToText(parsed.partial);
  return "(A chart was here, but its data couldn't be read. Open RealBud to see the reply.)";
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*chart[ \t]*$/i;

/** Replace every ```chart fence in Markdown with readable text. An unclosed
 * fence (a cut-off reply) runs to the end, as Markdown itself would. */
export function replaceChartBlocksWithText(markdown: string): string {
  try {
    if (typeof markdown !== "string" || !/chart/i.test(markdown)) return markdown;
    const lines = markdown.split("\n");
    const out: string[] = [];
    let other: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (other !== null) {
        // inside some other fenced block: copy through until it closes
        out.push(line);
        if (fence && fence[1]![0] === other[0] && fence[1]!.length >= other.length && !line.slice(fence[0].length).trim()) other = null;
        continue;
      }
      const open = FENCE_OPEN.exec(line);
      if (!open) {
        out.push(line);
        if (fence) other = fence[1]!;
        continue;
      }
      const marker = open[1]!;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        body.push(lines[j]!);
      }
      out.push(chartBlockText(body.join("\n")));
      i = j;
    }
    return out.join("\n");
  } catch {
    return markdown;
  }
}
