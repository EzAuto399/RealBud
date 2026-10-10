import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatChartBlock, ChartCard, chartSummary } from "./ChatChartBlock";
import { parseChatChart, type ChatChart } from "@shared/chat-chart";
import { barPath, labelStep, niceTicks, truncate } from "./scale";
import { heatBin } from "./HeatmapPlot";

const render = (spec: unknown) => renderToStaticMarkup(createElement(ChatChartBlock, { code: typeof spec === "string" ? spec : JSON.stringify(spec) }));
const chart = (spec: unknown): ChatChart => {
  const parsed = parseChatChart(JSON.stringify(spec));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.chart;
};

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const specs = {
  bar: { type: "bar", title: "Rent collected", unit: "AUD", x: months, series: [{ name: "Collected", values: [41000, 43500, 44200, 39800, 45100, 46000] }], source: "Fictional ledger" },
  grouped: { type: "bar", title: "Repairs by trade", x: ["Plumbing", "Electrical", "Roofing"], series: [{ name: "Open", values: [4, 2, 1] }, { name: "Closed", values: [9, 5, 3] }] },
  horizontal: { type: "bar", title: "Days vacant", unit: "days", horizontal: true, stacked: true, x: ["14 Fictional St", "9 Sample Ln"], series: [{ name: "Listed", values: [12, 4] }, { name: "Leased", values: [3, 0] }] },
  line: { type: "line", title: "Vacancy rate", unit: "%", x: months, series: [{ name: "Vacancy", values: [2.1, 2.3, null, 1.9, 1.8, 1.6] }] },
  multiLine: { type: "line", title: "Arrears vs due", unit: "AUD", x: months, series: [{ name: "Arrears", values: [1, 2, 3, 4, 5, 6] }, { name: "Due", values: [9, 9, 9, 9, 9, 9] }] },
  area: { type: "area", title: "Bond lodged", stacked: true, x: months, series: [{ name: "NSW", values: [1, 2, 3, 4, 5, 6] }, { name: "VIC", values: [2, 2, 2, 2, 2, 2] }] },
  stats: { type: "stats", title: "This week", stats: [{ label: "Open repairs", value: 7 }, { label: "Arrears", value: 1850, note: "3 tenancies" }, { label: "Status", value: "On track" }], unit: "AUD" },
  heatmap: { type: "heatmap", title: "Enquiries by hour", rows: ["Mon", "Tue"], cols: ["9am", "10am", "11am"], cells: [[1, 4, null], [0, 6, 3]] },
};

describe("chat chart rendering", () => {
  it("draws a valid chart of every type with a title, picture summary and table toggle", () => {
    for (const [name, spec] of Object.entries(specs)) {
      const html = render(spec);
      expect(html, name).toContain(`aria-label="${spec.title}"`);
      expect(html, name).not.toContain("couldn’t be drawn");
      if (name === "stats") {
        expect(html).toContain("<dl");
        expect(html).toContain("$1,850");
        expect(html).toContain("On track");
        expect(html).not.toContain("Show as table");
        continue;
      }
      expect(html, name).toContain('role="img"');
      expect(html, name).toContain("<svg");
      expect(html, name).toContain("Show as table");
      expect(html, name).toMatch(/role="group" aria-label="[^"]+Use the arrow keys/);
    }
  });

  it("formats currency ticks and names every point for the keyboard", () => {
    const html = render(specs.bar);
    expect(html).toContain('aria-label="Jan: $41,000"');
    expect(html).toContain("$50K");
    expect(html).toContain("Source: Fictional ledger");
    // one roving tab stop, the rest reachable by arrow keys
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html.match(/tabindex="-1"/g)?.length).toBe(5);
  });

  it("shows a legend for two or more series only", () => {
    expect(render(specs.grouped)).toContain('aria-label="Legend"');
    expect(render(specs.bar)).not.toContain('aria-label="Legend"');
    expect(render(specs.grouped)).toContain('aria-label="Plumbing: Open 4, Closed 9"');
  });

  it("marks a gap as no value rather than zero", () => {
    expect(render(specs.line)).toContain('aria-label="Mar: no value"');
    expect(render(specs.heatmap)).toContain('aria-label="Mon, 11am: no value"');
    expect(render(specs.heatmap)).toContain("No value");
  });

  it("summarises the picture for screen readers", () => {
    expect(chartSummary(chart(specs.multiLine))).toBe("Line chart: Arrears vs due. 6 points for 2 series: Arrears, Due. Values from $1 to $9. Show as table lists every value.");
    expect(chartSummary(chart(specs.heatmap))).toContain("2 rows by 3 columns");
  });

  it("escapes chart text instead of interpreting it", () => {
    const html = render({ ...specs.bar, title: "<img src=x onerror=alert(1)>", x: ["<script>", "b", "c", "d", "e", "f"] });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to a table of what could be read, or a note with the raw data", () => {
    const partial = render({ ...specs.bar, type: "pie" });
    expect(partial).toContain("This chart couldn’t be drawn");
    expect(partial).toContain("<table");
    expect(partial).toContain("$41,000");
    expect(partial).toContain("Show data");

    const broken = render('{"type":"bar","title":"Cut off');
    expect(broken).toContain("This chart couldn’t be drawn");
    expect(broken).toContain("The chart data isn&#x27;t complete.");
    expect(broken).not.toContain("<table");
    expect(broken).toContain("<details");
    expect(broken).toContain("Cut off");
  });

  it("never throws while rendering hundreds of random and mutated specs", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const numbers = [0, -5, 3.25, 1e15, -1e15, null, 1e-9, 42];
    const all = Object.values(specs) as Array<Record<string, unknown>>;
    for (let i = 0; i < 520; i++) {
      const spec = JSON.parse(JSON.stringify(pick(all))) as Record<string, any>;
      const roll = random();
      if (Array.isArray(spec.series)) {
        const length = 1 + Math.floor(random() * (roll < 0.1 ? 200 : 12));
        spec.x = Array.from({ length }, (_, j) => (random() < 0.1 ? "x".repeat(60) : `P${j}`));
        spec.series = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, s) => ({ name: `S${s}`, values: Array.from({ length }, () => pick(numbers)) }));
        if (random() < 0.3) spec.stacked = random() < 0.5;
        if (spec.type === "bar" && random() < 0.3) spec.horizontal = true;
        if (random() < 0.1) spec.series[0].values.pop();
      } else if (Array.isArray(spec.cells)) {
        const rows = 1 + Math.floor(random() * 31), cols = 1 + Math.floor(random() * 24);
        spec.rows = Array.from({ length: rows }, (_, j) => `R${j}`);
        spec.cols = Array.from({ length: cols }, (_, j) => `C${j}`);
        spec.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => pick(numbers)));
      } else if (random() < 0.5) {
        spec.stats = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, j) => ({ label: `L${j}`, value: random() < 0.5 ? pick(numbers) : "x".repeat(24) }));
      }
      if (random() < 0.15) spec.unit = pick(["AUD", "%", "days", "", "ZZZ"]);
      let code = JSON.stringify(spec);
      if (random() < 0.1) code = code.slice(0, Math.floor(random() * code.length));
      expect(() => render(code)).not.toThrow();
    }
  });

  it("turns category bars sideways when their names don't fit under them, but thins short sequence labels", () => {
    const names = Array.from({ length: 9 }, (_, i) => `${i + 1} Fictional Street`);
    const sideways = render({ type: "bar", title: "Rent by property", unit: "AUD", x: names, series: [{ name: "Rent", values: names.map((_, i) => 400 + i * 10) }] });
    // every name drawn, each with its value at the bar tip
    for (const name of names) expect(sideways).toContain(`>${name}</text>`);
    expect(sideways).toContain(">$480</text>");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const thinned = render({ type: "bar", title: "Days", x: [...months, ...months, ...months], series: [{ name: "Days", values: Array(36).fill(3) }] });
    expect(sideways).toContain('text-anchor="end" class="fill-ink-secondary');
    expect(thinned).not.toContain('text-anchor="end" class="fill-ink-secondary');
    expect(thinned.match(/>(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)<\/text>/g)?.length ?? 0).toBeLessThan(36);
  });

  it("says a word unit once as an axis caption and keeps it off the bar tips", () => {
    const html = render({ type: "bar", title: "Jobs", unit: "jobs", x: ["Mon", "Tue"], series: [{ name: "Jobs", values: [4, 7] }] });
    expect(html).toContain(">jobs</text>");
    expect(html).toContain(">7</text>");
    expect(html).not.toContain(">7 jobs</text>");
    // the keyboard and table still carry the unit
    expect(html).toContain('aria-label="Tue: 7 jobs"');
  });

  it("draws an all-zero chart as a zero line with a note, not an invented scale", () => {
    const html = render({ type: "bar", title: "Arrears", unit: "AUD", x: ["Jan", "Feb"], series: [{ name: "Arrears", values: [0, 0] }] });
    expect(html).toContain("Every value is $0");
    expect(html).not.toContain(">$1</text>");
  });

  it("names the single value of a flat heat map instead of a scale from it to itself", () => {
    const html = render({ type: "heatmap", title: "Slots", rows: ["Mon"], cols: ["9am", "10am"], cells: [[2, 2]] });
    expect(html).toContain("Every cell is 2");
  });

  it("keeps figures whole: one figure spans the card and millions read compact", () => {
    const one = render({ type: "stats", title: "Today", unit: "AUD", stats: [{ label: "Portfolio", value: 72800000 }] });
    expect(one).toContain("grid-cols-1");
    expect(one).toContain("$72.8M");
    expect(one).toContain("whitespace-nowrap");
  });

  it("renders a card directly for a parsed chart", () => {
    expect(renderToStaticMarkup(createElement(ChartCard, { chart: chart(specs.area) }))).toContain("Area chart: Bond lodged");
  });
});

describe("chart geometry", () => {
  it("picks round ticks that cover the data", () => {
    expect(niceTicks(0, 46000, 5)).toEqual([0, 10000, 20000, 30000, 40000, 50000]);
    expect(niceTicks(-3, 7, 5)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(5, 5, 4)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0, 0, 4)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN, 1, 4)).toEqual([0, 1]);
  });

  it("thins labels so they never overlap", () => {
    expect(labelStep(200, 300, 30)).toBe(20);
    expect(labelStep(6, 600, 40)).toBe(1);
    expect(truncate("14 Fictional Street, Sampletown", 14)).toBe("14 Fictional…");
  });

  it("rounds only the data end of a bar", () => {
    expect(barPath(10, 20, 100, 40, false)).toBe("M10,100L10,44Q10,40 14,40L26,40Q30,40 30,44L30,100Z");
    expect(barPath(10, 20, 0, 60, true)).toBe("M0,10L56,10Q60,10 60,14L60,26Q60,30 56,30L0,30Z");
  });

  it("bins heat values light to dark", () => {
    expect(heatBin(0, 0, 10)).toBe(0);
    expect(heatBin(10, 0, 10)).toBe(6);
    expect(heatBin(5, 5, 5)).toBe(3);
  });
});
