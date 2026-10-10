// One tooltip for every chart: value first (strong), series name second, a
// short line key in the series colour. Purely visual (aria-hidden): the
// focused point's accessible name already carries the same values.
import { SERIES_BG, slot } from "./palette";
import { textWidth } from "./scale";

export interface TooltipRow { name: string; value: string; slot: number; mark: "line" | "none" }

export function ChartTooltip({ title, rows, x, y, width, height, placement }: {
  title: string;
  rows: TooltipRow[];
  x: number;
  y: number;
  width: number;
  height: number;
  placement: "beside" | "below";
}) {
  const estimate = Math.min(280, Math.max(textWidth(title, 12), ...rows.map((row) => textWidth(row.value, 13) + textWidth(row.name, 12) + 34)) + 28);
  const w = Math.min(estimate, Math.max(120, width - 8));
  let left: number;
  if (placement === "beside") left = x + 12 + w <= width - 4 ? x + 12 : x - 12 - w;
  else left = x - w / 2;
  left = Math.max(4, Math.min(width - w - 4, left));
  const rowsHeight = 26 + rows.length * 20;
  const top = placement === "below" && y + rowsHeight > height ? Math.max(0, y - rowsHeight - 36) : y;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 rounded border border-line bg-sheet px-2.5 py-2 text-[12px] leading-snug text-ink transition-opacity duration-100 motion-reduce:transition-none"
      style={{ left, top, width: w }}
    >
      <p className="truncate text-ink-secondary">{title}</p>
      <div className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <div key={`${row.slot}-${row.name}`} className="flex min-w-0 items-center gap-2">
            {row.mark === "none"
              ? <span className="inline-block w-3 shrink-0" />
              : <span className={`inline-block h-0.5 w-3 shrink-0 rounded-full ${slot(SERIES_BG, row.slot)}`} />}
            <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">{row.value}</span>
            <span className="min-w-0 truncate text-ink-secondary">{row.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
