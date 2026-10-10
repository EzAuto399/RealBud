#!/usr/bin/env node
// Chart gallery: many chart variations in Bud replies, each screenshotted at
// 390, 768 and 1440 px and checked for layout faults (page errors, sideways
// scroll, chart outside the viewport, overlapping or clipped SVG labels, text
// under 11 px, tooltips clipped at the first and last point). Built React UI
// (scratch build, never the shared dist/) served by a real isolated source
// server with a scratch home and a fictional transcript seeded through the
// real Store. No worker, model, channel or customer account is involved.
//
//   pnpm exec vite build --outDir outputs/chat-chart-gallery-2026-10-07/ui-dist --emptyOutDir
//   REALBUD_UI_DIR=outputs/chat-chart-gallery-2026-10-07/ui-dist PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… node scripts/qa-chat-chart-gallery.mjs
// QA_ONLY=slug1,slug2 limits the run to some variations.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { primeBrowserSession, readSessionToken } from "./local-session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/chat-chart-gallery-2026-10-07"));
const ui = resolve(process.env.REALBUD_UI_DIR ?? join(output, "ui-dist"));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE.");
if (ui === resolve(root, "dist")) throw new Error("Build to a scratch directory; this script never serves the shared dist/.");
if (!existsSync(join(ui, "index.html"))) throw new Error(`No built UI at ${ui}. Run the vite build in the header first.`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const shots = join(output, "shots");
mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------- fictional data
const SOURCE = "Fictional sample ledger";
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const wave = (i, base, amp, period = 6) => Math.round(base + amp * Math.sin(i / period) + (i % 7) * 1.5);
const streets = ["Fictional", "Sample", "Example", "Placeholder", "Demonstration", "Mock", "Pretend", "Notional", "Imaginary", "Sketch", "Draft", "Model", "Pattern", "Template", "Specimen", "Exhibit", "Trial", "Prototype", "Rehearsal", "Dummy"];
const kinds = ["Street", "Lane", "Avenue", "Road", "Court", "Parade", "Crescent", "Place", "Way", "Terrace"];
const address = (i) => `${(i * 7) % 60 + 1} ${streets[i % streets.length]} ${kinds[i % kinds.length]}`;
const days = (count, from = Date.UTC(2026, 3, 1)) => Array.from({ length: count }, (_, i) => { const d = new Date(from + i * 86_400_000); return `${d.getUTCDate()} ${d.toLocaleString("en-AU", { month: "short", timeZone: "UTC" })}`; });
const hours = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`));
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const managers = ["Alex P.", "Bea M.", "Chen L.", "Dana R.", "Eli S.", "Fran K.", "Gus T.", "Hana W."];

const fence = (spec) => `\`\`\`chart\n${typeof spec === "string" ? spec : JSON.stringify(spec)}\n\`\`\``;
/** body: Markdown after the marker line. figures/fallbacks: what must appear. */
const v = (slug, body, { figures = 1, fallbacks = 0 } = {}) => ({ slug, body, figures, fallbacks });
const one = (lead, spec) => `${lead}\n\n${fence(spec)}\n\nAll figures are fictional sample data.`;

const variations = [
  v("bar-negatives", one("Net change in rent roll by property this quarter.", { type: "bar", title: "Net change in weekly rent by property", unit: "AUD", x: ["14 Fictional St", "9 Sample Ln", "28 Example Ave", "3/7 Demo Ct", "41 Placeholder Rd", "6 Mock Pde"], series: [{ name: "Net change", values: [1200, -850, 300, -2400, 0, 640] }], source: SOURCE })),
  v("bar-all-zero", one("No arrears were recorded in any month.", { type: "bar", title: "Arrears by month", unit: "AUD", x: months.slice(0, 6), series: [{ name: "Arrears", values: [0, 0, 0, 0, 0, 0] }], source: SOURCE })),
  v("bar-outlier", one("One property's repair bill dwarfs the rest.", { type: "bar", title: "Repair spend by property", unit: "AUD", x: ["14 Fictional St", "9 Sample Ln", "28 Example Ave", "3/7 Demo Ct", "41 Placeholder Rd", "6 Mock Pde", "2 Pretend Pl"], series: [{ name: "Repairs", values: [1840, 920, 182000, 2260, 640, 1310, 1105] }], source: SOURCE })),
  v("bar-tiny-decimals", one("Late-fee rate per tenancy is tiny everywhere.", { type: "bar", title: "Late-fee rate per tenancy", x: ["North", "South", "East", "West"], series: [{ name: "Rate", values: [0.03, 0.05, 0.012, 0.041] }], source: SOURCE })),
  v("bar-large-aud", one("Portfolio value by suburb.", { type: "bar", title: "Managed portfolio value by suburb", unit: "AUD", x: ["Sampletown", "Exampleville", "Mockford", "Demo Heights", "Placeholder Bay"], series: [{ name: "Value", values: [72800000, 41250000, 18900000, 9600000, 3150000] }], source: SOURCE })),
  v("bar-percent-high", one("Occupancy by building is high everywhere.", { type: "bar", title: "Occupancy by building", unit: "%", x: ["Tower A", "Tower B", "Courtyard", "Terraces", "Lofts"], series: [{ name: "Occupancy", values: [89.7, 94.2, 99.1, 96.5, 92.3] }], source: SOURCE })),
  v("line-percent-high", one("Occupancy over the year stayed between 89.7% and 99.1%.", { type: "line", title: "Portfolio occupancy", unit: "%", x: months, series: [{ name: "Occupancy", values: [89.7, 91.2, 93.4, 95.1, 96.8, 97.2, 98.4, 99.1, 98.7, 97.9, 96.3, 95.5] }], source: SOURCE })),
  v("bar-9-categories", one("Open jobs by trade.", { type: "bar", title: "Open jobs by trade", unit: "jobs", x: ["Plumbing", "Electrical", "Roofing", "Locksmith", "Painting", "Gardening", "Pest control", "Glazing", "Cleaning"], series: [{ name: "Open", values: [14, 9, 4, 3, 6, 11, 2, 1, 7] }], source: SOURCE })),
  v("bar-20-categories", one("Weekly rent by property across the book.", { type: "bar", title: "Weekly rent by property", unit: "AUD", x: Array.from({ length: 20 }, (_, i) => address(i)), series: [{ name: "Rent", values: Array.from({ length: 20 }, (_, i) => 420 + ((i * 53) % 380)) }], source: SOURCE })),
  v("bar-long-names", one("Vacancy days by building, using full names.", { type: "bar", title: "Days vacant by building", unit: "days", x: ["The Fictional Gardens Residential Apartments, Building North", "Sample Lane Townhouse Estate Stage Two Eastern Wing", "Example Avenue Mixed Use Retail and Residential Tower", "Demonstration Court Heritage Terraces and Rear Lane Studios"], series: [{ name: "Days vacant", values: [18, 42, 7, 29] }], source: SOURCE })),
  v("bar-8-series", one("Maintenance spend by category across four quarters.", { type: "bar", title: "Maintenance spend by category", unit: "AUD", x: ["Q1", "Q2", "Q3", "Q4"], series: ["Plumbing", "Electrical", "Roofing", "Locks", "Painting", "Garden", "Pest", "Glass"].map((name, j) => ({ name, values: [0, 1, 2, 3].map((q) => 800 + ((j * 311 + q * 173) % 2400)) })), source: SOURCE })),
  v("bar-stacked-8x2", one("Each manager's book split into leased and vacant.", { type: "bar", title: "Properties by manager", unit: "properties", stacked: true, x: managers, series: [{ name: "Leased", values: [42, 38, 51, 29, 44, 36, 47, 33] }, { name: "Vacant", values: [3, 5, 2, 6, 1, 4, 2, 7] }], source: SOURCE })),
  v("horizontal-50", one("Every property's days since last inspection.", { type: "bar", title: "Days since last inspection", unit: "days", horizontal: true, x: Array.from({ length: 50 }, (_, i) => address(i)), series: [{ name: "Days", values: Array.from({ length: 50 }, (_, i) => 12 + ((i * 37) % 170)) }], source: SOURCE })),
  v("line-200", one("Daily enquiries over 200 days.", { type: "line", title: "Daily enquiries", subtitle: "200 days from 1 April 2026", x: days(200), series: [{ name: "Enquiries", values: Array.from({ length: 200 }, (_, i) => wave(i, 30, 10, 5)) }], source: SOURCE })),
  v("line-gaps", one("Water meter readings with many missing weeks.", { type: "line", title: "Weekly water use", unit: "kL", x: Array.from({ length: 26 }, (_, i) => `W${i + 1}`), series: [{ name: "14 Fictional St", values: Array.from({ length: 26 }, (_, i) => ([2, 3, 7, 8, 9, 13, 17, 18, 21, 24].includes(i) ? null : wave(i, 14, 4))) }, { name: "9 Sample Ln", values: Array.from({ length: 26 }, (_, i) => (i % 3 === 0 ? null : wave(i + 3, 9, 3))) }], source: SOURCE })),
  v("line-one-point", one("Only one month of data so far.", { type: "line", title: "Arrears this month", unit: "AUD", x: ["Oct"], series: [{ name: "Arrears", values: [1850] }], source: SOURCE })),
  v("line-negative", one("Net cash flow crosses zero twice.", { type: "line", title: "Net trust cash flow", unit: "AUD", x: months, series: [{ name: "Net", values: [4200, 2100, -800, -3100, -1200, 900, 2600, 3900, 1500, -400, 1100, 2800] }], source: SOURCE })),
  v("area-stacked-4", one("Bonds lodged by state.", { type: "area", title: "Bonds held by state", unit: "AUD", stacked: true, x: months, series: ["NSW", "VIC", "QLD", "SA"].map((name, j) => ({ name, values: months.map((_, i) => (4 - j) * 40000 + i * 2500 * (4 - j)) })), source: SOURCE })),
  v("area-overlap", one("Enquiries and inspections overlap.", { type: "area", title: "Enquiries and inspections", x: months, series: [{ name: "Enquiries", values: months.map((_, i) => wave(i, 60, 20, 2)) }, { name: "Inspections", values: months.map((_, i) => wave(i + 2, 45, 18, 2)) }], source: SOURCE })),
  v("stats-1", one("One figure that matters.", { type: "stats", title: "Arrears today", unit: "AUD", stats: [{ label: "Total arrears", value: 1850, note: "3 tenancies, all under 14 days" }], source: SOURCE })),
  v("stats-4-long", one("This week's numbers with notes.", { type: "stats", title: "This week at a glance", unit: "AUD", stats: [{ label: "Rent collected across every managed tenancy", value: 46040.55, note: "98.2% of rent due this week, up from 96.4% last week" }, { label: "Arrears", value: 1850, note: "3 tenancies; the oldest is 13 days behind" }, { label: "Open repairs", value: "9 jobs", note: "2 urgent: hot water at 9 Sample Ln and a roof leak" }, { label: "Leases ending", value: "4 in 30 days", note: "Renewal letters drafted for all four, none sent yet" }], source: SOURCE })),
  v("stats-12", one("Twelve figures for the month.", { type: "stats", title: "Month in figures", unit: "AUD", stats: Array.from({ length: 12 }, (_, i) => ({ label: ["Rent collected", "Arrears", "Bonds held", "Repairs paid", "Owner payouts", "Fees earned", "Water recovered", "Council rates", "Strata levies", "Insurance", "Advertising", "Refunds"][i], value: [182400, 1850, 486000, 12450, 164300, 14592, 2210, 8840, 11200, 3150, 990, 420][i], ...(i % 3 === 0 ? { note: "Compared with the same month last year" } : {}) })), source: SOURCE })),
  v("stats-mixed", one("Mixed text and numbers.", { type: "stats", title: "Office status", stats: [{ label: "Properties", value: 214 }, { label: "Vacancy rate", value: "1.9%" }, { label: "Status", value: "On track" }, { label: "Next inspection", value: "Thu 9 Oct" }, { label: "Open jobs", value: 37, note: "5 waiting on owners" }, { label: "Longest vacancy", value: "42 days" }], source: SOURCE })),
  v("heatmap-7x24", one("Calls by day and hour.", { type: "heatmap", title: "Calls by day and hour", subtitle: "Last four weeks", unit: "calls", rows: weekdays, cols: hours, cells: weekdays.map((_, r) => hours.map((_, c) => Math.max(0, Math.round((r < 5 ? 18 : 6) - Math.abs(c - 10) * 1.6 - r + ((r * 5 + c * 3) % 4))))), source: SOURCE })),
  v("heatmap-nulls", one("Inspections booked, with closed slots blank.", { type: "heatmap", title: "Inspections booked", unit: "inspections", rows: weekdays, cols: ["9am", "10am", "11am", "12pm", "1pm", "2pm", "3pm", "4pm"], cells: weekdays.map((_, r) => Array.from({ length: 8 }, (_, c) => (r === 6 || (r === 5 && c > 3) || (r + c) % 5 === 0 ? null : (r * 3 + c * 2) % 7))), source: SOURCE })),
  v("heatmap-equal", one("Every slot booked exactly twice.", { type: "heatmap", title: "Bookings per slot", rows: weekdays.slice(0, 5), cols: ["9am", "11am", "1pm", "3pm"], cells: weekdays.slice(0, 5).map(() => [2, 2, 2, 2]), source: SOURCE })),
  v("unit-nzd", one("New Zealand rent in NZD.", { type: "bar", title: "Rent collected in Auckland", unit: "NZD", x: months.slice(0, 6), series: [{ name: "Collected", values: [18200.5, 19400, 18750.25, 20100, 19980, 21340.75] }], source: SOURCE })),
  v("unit-usd", one("USD software subscriptions.", { type: "line", title: "Software spend", unit: "USD", x: months, series: [{ name: "Spend", values: [412, 412, 455, 455, 455, 498, 498, 520, 520, 520, 545, 545] }, { name: "Budget", values: months.map(() => 500) }], source: SOURCE })),
  v("unit-days", one("Days to lease by property.", { type: "bar", title: "Days to lease", unit: "days", horizontal: true, x: Array.from({ length: 8 }, (_, i) => address(i)), series: [{ name: "Days", values: [1, 14, 22, 9, 31, 6, 18, 12] }], source: SOURCE })),
  v("unit-jobs", one("Jobs opened and closed per week.", { type: "bar", title: "Jobs per week", unit: "jobs", x: ["W1", "W2", "W3", "W4", "W5", "W6"], series: [{ name: "Opened", values: [12, 9, 15, 11, 8, 13] }, { name: "Closed", values: [10, 11, 12, 14, 9, 12] }], source: SOURCE })),
  v("unit-none", one("Plain counts with no unit.", { type: "line", title: "Applications received", x: months, series: [{ name: "Applications", values: [31, 28, 44, 39, 52, 61, 58, 47, 40, 36, 33, 29] }], source: SOURCE })),
  v("unit-long", one("Owner payouts in thousands.", { type: "bar", title: "Owner payouts by month", unit: "AUD (thousands)", x: months.slice(0, 6), series: [{ name: "Payouts", values: [164.3, 158.9, 171.2, 149.5, 168, 175.4] }], source: SOURCE })),
  v("year-labels", one("Average weekly rent each year.", { type: "bar", title: "Average weekly rent", unit: "AUD", x: [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], series: [{ name: "Rent", values: [480, 472, 505, 548, 602, 641, 668, 690] }], source: SOURCE })),
  v("long-title", one("A long title, subtitle and source.", { type: "bar", title: "Rent collected against rent due for every managed residential tenancy in the Sampletown office, by month, 2026", subtitle: "Includes part payments and Centrepay deductions; excludes bond top-ups, water recoveries and commercial leases managed elsewhere", unit: "AUD", x: months.slice(0, 6), series: [{ name: "Collected", values: [41200, 43500, 44180, 39860, 45120, 46040] }, { name: "Due", values: [42000, 44000, 44500, 42100, 45600, 46200] }], source: "Fictional sample ledger export, trust account 1 and 2, reconciled weekly by the office" })),
  v("two-charts", `Two views of the same month.\n\n${fence({ type: "stats", title: "September summary", unit: "AUD", stats: [{ label: "Collected", value: 46040 }, { label: "Arrears", value: 1850 }] })}\n\nAnd the trend behind it:\n\n${fence({ type: "line", title: "Arrears by week", unit: "AUD", x: ["W1", "W2", "W3", "W4"], series: [{ name: "Arrears", values: [2400, 2100, 1990, 1850] }] })}\n\nAll figures are fictional sample data.`, { figures: 2 }),
  v("chart-in-list", `Here is the plan:\n\n1. Chase the three tenancies in arrears.\n\n   ${fence({ type: "bar", title: "Arrears by tenancy", unit: "AUD", x: ["14 Fictional St", "9 Sample Ln", "28 Example Ave"], series: [{ name: "Arrears", values: [920, 610, 320] }] }).split("\n").join("\n   ")}\n\n2. Send the owner statements.\n3. Book the routine inspections.\n\nAll figures are fictional sample data.`),
  v("chart-after-table", `| Property | Rent |\n| --- | --- |\n| 14 Fictional St | $620 |\n| 9 Sample Ln | $540 |\n\n${fence({ type: "bar", title: "Weekly rent", unit: "AUD", x: ["14 Fictional St", "9 Sample Ln"], series: [{ name: "Rent", values: [620, 540] }] })}\n\nAll figures are fictional sample data.`),
  v("missing-title", one("A chart with no title.", { type: "bar", unit: "jobs", x: ["Mon", "Tue", "Wed"], series: [{ name: "Jobs", values: [4, 7, 5] }] })),
  v("extra-fields", one("A chart with fields RealBud ignores.", { type: "line", title: "Enquiries with extras", color: "red", description: "ignored", legend: { position: "top" }, x: months.slice(0, 6), series: [{ name: "Enquiries", values: [12, 18, 15, 22, 19, 25], color: "#ff0000" }], source: SOURCE })),
  v("fallback-pie", one("A pie chart, which RealBud does not draw.", { type: "pie", title: "Water bills by property", unit: "AUD", x: ["14 Fictional Street", "9 Sample Lane"], series: [{ name: "Water", values: [212.4, 188.1] }] }), { figures: 0, fallbacks: 1 }),
  v("fallback-broken", `Council rates for the year so far:\n\n${fence('{"type":"bar","title":"Council rates","x":["Q1","Q2"],"series":[{"name":"Rates","values":[410,')}\n\nThe fourth quarter notice has not arrived yet.`, { figures: 0, fallbacks: 1 }),
  v("fallback-too-many", one("Too many points to draw.", { type: "line", title: "Hourly readings", x: Array.from({ length: 240 }, (_, i) => `H${i}`), series: [{ name: "Reading", values: Array.from({ length: 240 }, (_, i) => i % 17) }] }), { figures: 0, fallbacks: 1 }),
];
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
const selected = variations.filter((x) => !only || only.has(x.slug));
const marker = (index, slug) => `Gallery ${String(index + 1).padStart(2, "0")} · ${slug}.`;
const transcript = selected.flatMap((x, i) => [{ role: "user", text: `Show variation ${x.slug}.` }, { role: "bot", text: `${marker(i, x.slug)}\n\n${x.body}` }]);

// ---------------------------------------------------------------- server
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "realbud-chart-gallery-"));
const data = join(scratch, "data"); mkdirSync(data);
const env = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_DATA_DIR: data, VITEST: "true" };
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }), { mode: 0o600 });
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { Store } from './server/store.ts';
  const store = new Store(() => ({ instanceId: 'ghost', model: '' }));
  const bot = store.createBot();
  for (const m of ${JSON.stringify(transcript)}) store.appendMessage(bot.threadId, { role: m.role, kind: 'text', text: m.text });
  console.log(JSON.stringify({ threadId: bot.threadId }));
`], { cwd: root, env, encoding: "utf8" });

const WIDTHS = [390, 768, 1440];
const results = [], errors = [], shotList = [];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let child, browser, logs = "", failure;

// In-page layout audit of one reply. Returns a list of problems (strings).
const auditReply = (article) => article.evaluate((node) => {
  const problems = [];
  const vw = innerWidth;
  const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  for (const fig of node.querySelectorAll("figure.chat-chart, .chat-chart-fallback")) {
    const box = fig.getBoundingClientRect();
    const name = fig.getAttribute("aria-label") ?? "chart";
    if (box.left < -1 || box.right > vw + 1) problems.push(`${name}: outside the viewport (${Math.round(box.left)}–${Math.round(box.right)} of ${vw})`);
    for (const svg of fig.querySelectorAll("svg[aria-hidden='true']:not(.lucide)")) {
      const s = svg.getBoundingClientRect();
      if (s.right > box.right + 1) problems.push(`${name}: plot wider than its card`);
      const texts = [...svg.querySelectorAll("text")].map((t) => ({ t: t.textContent ?? "", r: t.getBoundingClientRect() })).filter((x) => x.r.width > 0);
      for (const x of texts) {
        if (x.r.left < s.left - 1 || x.r.right > s.right + 1 || x.r.top < s.top - 1 || x.r.bottom > s.bottom + 1) problems.push(`${name}: label "${x.t}" clipped by the plot edge`);
      }
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        if (intersects(texts[i].r, texts[j].r)) problems.push(`${name}: labels overlap "${texts[i].t}" / "${texts[j].t}"`);
      }
    }
    // smallest rendered text in the card
    const walker = document.createTreeWalker(fig, NodeFilter.SHOW_TEXT);
    let smallest = Infinity, smallText = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest(".sr-only, [hidden], details:not([open]) > :not(summary)")) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < smallest) { smallest = size; smallText = n.textContent.trim().slice(0, 30); }
    }
    if (smallest < 11) problems.push(`${name}: text "${smallText}" at ${smallest}px`);
  }
  return problems;
});
const pageOffenders = (p) => p.evaluate(() => {
  const offenders = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) offenders.push("document scrolls sideways");
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (!["auto", "scroll"].includes(style.overflowX)) continue;
    if (el.closest(".chat-table-scroll, .chat-code-scroll")) continue;
    if (el.scrollWidth > el.clientWidth + 1) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} scrolls sideways`);
  }
  return offenders;
});

try {
  assert.equal(seed.status, 0, seed.stderr);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((done) => reservation.close(done));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env: { ...env, OMB_PORT: String(port), OMB_STATIC_DIR: ui }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { logs = (logs + bytes).slice(-20000); });
  const until = async (check, label, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check().catch(() => false)) return; await wait(100); }
    throw new Error(`Timed out: ${label}`);
  };
  await until(async () => (await fetch(`${base}/api/health`)).ok, "server startup");
  const token = await readSessionToken(data);
  const headers = { "content-type": "application/json", "x-realbud-session": token };
  let onboarding = await (await fetch(`${base}/api/onboarding`, { headers })).json();
  for (const stage of ["office-rules", "complete"]) {
    const saved = await fetch(`${base}/api/onboarding`, { method: "PUT", headers, body: JSON.stringify({ expectedScope: onboarding.scope, expectedRevision: onboarding.revision, stage }) });
    onboarding = await saved.json();
    assert.equal(saved.status, 200, `Onboarding ${stage}: ${JSON.stringify(onboarding)}`);
  }

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  for (const width of WIDTHS) {
    const viewH = width === 390 ? 844 : width === 768 ? 1024 : 1000;
    const context = await browser.newContext({ viewport: { width, height: viewH }, reducedMotion: "reduce" });
    await context.route("**/*", (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    await primeBrowserSession(context, base, token);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`));
    await page.goto(`${base}/#/desk`);
    await page.getByRole("heading", { name: "Desk", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Work\b/ }).first().click();
    const totalFigures = selected.reduce((t, x) => t + x.figures, 0), totalFallbacks = selected.reduce((t, x) => t + x.fallbacks, 0);
    const counts = async () => [await page.locator("figure.chat-chart").count(), await page.locator(".chat-chart-fallback").count()];
    await until(async () => { const [f, b] = await counts(); return f === totalFigures && b === totalFallbacks; }, `${totalFigures} charts and ${totalFallbacks} fallbacks at ${width}`, 30_000)
      .catch(async (error) => { throw new Error(`${error.message}; saw ${(await counts()).join(" and ")}`); });
    await wait(400);
    for (const offender of await pageOffenders(page)) results.push({ slug: "(page)", width, problem: offender });
    // tall window for element shots so the fixed header and composer never cover a card
    await page.setViewportSize({ width, height: 2400 });
    await wait(300);
    for (let index = 0; index < selected.length; index++) {
      const x = selected[index];
      const article = page.getByRole("article", { name: "Bud’s response" }).filter({ hasText: marker(index, x.slug) });
      assert.equal(await article.count(), 1, `one reply for ${x.slug}`);
      assert.equal(await article.locator("figure.chat-chart").count(), x.figures, `${x.slug}: charts drawn`);
      assert.equal(await article.locator(".chat-chart-fallback").count(), x.fallbacks, `${x.slug}: fallbacks`);
      await article.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await wait(80);
      for (const problem of await auditReply(article)) results.push({ slug: x.slug, width, problem });
      const heights = await article.locator("figure.chat-chart").evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
      results.push({ slug: x.slug, width, heights });
      await article.screenshot({ path: join(shots, `${x.slug}-${width}.png`) });
      shotList.push(`shots/${x.slug}-${width}.png`);
      // tooltips at the first and last point stay inside the card and the window
      if (width === 390) {
        for (const fig of await article.locator("figure.chat-chart").all()) {
          const targets = fig.locator("[role='group'] button");
          const count = await targets.count();
          if (!count) continue;
          for (const which of [0, count - 1]) {
            const target = targets.nth(which);
            await target.evaluate((node) => node.scrollIntoView({ block: "center" }));
            const b = await target.boundingBox();
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
            const tip = fig.locator("div[aria-hidden='true'].pointer-events-none");
            await tip.waitFor({ timeout: 3000 });
            const [t, f] = [await tip.boundingBox(), await fig.boundingBox()];
            const label = await fig.getAttribute("aria-label");
            if (t.x < f.x - 0.5 || t.x + t.width > f.x + f.width + 0.5 || t.y < f.y - 0.5 || t.y + t.height > f.y + f.height + 0.5) results.push({ slug: x.slug, width, problem: `${label}: tooltip at point ${which + 1} clipped by the card (${Math.round(t.x - f.x)},${Math.round(t.y - f.y)} ${Math.round(t.width)}×${Math.round(t.height)} in ${Math.round(f.width)}×${Math.round(f.height)})` });
            if (which === count - 1) await page.screenshot({ path: join(shots, `${x.slug}-390-tooltip-last.png`), clip: { x: 0, y: Math.max(0, f.y - 10), width: 390, height: Math.min(f.height + 20, 2400 - Math.max(0, f.y - 10)) } });
            await page.mouse.move(0, 0);
          }
          shotList.push(`shots/${x.slug}-390-tooltip-last.png`);
        }
      }
    }
    await page.setViewportSize({ width, height: viewH });
    await wait(300);
    for (const offender of await pageOffenders(page)) results.push({ slug: "(page)", width, problem: offender });
    await context.close();
  }
} catch (error) {
  failure = error.stack || String(error);
} finally {
  await browser?.close();
  if (child?.exitCode === null && !child.signalCode) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await once(child, "exit"); } }
  rmSync(scratch, { recursive: true, force: true });
  const problems = results.filter((r) => r.problem);
  for (const p of problems) console.log(`FAIL ${p.width} ${p.slug}: ${p.problem}`);
  for (const e of errors) console.log(`PAGEERROR ${e}`);
  const passed = !failure && !problems.length && !errors.length;
  console.log(`${selected.length} variations × ${WIDTHS.length} widths: ${problems.length} layout problems, ${errors.length} page errors${failure ? ", run failed" : ""}`);
  writeFileSync(join(output, "receipt.json"), JSON.stringify({
    at: new Date().toISOString(),
    passed,
    layer: "Built React UI (scratch vite build) in headless Chrome; real isolated source server with a scratch home; fictional transcript seeded through the real Store",
    variations: selected.map((x) => x.slug),
    widths: WIDTHS,
    problems,
    errors,
    heights: results.filter((r) => r.heights),
    screenshots: shotList,
    limits: [
      "Fictional sample data only; not customer acceptance and not evidence that Bud produces these charts from real office sources.",
      "No model or worker ran: chart blocks were seeded as saved replies.",
      "Headless Chrome with reduced motion; label overlap is checked from DOM boxes of SVG text only; the packaged app, Windows and screen readers were not exercised.",
    ],
    failure,
    ...(failure ? { diagnostic: logs } : {}),
  }, null, 2));
  if (failure) console.error(failure);
  if (!passed) process.exitCode = 1;
}
