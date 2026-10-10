// Bar, line and area charts as hand-built SVG. The SVG is a picture only
// (role="img" on its wrapper, aria-hidden inside); the interactive layer is a
// row of real buttons over it, one per label, with a roving tab stop so a
// keyboard reaches any point and sees the same tooltip a pointer does.
import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { CHAT_CHART_LIMITS, chartUnitIsInline, formatChartValue, type ChatChartXY } from "@shared/chat-chart";
import { SERIES_FILL, SERIES_STROKE, slot } from "./palette";
import { barPath, fitText, labelStep, linear, niceTicks, textWidth, truncate } from "./scale";
import { ChartTooltip, type TooltipRow } from "./ChartTooltip";

interface Layout {
  width: number; height: number; left: number; right: number; top: number; bottom: number;
  plotW: number; plotH: number; ticks: number[]; tickLabels: string[];
}

const sumAt = (chart: ChatChartXY, index: number) => chart.series.reduce((total, s) => total + (s.values[index] ?? 0), 0);

/** A tick value. On an axis that reaches 10,000 every tick is compact, so
 * the scale reads $5K, $10K, $15K rather than $5,000, $10K. */
function tickValue(t: number, unit: string | undefined, compactAxis: boolean): string {
  if (!compactAxis || t === 0 || Math.abs(t) >= 10_000 || Math.abs(t) < 1000) return formatChartValue(t, unit, { compact: true });
  try {
    const currency = unit && unit !== "%" && chartUnitIsInline(unit) ? unit : undefined;
    const text = new Intl.NumberFormat("en-AU", { notation: "compact", maximumSignificantDigits: 3, ...(currency ? { style: "currency", currency } : {}) }).format(t);
    return unit === "%" ? `${text}%` : currency || !unit ? text : `${text} ${unit}`;
  } catch {
    return formatChartValue(t, unit, { compact: true });
  }
}

/** Labels this short read as a sequence (Jan, 2024, W12): thin, don't turn. */
const SHORT_LABEL = 5;

function valueDomain(chart: ChatChartXY): [number, number] {
  if (chart.stacked) return [0, Math.max(0, ...chart.x.map((_, i) => sumAt(chart, i)))];
  const values = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let min = Math.min(...values), max = Math.max(...values);
  const includeZero = chart.type !== "line" || (min >= 0 && min < max * 0.6) || (max <= 0 && max > min * 0.6);
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  return [min, max];
}

const lastIndex = (values: (number | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
};

export function XYPlot({ chart, width, summary }: { chart: ChatChartXY; width: number; summary: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const overlay = useRef<HTMLDivElement>(null);
  const n = chart.x.length;
  const k = chart.series.length;
  const narrow = width < 480;
  const unit = chart.unit;
  const fmt = (v: number) => formatChartValue(v, unit);

  // ---- layout
  const [v0, v1] = valueDomain(chart);
  const integer = chart.series.every((s) => s.values.every((v) => v === null || Number.isInteger(v)));
  const allZero = chart.series.every((s) => s.values.every((v) => v === null || v === 0));
  const wordUnit = !chartUnitIsInline(unit);
  const tickCount = (sideways: boolean) => (sideways ? (narrow ? 3 : 5) : narrow ? 4 : 5);
  // A word unit ("days") is said once: as a caption over a vertical axis, or
  // on the last tick of a sideways one. Money and % ride on every tick.
  const tickText = (ticks: number[], sideways: boolean) => {
    const compactAxis = ticks.some((t) => Math.abs(t) >= 10_000);
    return ticks.map((t, i) => tickValue(t, !wordUnit || (sideways && i === ticks.length - 1) ? unit : undefined, compactAxis));
  };
  const tickW = (labels: string[]) => Math.max(...labels.map((t) => textWidth(t, 11)));

  // Category bars whose names don't fit under them turn sideways, where every
  // name gets its own line. Short sequence labels (months, years, W1) thin out
  // instead, the way a time axis reads.
  const fullLabelW = Math.max(...chart.x.map((x) => textWidth(x, 11)));
  let horizontal = chart.type === "bar" && chart.horizontal;
  if (chart.type === "bar" && !horizontal && n <= CHAT_CHART_LIMITS.horizontalBars && chart.x.some((x) => x.length > SHORT_LABEL)) {
    const guessLeft = Math.max(28, tickW(tickText(niceTicks(v0, v1, tickCount(false), integer), false)) + 10);
    if (fullLabelW + 8 > (width - guessLeft - 12) / n) horizontal = true;
  }
  const caption = wordUnit && !horizontal ? unit : undefined;

  // single-series bars carry their value at the tip: full figures where they
  // fit, compact ($72.8M) where they don't, none where neither fits
  const singleLabels = k === 1 && chart.type === "bar";
  const only = chart.series[0]!.values;
  // the axis caption already says "days", so the bar tips needn't repeat it
  const labelUnit = caption ? undefined : unit;
  const fullValues = only.map((v) => (v === null ? "" : formatChartValue(v, labelUnit)));
  const compactValues = only.map((v) => (v === null ? "" : formatChartValue(v, labelUnit, { compact: true })));
  const widest = (labels: string[]) => Math.max(0, ...labels.map((t) => (t ? textWidth(t, 11) : 0)));
  let valueLabels: string[] | null = null;
  if (singleLabels && horizontal) valueLabels = widest(fullValues) <= width * 0.22 ? fullValues : compactValues;
  const valueLabelW = valueLabels ? widest(valueLabels) : 0;
  const endLabel = k === 1 && chart.type !== "bar";
  const lastValue = endLabel ? only[lastIndex(only)] : null;
  const names = chart.series.map((s) => truncate(s.name, 14));
  let directNames = !horizontal && chart.type !== "bar" && k >= 2 && k <= 4 && width >= 560;

  const layoutFor = (withNames: boolean, ticks: number[], tickLabels: string[]): Layout => {
    const left = horizontal
      ? Math.min(Math.round(width * 0.38), Math.max(...chart.x.map((x) => textWidth(x))) + 12)
      : Math.max(28, tickW(tickLabels) + 10);
    const right = horizontal
      ? (singleLabels ? valueLabelW + 10 : 14) + (narrow ? 0 : 4)
      : endLabel && lastValue != null ? textWidth(fmt(lastValue), 11) + 14
        : withNames ? Math.max(...names.map((name) => textWidth(name))) + 16 : 12;
    const top = (!horizontal && singleLabels && n <= 12 ? 20 : 12) + (caption ? 14 : 0);
    const bottom = horizontal ? 26 : 28;
    const band = horizontal ? (k > 1 && !chart.stacked ? Math.max(24, k * 10 + 10) : 30) : 0;
    const height = horizontal ? top + n * band + bottom : (narrow ? 210 : 250) + (caption ? 14 : 0);
    return { width, height, left, right, top, bottom, plotW: Math.max(40, width - left - right), plotH: height - top - bottom, ticks, tickLabels };
  };
  const scaleFor = (layout: Layout) => {
    const domain: [number, number] = [layout.ticks[0]!, layout.ticks[layout.ticks.length - 1]!];
    return horizontal
      ? linear(domain, [layout.left, layout.left + layout.plotW])
      : linear(domain, [layout.top + layout.plotH, layout.top]);
  };
  const build = (min: number, withNames: boolean) => {
    const ticks = allZero ? [0, 1] : niceTicks(min, v1, tickCount(horizontal), integer);
    return layoutFor(withNames, ticks, tickText(ticks, horizontal));
  };
  let layout = build(v0, directNames);
  if (singleLabels && !horizontal && !allZero && v0 < 0) {
    // room for the value label under the most negative column, so it never
    // reaches the category labels (sideways bars label negatives beside zero)
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = scaleFor(layout);
      const need = 18;
      const room = layout.top + layout.plotH - s(v0);
      if (room >= need) break;
      const perPx = (layout.ticks[layout.ticks.length - 1]! - layout.ticks[0]!) / layout.plotH;
      layout = build(layout.ticks[0]! - (need - room) * perPx * 1.1, directNames);
    }
  }
  const { ticks, tickLabels } = layout;
  const domain: [number, number] = [ticks[0]!, ticks[ticks.length - 1]!];
  if (directNames) {
    // direct labels only when every series ends clearly apart; otherwise the
    // legend and tooltip carry identity (labels pushed apart detach from lines)
    const valueScale = scaleFor(layout);
    const ends = chart.series.map((s) => { const i = lastIndex(s.values); return i < 0 ? null : valueScale(chart.stacked ? chart.series.slice(0, chart.series.indexOf(s) + 1).reduce((t, x) => t + (x.values[i] ?? 0), 0) : s.values[i]!); });
    const sorted = ends.filter((y): y is number => y !== null).sort((a, b) => a - b);
    if (sorted.some((y, i) => i > 0 && y - sorted[i - 1]! < 14)) { directNames = false; layout = layoutFor(false, ticks, tickLabels); }
  }
  const scale = scaleFor(layout);
  const { left, top, plotW, plotH, height } = layout;
  const bandSize = (horizontal ? plotH : plotW) / n;
  const bandStart = (i: number) => (horizontal ? top : left) + bandSize * i;
  const center = (i: number) => bandStart(i) + bandSize / 2;
  const zero = scale(Math.max(domain[0], Math.min(domain[1], 0)));
  if (singleLabels && !horizontal && n <= 12) {
    valueLabels = widest(fullValues) + 6 <= bandSize ? fullValues : widest(compactValues) + 6 <= bandSize ? compactValues : null;
  }

  // ---- interaction
  const move = (to: number) => {
    const next = Math.max(0, Math.min(n - 1, to));
    setFocusIndex(next);
    setActive(next);
    overlay.current?.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)?.focus();
  };
  const onKey = (event: KeyboardEvent, i: number) => {
    const keys: Record<string, number> = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1, PageDown: i + 10, PageUp: i - 10 };
    if (event.key === "Escape") { setActive(null); return; }
    if (!(event.key in keys)) return;
    event.preventDefault();
    move(keys[event.key]!);
  };
  const pointLabel = (i: number) => {
    const values = chart.series.map((s) => (s.values[i] === null ? "no value" : fmt(s.values[i]!)));
    return k === 1 ? `${chart.x[i]}: ${values[0]}` : `${chart.x[i]}: ${chart.series.map((s, j) => `${s.name} ${values[j]}`).join(", ")}`;
  };
  const tooltipRows = (i: number): TooltipRow[] => {
    const rows: TooltipRow[] = chart.series.map((s, j) => ({ name: s.name, value: s.values[i] === null ? "—" : fmt(s.values[i]!), slot: j, mark: "line" }));
    if (chart.stacked && k > 1) rows.push({ name: "Total", value: fmt(sumAt(chart, i)), slot: -1, mark: "none" });
    return rows;
  };

  // ---- marks
  const marks: ReactElement[] = [];
  if (chart.type === "bar") {
    const inner = bandSize * (chart.stacked || k === 1 ? 0.62 : 0.78);
    const groups = chart.stacked ? 1 : k;
    const gap = groups > 1 ? (inner / groups > 6 ? 2 : Math.max(0.5, (inner / groups) * 0.15)) : 0;
    const thick = Math.max(0.5, Math.min(24, (inner - gap * (groups - 1)) / groups));
    const groupW = thick * groups + gap * (groups - 1);
    chart.x.forEach((_, i) => {
      const start = center(i) - groupW / 2;
      if (chart.stacked) {
        let acc = 0;
        const topSeries = chart.series.reduce((last, s, j) => ((s.values[i] ?? 0) > 0 ? j : last), -1);
        chart.series.forEach((s, j) => {
          const v = s.values[i] ?? 0;
          if (v <= 0) return;
          const a = scale(acc);
          let b = scale(acc + v);
          acc += v;
          // 2px surface gap between touching segments
          if (j !== topSeries && Math.abs(b - a) > 4) b += horizontal ? -2 : 2;
          marks.push(<path key={`b${i}-${j}`} d={barPath(start, thick, a, b, horizontal, j === topSeries ? 4 : 0)} className={slot(SERIES_FILL, j)} />);
        });
      } else {
        chart.series.forEach((s, j) => {
          const v = s.values[i];
          if (v === null || v === 0) return;
          marks.push(<path key={`b${i}-${j}`} d={barPath(start + j * (thick + gap), thick, zero, scale(v), horizontal)} className={slot(SERIES_FILL, j)} />);
        });
      }
      if (valueLabels && valueLabels[i]) {
        const v = chart.series[0]!.values[i]!;
        const end = scale(v);
        marks.push(horizontal
          // a negative bar's value sits on the empty side of zero, so it
          // never runs into the names on the left
          ? <text key={`l${i}`} x={(v < 0 ? zero : end) + 6} y={center(i) + 4} className="fill-ink text-[11px] tabular-nums">{valueLabels[i]}</text>
          : <text key={`l${i}`} x={center(i)} y={v < 0 ? end + 14 : end - 6} textAnchor="middle" className="fill-ink text-[11px] tabular-nums">{valueLabels[i]}</text>);
      }
    });
  } else {
    const base = new Array<number>(n).fill(0);
    chart.series.forEach((s, j) => {
      const tops = s.values.map((v, i) => (v === null ? null : chart.stacked ? base[i]! + v : v));
      const bottoms = s.values.map((_, i) => (chart.stacked ? base[i]! : 0));
      // contiguous runs between gaps
      const runs: number[][] = [];
      let run: number[] = [];
      tops.forEach((v, i) => { if (v === null) { if (run.length) runs.push(run); run = []; } else run.push(i); });
      if (run.length) runs.push(run);
      for (const r of runs) {
        const line = r.map((i, idx) => `${idx ? "L" : "M"}${center(i).toFixed(2)},${scale(tops[i]!).toFixed(2)}`).join("");
        if (chart.type === "area") {
          const back = [...r].reverse().map((i) => `L${center(i).toFixed(2)},${scale(bottoms[i]!).toFixed(2)}`).join("");
          marks.push(<path key={`a${j}-${r[0]}`} d={`${line}${back}Z`} className={slot(SERIES_FILL, j)} opacity={chart.stacked ? 0.16 : k > 1 ? 0.07 : 0.1} />);
        }
        if (r.length === 1) marks.push(<circle key={`p${j}-${r[0]}`} cx={center(r[0]!)} cy={scale(tops[r[0]!]!)} r={4} strokeWidth={2} className={`${slot(SERIES_FILL, j)} stroke-sheet`} />);
        else marks.push(<path key={`l${j}-${r[0]}`} d={line} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={slot(SERIES_STROKE, j)} />);
      }
      if (chart.stacked) s.values.forEach((v, i) => { base[i] = base[i]! + (v ?? 0); });
      const last = lastIndex(s.values);
      if (last >= 0) {
        const cx = center(last), cy = scale(tops[last]!);
        marks.push(<circle key={`e${j}`} cx={cx} cy={cy} r={4} strokeWidth={2} className={`${slot(SERIES_FILL, j)} stroke-sheet`} />);
        if (endLabel) marks.push(<text key="end" x={cx + 8} y={cy + 4} className="fill-ink text-[11px] font-medium tabular-nums">{fmt(s.values[last]!)}</text>);
        if (directNames) marks.push(<text key={`n${j}`} x={cx + 8} y={cy + 4} className="fill-ink-secondary text-[12px]">{names[j]}</text>);
      }
    });
    if (active !== null) {
      marks.push(<line key="cross" x1={center(active)} x2={center(active)} y1={top} y2={top + plotH} strokeWidth={1} className="stroke-ink-muted/60" />);
      let acc = 0;
      chart.series.forEach((s, j) => {
        const v = s.values[active];
        if (chart.stacked) acc += v ?? 0;
        if (v === null) return;
        marks.push(<circle key={`m${j}`} cx={center(active)} cy={scale(chart.stacked ? acc : v)} r={4.5} strokeWidth={2} className={`${slot(SERIES_FILL, j)} stroke-sheet`} />);
      });
    }
  }

  // ---- axes
  // all-zero data keeps only its zero line: a $1 tick would invent a scale
  // sideways ticks run along the bottom: when they crowd, label every
  // step-th one counted from zero (the baseline always reads), and let the
  // last labelled one carry a word unit
  const tickStep = horizontal ? labelStep(ticks.length, plotW + (plotW / Math.max(1, ticks.length - 1)), tickW(tickLabels) * 1.5 + 8) : 1;
  const anchor = Math.max(0, ticks.indexOf(0));
  const labelledTick = (i: number) => (i - anchor) % tickStep === 0;
  const lastLabelled = ticks.reduce((last, _, i) => (labelledTick(i) ? i : last), 0);
  const tickMarks = ticks.map((t, i) => {
    if (allZero && t !== 0) return null;
    const p = scale(t);
    const labelled = labelledTick(i);
    const text = horizontal && wordUnit && i === lastLabelled ? formatChartValue(t, unit, { compact: true }) : horizontal && wordUnit ? formatChartValue(t, undefined, { compact: true }) : tickLabels[i];
    return horizontal ? (
      <g key={`t${i}`}>
        <line x1={p} x2={p} y1={top} y2={top + plotH} strokeWidth={1} className={t === 0 ? "stroke-ink-muted/50" : "stroke-line/70"} />
        {labelled && <text x={p} y={top + plotH + 17} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} className="fill-ink-muted text-[11px] tabular-nums">{text}</text>}
      </g>
    ) : (
      <g key={`t${i}`}>
        <line x1={left} x2={left + plotW} y1={p} y2={p} strokeWidth={1} className={t === 0 ? "stroke-ink-muted/50" : "stroke-line/70"} />
        <text x={left - 8} y={p + 4} textAnchor="end" className="fill-ink-muted text-[11px] tabular-nums">{tickLabels[i]}</text>
      </g>
    );
  });
  // Category names: sideways bars fit the left gutter; under vertical marks
  // each name fits its band, or every step-th name shows when they can't.
  let step = 1;
  let shown: string[];
  if (horizontal) shown = chart.x.map((x) => fitText(x, left - 12, 12));
  else if (fullLabelW + 8 <= bandSize) shown = chart.x;
  else {
    const capped = chart.x.map((x) => truncate(x, narrow ? 10 : 14));
    step = labelStep(n, plotW, Math.max(...capped.map((x) => textWidth(x, 11))) + 10);
    shown = capped.map((x) => fitText(x, bandSize * step - 8, 11));
  }
  const categoryLabels = chart.x.map((_, i) => {
    if (i % step !== 0) return null;
    if (horizontal) return <text key={`x${i}`} x={left - 8} y={center(i) + 4} textAnchor="end" className="fill-ink-secondary text-[12px]">{shown[i]}</text>;
    // a wide label at either end stays inside the picture
    const half = textWidth(shown[i]!, 11) / 2;
    const x = Math.max(half + 1, Math.min(width - half - 1, center(i)));
    return <text key={`x${i}`} x={x} y={top + plotH + 18} textAnchor="middle" className="fill-ink-muted text-[11px]">{shown[i]}</text>;
  });
  const notes: ReactElement[] = [];
  if (caption) notes.push(<text key="caption" x={1} y={12} className="fill-ink-muted text-[11px]">{caption}</text>);
  if (allZero) notes.push(<text key="zero" x={left + plotW / 2} y={top + plotH / 2} textAnchor="middle" className="fill-ink-muted text-[12px]">{`Every value is ${fmt(0)}`}</text>);
  const highlight = active !== null && chart.type === "bar"
    ? (horizontal
      ? <rect x={left} y={bandStart(active)} width={plotW} height={bandSize} className="fill-inset" opacity={0.7} />
      : <rect x={bandStart(active)} y={top} width={bandSize} height={plotH} className="fill-inset" opacity={0.7} />)
    : null;

  const tipX = horizontal ? left + plotW / 2 : center(active ?? 0);
  const tipY = horizontal ? bandStart(active ?? 0) + bandSize + 4 : top + 4;
  return (
    <div className="relative" style={{ height }}>
      <div role="img" aria-label={summary} className="absolute inset-0">
        <svg aria-hidden="true" focusable="false" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full">
          {highlight}
          {tickMarks}
          {categoryLabels}
          {notes}
          {marks}
        </svg>
      </div>
      <div ref={overlay} role="group" aria-label={`${chart.title}: data points. Use the arrow keys to move between them.`} className="absolute inset-0" onPointerLeave={() => setActive(null)}>
        {chart.x.map((_, i) => (
          <button
            key={i}
            type="button"
            data-index={i}
            tabIndex={i === focusIndex ? 0 : -1}
            aria-label={pointLabel(i)}
            onFocus={() => { setFocusIndex(i); setActive(i); }}
            onBlur={(event) => { if (!overlay.current?.contains(event.relatedTarget as Node | null)) setActive(null); }}
            onPointerEnter={() => setActive(i)}
            onKeyDown={(event) => onKey(event, i)}
            className="absolute block cursor-default bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-agency"
            style={horizontal
              ? { left, top: bandStart(i), width: plotW, height: bandSize }
              : { left: bandStart(i), top, width: bandSize, height: plotH }}
          />
        ))}
      </div>
      {active !== null && <ChartTooltip title={chart.x[active]!} rows={tooltipRows(active)} x={tipX} y={tipY} width={width} height={height} placement={horizontal ? "below" : "beside"} />}
    </div>
  );
}
