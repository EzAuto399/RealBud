// A ```chart block in a Bud reply, drawn as a card. Loaded lazily from
// ChatMarkdown so screens without charts never download it. The block text is
// model output: it is parsed by shared/chat-chart.ts (JSON only, strict
// limits) and rendered as React elements, never as HTML or script. Anything
// that cannot be drawn becomes a table of what could be read, or a short note
// with the raw data behind "Show data"; a render crash falls back the same way
// so the rest of the message keeps its formatting.
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart3, Info, Table2 } from "lucide-react";
import {
  chartToTable,
  formatChartValue,
  parseChatChart,
  type ChatChart,
  type ChatChartStats,
  type ChatChartTable,
} from "@shared/chat-chart";
import { SERIES_BG, slot } from "./palette";
import { XYPlot } from "./XYPlot";
import { HeatmapPlot } from "./HeatmapPlot";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const RAW_SHOWN = 20_000;
const DEFAULT_WIDTH = 600;

/** Content width of the element, following resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const next = Math.floor(element.clientWidth);
      if (next > 0) setWidth((previous) => (previous === next ? previous : next));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

const KIND: Record<ChatChart["type"], string> = { bar: "Bar chart", line: "Line chart", area: "Area chart", stats: "Figures", heatmap: "Heat map" };

/** What a screen reader hears for the picture; every value is in the table. */
export function chartSummary(chart: ChatChart): string {
  if (chart.type === "stats") return `${KIND.stats}: ${chart.title}.`;
  const values = chart.type === "heatmap"
    ? chart.cells.flat().filter((v): v is number => v !== null)
    : chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const range = values.length ? ` Values from ${formatChartValue(Math.min(...values), chart.unit)} to ${formatChartValue(Math.max(...values), chart.unit)}.` : "";
  const shape = chart.type === "heatmap"
    ? ` ${chart.rows.length} rows by ${chart.cols.length} columns.`
    : ` ${chart.x.length} ${chart.x.length === 1 ? "point" : "points"}${chart.series.length > 1 ? ` for ${chart.series.length} series: ${chart.series.map((s) => s.name).join(", ")}` : ""}.`;
  return `${KIND[chart.type]}: ${chart.title}.${shape}${range} Show as table lists every value.`;
}

export function ChartTable({ table, label }: { table: ChatChartTable; label: string }) {
  return (
    // long tables scroll inside the card rather than stretching the reply
    <div className="chat-table-scroll mx-4 mb-3 max-h-96 overflow-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full border-collapse text-[13.5px]">
        <caption className="sr-only">{table.title ?? label}</caption>
        <thead>
          <tr>
            {table.columns.map((column, index) => (
              <th key={index} scope="col" className={`sticky top-0 border-b border-line bg-sheet px-2 py-1.5 font-semibold ${index ? "text-right" : "text-left"}`}>
                {column || <span className="sr-only">Label</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (c === 0
                ? <td key={c} className="min-w-0! border-b border-line/60 px-2 py-1.5 text-left font-medium">{cell}</td>
                : <td key={c} className="min-w-0! whitespace-nowrap border-b border-line/60 px-2 py-1.5 text-right tabular-nums">{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawData({ raw }: { raw: string }) {
  const shown = raw.length > RAW_SHOWN ? `${raw.slice(0, RAW_SHOWN)}\n… (shortened)` : raw;
  return (
    <details className="px-4 pb-3">
      <summary className="flex min-h-10 cursor-pointer items-center text-[13px] text-ink-secondary hover:text-ink">Show data</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-3 text-[12px] leading-relaxed text-ink">{shown || "(empty)"}</pre>
    </details>
  );
}

export function ChartFallback({ reason, partial, raw }: { reason: string; partial?: ChatChartTable; raw: string }) {
  return (
    <div className="chat-chart-fallback my-2 min-w-0 overflow-hidden rounded-lg border border-line bg-sheet" role="group" aria-label={partial?.title ? `${partial.title} (chart data)` : "Chart data"}>
      <div className="flex items-start gap-2 px-4 pb-2 pt-3">
        <Info size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">This chart couldn’t be drawn</p>
          <p className="text-[13px] text-ink-muted">{reason}{partial ? " Here is the data that could be read." : ""}</p>
        </div>
      </div>
      {partial && <ChartTable table={partial} label={partial.title ? `${partial.title} data` : "Chart data"} />}
      <RawData raw={raw} />
    </div>
  );
}

class ChartRenderBoundary extends Component<{ chart: ChatChart; raw: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    let partial: ChatChartTable | undefined;
    try { partial = chartToTable(this.props.chart); } catch { partial = undefined; }
    return <ChartFallback reason="Something went wrong while drawing it." partial={partial} raw={this.props.raw} />;
  }
}

// Figures this large read as $72.8M; anything smaller keeps every digit.
const STAT_COMPACT = 1_000_000;

function Stats({ chart }: { chart: ChatChartStats }) {
  const count = chart.stats.length;
  // one figure spans the card; columns follow the card's own width
  const columns = count === 1 ? "grid-cols-1" : count === 2 || count === 4 ? "grid-cols-2" : "grid-cols-2 @min-[30rem]:grid-cols-3";
  return (
    <dl className={`grid ${columns} gap-x-4 gap-y-3 px-4 pb-3 pt-1`}>
      {chart.stats.map((stat, index) => (
        <div key={index} className="min-w-0 border-l-2 border-line pl-3">
          <dt className="text-[13px] leading-snug text-ink-muted">{stat.label}</dt>
          {typeof stat.value === "number"
            // a number never breaks across lines
            ? <dd className="mt-0.5 whitespace-nowrap text-[19px] font-semibold leading-tight text-ink @min-[30rem]:text-[22px]">{formatChartValue(stat.value, chart.unit, { compact: Math.abs(stat.value) >= STAT_COMPACT })}</dd>
            : <dd className="mt-0.5 break-words text-[19px] font-semibold leading-tight text-ink @min-[30rem]:text-[22px]">{stat.value}</dd>}
          {stat.note && <dd className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">{stat.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Legend({ chart }: { chart: ChatChart }) {
  if (chart.type === "stats" || chart.type === "heatmap" || chart.series.length < 2) return null;
  const line = chart.type === "line";
  return (
    // divs with list roles: the reply's own list styles must not reach the legend
    <div role="list" aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 text-[13px] text-ink-secondary">
      {chart.series.map((s, index) => (
        <div role="listitem" key={index} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block shrink-0 ${line ? "h-0.5 w-3.5 rounded-full" : "h-2.5 w-2.5 rounded-[2px]"} ${slot(SERIES_BG, index)}`} />
          <span className="min-w-0 break-words">{s.name}</span>
        </div>
      ))}
    </div>
  );
}

function Plot({ chart }: { chart: Exclude<ChatChart, ChatChartStats> }) {
  const { ref, width } = useWidth();
  return (
    <div className="min-w-0 px-2 pb-2 pt-2">
      <div ref={ref} className="min-w-0">
        {chart.type === "heatmap" ? <HeatmapPlot chart={chart} width={width} summary={chartSummary(chart)} /> : <XYPlot chart={chart} width={width} summary={chartSummary(chart)} />}
      </div>
    </div>
  );
}

export function ChartCard({ chart }: { chart: ChatChart }) {
  const [table, setTable] = useState(false);
  const data = useMemo(() => chartToTable(chart), [chart]);
  const stats = chart.type === "stats";
  return (
    <figure className="chat-chart @container my-2 min-w-0 overflow-hidden rounded-lg border border-line bg-sheet" aria-label={chart.title}>
      <div className="flex items-start justify-between gap-3 pl-4 pr-2 pt-2.5">
        <figcaption className="min-w-0 pb-1 pt-1">
          <span className="block text-[15px] font-semibold leading-snug text-ink">{chart.title}</span>
          {chart.subtitle && <span className="mt-0.5 block text-[13px] leading-snug text-ink-muted">{chart.subtitle}</span>}
        </figcaption>
        {!stats && (
          <button
            type="button"
            onClick={() => setTable(!table)}
            aria-label={table ? "Show chart" : "Show as table"}
            className="flex min-h-10 shrink-0 items-center gap-1.5 rounded px-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {table ? <BarChart3 size={14} aria-hidden /> : <Table2 size={14} aria-hidden />}
            {/* a narrow card keeps the short word so the title gets the room */}
            <span className="@min-[30rem]:hidden">{table ? "Chart" : "Table"}</span>
            <span className="hidden @min-[30rem]:inline">{table ? "Show chart" : "Show as table"}</span>
          </button>
        )}
      </div>
      {stats ? <Stats chart={chart} /> : table ? <ChartTable table={data} label={`${chart.title} data`} /> : <><Legend chart={chart} /><Plot chart={chart} /></>}
      {chart.source && <p className="border-t border-line/60 px-4 py-2 text-[12px] text-ink-muted">Source: {chart.source}</p>}
    </figure>
  );
}

/** Entry point used by ChatMarkdown for one settled ```chart block. */
export function ChatChartBlock({ code }: { code: string }) {
  const parsed = useMemo(() => parseChatChart(code), [code]);
  if (!parsed.ok) return <ChartFallback reason={parsed.reason} partial={parsed.partial} raw={code} />;
  return (
    <ChartRenderBoundary key={code} chart={parsed.chart} raw={code}>
      <ChartCard chart={parsed.chart} />
    </ChartRenderBoundary>
  );
}

export default ChatChartBlock;
