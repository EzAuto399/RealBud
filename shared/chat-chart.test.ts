import { describe, expect, it } from "vitest";
import {
  CHAT_CHART_LIMITS,
  chartBlockText,
  chartToText,
  formatChartValue,
  parseChatChart,
  replaceChartBlocksWithText,
} from "./chat-chart.ts";

const bar = {
  type: "bar",
  title: "Arrears by property",
  unit: "AUD",
  x: ["14 Fictional St", "9 Sample Ln", "28 Example Ave"],
  series: [{ name: "Arrears", values: [1200, 450, 0] }],
  source: "Fictional ledger, 6 Oct 2026",
};
const json = (value: unknown) => JSON.stringify(value);

describe("parseChatChart", () => {
  it("accepts each chart type in the documented shape", () => {
    const cases: unknown[] = [
      bar,
      { type: "bar", title: "Stacked", x: ["A", "B"], series: [{ name: "Paid", values: [1, 2] }, { name: "Owing", values: [3, null] }], stacked: true, horizontal: true },
      { type: "line", title: "Vacancy rate", unit: "%", x: [2023, 2024, 2025], series: [{ name: "Vacancy", values: [2.1, null, 1.8] }] },
      { type: "area", title: "Collected", series: [{ name: "Collected", values: [5, 6, 7] }], stacked: false },
      { type: "stats", title: "This week", stats: [{ label: "Open repairs", value: 7 }, { label: "Oldest", value: "12 days", note: "Unit 4" }] },
      { type: "heatmap", title: "Enquiries", rows: ["Mon", "Tue"], cols: ["9am", "10am", "11am"], cells: [[1, 2, null], [0, 5, 3]] },
    ];
    for (const spec of cases) {
      const parsed = parseChatChart(json(spec));
      expect(parsed.ok, json(spec)).toBe(true);
    }
    const line = parseChatChart(json(cases[2]));
    expect(line.ok && line.chart.type === "line" && line.chart.x).toEqual(["2023", "2024", "2025"]);
    const area = parseChatChart(json(cases[3]));
    expect(area.ok && area.chart.type === "area" && area.chart.x).toEqual(["1", "2", "3"]);
  });

  const invalid: Array<[string, string, RegExp, boolean]> = [
    ["bad JSON", '{"type":"bar", "title":', /isn't complete/, false],
    ["not an object", "[1,2,3]", /isn't a chart description/, false],
    ["unknown type", json({ ...bar, type: "pie" }), /type isn't one/, true],
    ["Infinity via overflow", '{"type":"bar","title":"T","x":["a"],"series":[{"name":"s","values":[1e999]}]}', /number or empty/, false],
    ["text where a number goes", json({ ...bar, series: [{ name: "s", values: ["12", 3, 4] }] }), /number or empty/, true],
    ["too many points", json({ type: "line", title: "T", series: [{ name: "s", values: Array.from({ length: 201 }, (_, i) => i) }] }), /more than 200 values/, true],
    ["too many series", json({ type: "line", title: "T", x: ["a"], series: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [i] })) }), /more than 8 series/, true],
    ["mismatched labels", json({ ...bar, x: ["a", "b"] }), /2 labels but 3 values/, true],
    ["mismatched series", json({ ...bar, series: [{ name: "a", values: [1, 2, 3] }, { name: "b", values: [1] }] }), /different numbers of values/, true],
    ["stacked negative", json({ ...bar, stacked: true, series: [{ name: "s", values: [1, -2, 3] }] }), /below zero/, true],
    ["no values at all", json({ ...bar, series: [{ name: "s", values: [null, null, null] }] }), /no values/, false],
    ["long label", json({ ...bar, x: ["x".repeat(61), "b", "c"] }), /longer than 60/, true],
    ["too many stats", json({ type: "stats", title: "T", stats: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: i })) }), /more than 12 figures/, true],
    ["ragged heatmap", json({ type: "heatmap", title: "T", cells: [[1, 2], [3]] }), /different lengths/, true],
    ["oversized heatmap", json({ type: "heatmap", title: "T", cells: Array.from({ length: 31 }, () => Array.from({ length: 31 }, () => 1)) }), /more than 744 cells/, true],
    ["nested garbage", json({ type: "bar", title: "T", series: [{ name: { deep: [1] }, values: [[1]] }] }), /must be text/, false],
    ["huge block", json({ ...bar, subtitle: "x".repeat(CHAT_CHART_LIMITS.bytes) }), /too large/, false],
    ["empty", "   ", /no data/, false],
  ];
  for (const [name, source, reason, salvageable] of invalid) {
    it(`falls back for ${name}`, () => {
      const parsed = parseChatChart(source);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toMatch(reason);
      expect(Boolean(parsed.partial)).toBe(salvageable);
    });
  }

  it("ignores fields a chart doesn't use and still draws", () => {
    const extra = parseChatChart(json({ ...bar, color: "red", token: "x", series: [{ name: "s", values: [1, 2, 3], colour: "blue" }] }));
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    expect(JSON.stringify(extra.chart)).not.toMatch(/red|blue|token/);
    const line = parseChatChart(json({ type: "line", title: "T", stacked: true, horizontal: true, series: [{ name: "s", values: [1, 2] }] }));
    expect(line.ok && line.chart.type === "line" && !line.chart.stacked && !line.chart.horizontal).toBe(true);
  });

  it("keeps small decimals precise and money in cents", () => {
    expect(formatChartValue(0.012)).toBe("0.012");
    expect(formatChartValue(0.0345, "%")).toBe("0.0345%");
    expect(formatChartValue(0.5, "days")).toBe("0.5 days");
    expect(formatChartValue(0.25, "AUD")).toBe("$0.25");
    expect(formatChartValue(12.345)).toBe("12.35");
  });

  it("accepts a descriptive unit such as AUD (thousands)", () => {
    const parsed = parseChatChart(json({ ...bar, unit: "AUD (thousands)" }));
    expect(parsed.ok && parsed.chart.unit).toBe("AUD (thousands)");
    expect(parseChatChart(json({ ...bar, unit: "x".repeat(25) })).ok).toBe(false);
  });

  it("draws a chart with no title under a plain default", () => {
    const stats = parseChatChart(json({ type: "stats", stats: [{ label: "Open repairs", value: 9 }] }));
    expect(stats.ok && stats.chart.title).toBe("Key figures");
    const untitled = parseChatChart(json({ ...bar, title: "  " }));
    expect(untitled.ok && untitled.chart.title).toBe("Chart");
    expect(parseChatChart(json({ ...bar, title: 42 })).ok).toBe(false);
  });

  it("salvages a readable table from a chart it cannot draw", () => {
    const parsed = parseChatChart(json({ ...bar, type: "pie" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.partial).toEqual({
      title: "Arrears by property",
      columns: ["", "Arrears"],
      rows: [["14 Fictional St", "$1,200"], ["9 Sample Ln", "$450"], ["28 Example Ave", "$0"]],
    });
  });

  it("never throws on hundreds of random and mutated specs", () => {
    let seed = 20261006;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
    const atoms = [null, true, 0, -1, 1.5, 1e308, -1e308, "", "x", "AUD", "%", [], {}, [1, null], "__proto__", "<script>", "\u0000"];
    const junk = (depth: number): unknown => {
      if (depth > 3 || random() < 0.4) return pick(atoms);
      if (random() < 0.5) return Array.from({ length: Math.floor(random() * 5) }, () => junk(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [pick(["type", "title", "x", "series", "values", "name", "stats", "cells", "rows", "cols", "stacked", "__proto__", "constructor"]), junk(depth + 1)]));
    };
    const seeds = [bar, { type: "stats", title: "S", stats: [{ label: "a", value: 1 }] }, { type: "heatmap", title: "H", cells: [[1, 2]] }];
    for (let i = 0; i < 600; i++) {
      const base = JSON.parse(json(pick(seeds))) as Record<string, unknown>;
      const mutated = random() < 0.3 ? junk(0) : { ...base, [pick(Object.keys(base).concat(["series", "x", "stats", "cells", "unit"]))]: junk(1) };
      let text = json(mutated) ?? "null";
      if (random() < 0.2) text = text.slice(0, Math.floor(random() * text.length));
      expect(() => parseChatChart(text)).not.toThrow();
      const parsed = parseChatChart(text);
      expect(typeof parsed.ok).toBe("boolean");
      if (parsed.ok) expect(() => chartToText(parsed.chart)).not.toThrow();
      expect(() => chartBlockText(text)).not.toThrow();
    }
    expect(() => parseChatChart(undefined)).not.toThrow();
  });
});

describe("plain text for copy and phones", () => {
  it("formats office values", () => {
    expect(formatChartValue(12400, "AUD")).toBe("$12,400");
    expect(formatChartValue(12.5, "AUD")).toBe("$12.50");
    expect(formatChartValue(212.4, "AUD")).toBe("$212.40");
    expect(formatChartValue(212.4, "days")).toBe("212 days");
    expect(formatChartValue(125000, "AUD", { compact: true })).toBe("$125K");
    expect(formatChartValue(12.5, "%")).toBe("12.5%");
    expect(formatChartValue(14, "days")).toBe("14 days");
    expect(formatChartValue(1, "days")).toBe("1 day");
    expect(formatChartValue(1234567)).toBe("1,234,567");
    expect(formatChartValue(5, "ZZZ")).toBe("5 ZZZ");
  });

  it("reads a chart as title, value lines and source", () => {
    const parsed = parseChatChart(json(bar));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(chartToText(parsed.chart)).toBe("Arrears by property\n14 Fictional St: $1,200\n9 Sample Ln: $450\n28 Example Ave: $0\nSource: Fictional ledger, 6 Oct 2026");
    const multi = parseChatChart(json({ type: "line", title: "Rent", subtitle: "Fictional", x: ["Jul", "Aug"], series: [{ name: "Collected", values: [1, 2] }, { name: "Due", values: [3, null] }] }));
    if (!multi.ok) throw new Error(multi.reason);
    expect(chartToText(multi.chart)).toBe("Rent — Fictional\nCollected: Jul 1, Aug 2\nDue: Jul 3, Aug no value");
    const stats = parseChatChart(json({ type: "stats", title: "Week", unit: "days", stats: [{ label: "Oldest repair", value: 12, note: "Unit 4" }, { label: "Status", value: "On track" }] }));
    if (!stats.ok) throw new Error(stats.reason);
    expect(chartToText(stats.chart)).toBe("Week\nOldest repair: 12 days (Unit 4)\nStatus: On track");
  });

  it("replaces only chart fences, including an unclosed one, and leaves other code alone", () => {
    const text = [
      "Arrears are concentrated.",
      "",
      "```chart",
      json(bar),
      "```",
      "",
      "````markdown",
      "```chart",
      "{\"inside\": \"another block\"}",
      "```",
      "````",
      "",
      "~~~ chart",
      "{broken",
      "~~~",
      "",
      "```chart",
      json(bar).slice(0, 40),
    ].join("\n");
    const out = replaceChartBlocksWithText(text);
    expect(out).toContain("Arrears are concentrated.");
    expect(out).toContain("14 Fictional St: $1,200");
    expect(out).toContain('{"inside": "another block"}');
    expect(out).toContain("its data couldn't be read");
    expect(out).not.toContain('"type":"bar"');
    expect(out).not.toContain("{broken");
    expect(replaceChartBlocksWithText("No charts here.")).toBe("No charts here.");
  });
});
