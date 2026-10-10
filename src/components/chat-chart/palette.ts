// Literal class names so Tailwind generates each token utility. Categorical
// slots follow series order (never rank) and never cycle: the parser caps a
// chart at eight series, the number of validated slots in src/styles.css.
export const SERIES_FILL = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4", "fill-chart-5", "fill-chart-6", "fill-chart-7", "fill-chart-8"] as const;
export const SERIES_STROKE = ["stroke-chart-1", "stroke-chart-2", "stroke-chart-3", "stroke-chart-4", "stroke-chart-5", "stroke-chart-6", "stroke-chart-7", "stroke-chart-8"] as const;
export const SERIES_BG = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6", "bg-chart-7", "bg-chart-8"] as const;
/** Sequential blue, light (low) to dark (high), for heat maps. */
export const SEQUENTIAL_FILL = ["fill-chart-seq-1", "fill-chart-seq-2", "fill-chart-seq-3", "fill-chart-seq-4", "fill-chart-seq-5", "fill-chart-seq-6", "fill-chart-seq-7"] as const;
export const SEQUENTIAL_BG = ["bg-chart-seq-1", "bg-chart-seq-2", "bg-chart-seq-3", "bg-chart-seq-4", "bg-chart-seq-5", "bg-chart-seq-6", "bg-chart-seq-7"] as const;

export const slot = <T>(list: readonly T[], index: number): T => list[Math.max(0, Math.min(list.length - 1, index))]!;
