// A grid of values in one sequential blue (light = low, dark = high), seven
// steps with a scale key. Empty cells stay in the inset paper colour. Each
// cell is a real button in a roving tab stop: arrows move in two dimensions.
import { useRef, useState, type KeyboardEvent } from "react";
import { formatChartValue, type ChatChartHeatmap } from "@shared/chat-chart";
import { SEQUENTIAL_BG, SEQUENTIAL_FILL, slot } from "./palette";
import { fitText, labelStep, textWidth, truncate } from "./scale";
import { ChartTooltip } from "./ChartTooltip";

const STEPS = SEQUENTIAL_FILL.length;

export function heatBin(value: number, min: number, max: number): number {
  if (!(max > min)) return Math.floor(STEPS / 2);
  return Math.max(0, Math.min(STEPS - 1, Math.floor(((value - min) / (max - min)) * STEPS)));
}

export function HeatmapPlot({ chart, width, summary }: { chart: ChatChartHeatmap; width: number; summary: string }) {
  const [active, setActive] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const overlay = useRef<HTMLDivElement>(null);
  const rows = chart.rows.length, cols = chart.cols.length;
  const narrow = width < 480;
  const values = chart.cells.flat().filter((v): v is number => v !== null);
  const min = Math.min(...values), max = Math.max(...values);
  const fmt = (v: number | null) => (v === null ? "no value" : formatChartValue(v, chart.unit));

  const capped = chart.rows.map((r) => truncate(r, narrow ? 10 : 16));
  const left = Math.min(Math.round(width * 0.3), Math.max(...capped.map((r) => textWidth(r))) + 12);
  const rowNames = capped.map((r) => fitText(r, left - 12, 12));
  const available = Math.max(40, width - left - 8);
  const cellW = Math.min(36, available / cols);
  const cellH = Math.max(18, Math.min(28, cellW));
  const gap = cellW >= 10 ? 2 : 1;
  const colNames = chart.cols.map((c) => truncate(c, cellW >= 30 ? 6 : 4));
  const step = labelStep(cols, cols * cellW, Math.max(...colNames.map((c) => textWidth(c, 11))) + 6);
  const top = 20;
  const height = top + rows * cellH + 4;
  const gridW = cols * cellW;

  const move = (r: number, c: number) => {
    const next: [number, number] = [Math.max(0, Math.min(rows - 1, r)), Math.max(0, Math.min(cols - 1, c))];
    setFocus(next);
    setActive(next);
    overlay.current?.querySelector<HTMLButtonElement>(`[data-cell="${next[0]}-${next[1]}"]`)?.focus();
  };
  const onKey = (event: KeyboardEvent, r: number, c: number) => {
    const moves: Record<string, [number, number]> = {
      ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c],
      Home: [r, 0], End: [r, cols - 1], PageUp: [0, c], PageDown: [rows - 1, c],
    };
    if (event.key === "Escape") { setActive(null); return; }
    const to = moves[event.key];
    if (!to) return;
    event.preventDefault();
    move(to[0], to[1]);
  };

  return (
    <div>
      <div className="relative" style={{ height }}>
        <div role="img" aria-label={summary} className="absolute inset-0">
        <svg aria-hidden="true" focusable="false" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full">
          {chart.cols.map((_, c) => (c % step === 0
            ? <text key={`c${c}`} x={left + c * cellW + cellW / 2} y={13} textAnchor="middle" className="fill-ink-muted text-[11px]">{colNames[c]}</text>
            : null))}
          {chart.rows.map((_, r) => (
            <text key={`r${r}`} x={left - 8} y={top + r * cellH + cellH / 2 + 4} textAnchor="end" className="fill-ink-secondary text-[12px]">{rowNames[r]}</text>
          ))}
          {chart.cells.map((row, r) => row.map((v, c) => (
            <rect
              key={`${r}-${c}`}
              x={left + c * cellW + gap / 2}
              y={top + r * cellH + gap / 2}
              width={Math.max(0.5, cellW - gap)}
              height={Math.max(0.5, cellH - gap)}
              rx={cellW >= 12 ? 2 : 0}
              className={v === null ? "fill-inset" : slot(SEQUENTIAL_FILL, heatBin(v, min, max))}
            />
          )))}
          {active && (
            <rect x={left + active[1] * cellW + gap / 2} y={top + active[0] * cellH + gap / 2} width={Math.max(0.5, cellW - gap)} height={Math.max(0.5, cellH - gap)} rx={cellW >= 12 ? 2 : 0} fill="none" strokeWidth={2} className="stroke-ink" />
          )}
        </svg>
        </div>
        <div ref={overlay} role="group" aria-label={`${chart.title}: grid cells. Use the arrow keys to move between them.`} className="absolute inset-0" onPointerLeave={() => setActive(null)}>
          {chart.cells.map((row, r) => row.map((v, c) => (
            <button
              key={`${r}-${c}`}
              type="button"
              data-cell={`${r}-${c}`}
              tabIndex={focus[0] === r && focus[1] === c ? 0 : -1}
              aria-label={`${chart.rows[r]}, ${chart.cols[c]}: ${fmt(v)}`}
              onFocus={() => { setFocus([r, c]); setActive([r, c]); }}
              onBlur={(event) => { if (!overlay.current?.contains(event.relatedTarget as Node | null)) setActive(null); }}
              onPointerEnter={() => setActive([r, c])}
              onKeyDown={(event) => onKey(event, r, c)}
              className="absolute block cursor-default bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-agency"
              style={{ left: left + c * cellW, top: top + r * cellH, width: cellW, height: cellH }}
            />
          )))}
        </div>
        {active && (
          <ChartTooltip
            title={`${chart.rows[active[0]]} · ${chart.cols[active[1]]}`}
            rows={[{ name: "", value: fmt(chart.cells[active[0]]![active[1]]!), slot: 0, mark: "none" }]}
            x={left + active[1] * cellW + cellW / 2}
            y={top + active[0] * cellH + cellH + 4}
            width={width}
            height={height}
            placement="below"
          />
        )}
      </div>
      {max > min ? (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-muted" style={{ marginLeft: left, maxWidth: Math.max(160, gridW) }}>
          <span className="tabular-nums">{formatChartValue(min, chart.unit, { compact: true })}</span>
          <span className="flex flex-1 gap-0.5" aria-hidden="true">
            {SEQUENTIAL_BG.map((cls) => <span key={cls} className={`h-2 flex-1 rounded-[1px] ${cls}`} />)}
          </span>
          <span className="tabular-nums">{formatChartValue(max, chart.unit, { compact: true })}</span>
        </div>
      ) : (
        // one value everywhere: a scale from 2 to 2 says nothing
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-muted" style={{ marginLeft: left }}>
          <span className={`inline-block h-2 w-3 rounded-[1px] ${slot(SEQUENTIAL_BG, heatBin(min, min, max))}`} aria-hidden="true" />
          Every cell is {fmt(min)}
        </p>
      )}
      {values.length < rows * cols && (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-muted" style={{ marginLeft: left }}>
          <span className="inline-block h-2 w-3 rounded-[1px] bg-inset" aria-hidden="true" />No value
        </p>
      )}
    </div>
  );
}
