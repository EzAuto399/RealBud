#!/usr/bin/env node
// Charts in Bud replies: built React UI (scratch build, never the shared dist/)
// served by a real isolated source server with a scratch home and a fictional
// transcript. One reply per chart type, two that cannot be drawn, and one
// still streaming (injected as the service's own live-stream snapshot). No
// worker, model, channel or customer account is involved.
//
//   pnpm exec vite build --outDir outputs/chat-charts-2026-10-06/ui-dist --emptyOutDir
//   REALBUD_UI_DIR=outputs/chat-charts-2026-10-06/ui-dist PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… node scripts/qa-chat-charts.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { primeBrowserSession, readSessionToken } from "./local-session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/chat-charts-2026-10-06"));
const ui = resolve(process.env.REALBUD_UI_DIR ?? join(output, "ui-dist"));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE.");
if (ui === resolve(root, "dist")) throw new Error("Build to a scratch directory; this script never serves the shared dist/.");
if (!existsSync(join(ui, "index.html"))) throw new Error(`No built UI at ${ui}. Run the vite build in the header first.`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const shots = join(output, "shots");
mkdirSync(shots, { recursive: true });

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const days = Array.from({ length: 90 }, (_, i) => { const d = new Date(Date.UTC(2026, 6, 1 + i)); return `${d.getUTCDate()} ${d.toLocaleString("en-AU", { month: "short", timeZone: "UTC" })}`; });
const wave = (i, base, amp) => Math.round(base + amp * Math.sin(i / 6) + (i % 7) * 1.5);
const SOURCE = "Fictional sample ledger";
const charts = [
  { slug: "bar", ask: "How did rent collection go this half year?", lead: "Collections rose in five of six months; April dipped while two tenancies changed over.",
    spec: { type: "bar", title: "Rent collected by month", subtitle: "January to June 2026", unit: "AUD", x: months, series: [{ name: "Collected", values: [41200, 43500, 44180, 39860, 45120, 46040] }], source: SOURCE } },
  { slug: "grouped-bar", ask: "Compare open and closed repairs by trade.", lead: "Plumbing carries most of the open work.",
    spec: { type: "bar", title: "Repairs by trade", unit: "jobs", x: ["Plumbing", "Electrical", "Roofing", "Locksmith"], series: [{ name: "Open", values: [6, 2, 1, 0] }, { name: "Closed", values: [11, 7, 3, 4] }], source: SOURCE } },
  { slug: "horizontal-bar", ask: "Which properties have been vacant longest?", lead: "14 Fictional Street has been listed longest.",
    spec: { type: "bar", title: "Days vacant by property", unit: "days", horizontal: true, stacked: true, x: ["14 Fictional Street, Sampletown", "9 Sample Lane", "28 Example Avenue", "3/7 Demonstration Court", "41 Placeholder Road"], series: [{ name: "Listed", values: [34, 21, 12, 9, 4] }, { name: "Application in review", values: [6, 5, 0, 3, 2] }], source: SOURCE } },
  { slug: "line", ask: "Show daily enquiries over the last 90 days.", lead: "Enquiries climb into each weekend; inspections follow two days later.",
    spec: { type: "line", title: "Daily enquiries and inspections", subtitle: "1 July to 28 September 2026", x: days, series: [{ name: "Enquiries", values: days.map((_, i) => (i === 40 || i === 41 ? null : wave(i, 24, 8))) }, { name: "Inspections", values: days.map((_, i) => wave(i + 2, 9, 4)) }], source: SOURCE } },
  { slug: "area", ask: "How has bond lodgement grown?", lead: "Lodged bonds grew steadily, mostly in New South Wales.",
    spec: { type: "area", title: "Bonds lodged by state", unit: "AUD", stacked: true, x: ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"], series: [{ name: "NSW", values: [182000, 186500, 190000, 191500, 198000, 204000, 207500, 211000, 214000, 219500, 223000, 228000] }, { name: "VIC", values: [96000, 97000, 99500, 99500, 101000, 104000, 104500, 106000, 108500, 110000, 111000, 113500] }, { name: "QLD", values: [41000, 41500, 43000, 44500, 44500, 46000, 47500, 48000, 49000, 50500, 52000, 53000] }], source: SOURCE } },
  { slug: "stats", ask: "Give me this week's numbers.", lead: "Arrears are down and repairs are on track.",
    spec: { type: "stats", title: "This week at a glance", unit: "AUD", stats: [{ label: "Rent collected", value: 46040, note: "98.2% of rent due" }, { label: "Arrears", value: 1850, note: "3 tenancies" }, { label: "Open repairs", value: "9 jobs", note: "2 urgent" }, { label: "Leases ending", value: "4 in 30 days" }], source: SOURCE } },
  { slug: "heatmap", ask: "When do tenants call the office?", lead: "Calls peak mid-morning early in the week.",
    spec: { type: "heatmap", title: "Calls by day and hour", subtitle: "Last four weeks", unit: "calls", rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], cols: ["8am", "9am", "10am", "11am", "12pm", "1pm", "2pm", "3pm", "4pm", "5pm", "6pm", "7pm"], cells: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((_, r) => Array.from({ length: 12 }, (_, c) => (r >= 5 && c > 6 ? null : Math.max(0, Math.round((r < 5 ? 14 : 4) - Math.abs(c - 2.5) * 2 - r)))) ), source: SOURCE } },
];
const fence = (body) => `\`\`\`chart\n${body}\n\`\`\``;
const partialSpec = JSON.stringify({ type: "pie", title: "Water bills by property", unit: "AUD", x: ["14 Fictional Street", "9 Sample Lane"], series: [{ name: "Water", values: [212.4, 188.1] }] });
const brokenSpec = '{"type":"bar","title":"Council rates","x":["Q1","Q2"],"series":[{"name":"Rates","values":[410,';
const streamingText = `Here is the arrears trend so far.\n\n\`\`\`chart\n{"type":"line","title":"Arrears by week","unit":"AUD","x":["W1","W2","W3"`;

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "realbud-chat-charts-"));
const data = join(scratch, "data"); mkdirSync(data);
const env = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_DATA_DIR: data, VITEST: "true" };
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }), { mode: 0o600 });
const transcript = [
  ...charts.flatMap((c) => [{ role: "user", text: c.ask }, { role: "bot", text: `${c.lead}\n\n${fence(JSON.stringify(c.spec))}\n\nAll figures are fictional sample data.` }]),
  { role: "user", text: "Chart the water bills." }, { role: "bot", text: `These are the two water bills on file.\n\n${fence(partialSpec)}` },
  { role: "user", text: "And the council rates?" }, { role: "bot", text: `Council rates for the year so far:\n\n${fence(brokenSpec)}\n\nThe fourth quarter notice has not arrived yet.` },
];
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { Store } from './server/store.ts';
  const store = new Store(() => ({ instanceId: 'ghost', model: '' }));
  const bot = store.createBot();
  for (const m of ${JSON.stringify(transcript)}) store.appendMessage(bot.threadId, { role: m.role, kind: 'text', text: m.text });
  console.log(JSON.stringify({ threadId: bot.threadId }));
`], { cwd: root, env, encoding: "utf8" });

const checks = [], errors = [], shotList = [], measurements = {};
const pass = (message) => { checks.push(message); console.log(`PASS ${message}`); };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let child, browser, page, logs = "", failure;
const shot = async (target, name) => { const path = join(shots, `${name}.png`); await target.screenshot({ path }); shotList.push(`shots/${name}.png`); };
const noHorizontalScroll = (p) => p.evaluate(() => {
  const offenders = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) offenders.push("document");
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (!["auto", "scroll"].includes(style.overflowX)) continue;
    if (el.closest(".chat-table-scroll, .chat-code-scroll")) continue;
    if (el.scrollWidth > el.clientWidth + 1) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
  }
  for (const fig of document.querySelectorAll("figure.chat-chart, .chat-chart-fallback, .chat-chart-placeholder")) {
    const box = fig.getBoundingClientRect();
    if (box.right > innerWidth + 1 || box.left < -1) offenders.push(`chart outside viewport: ${fig.getAttribute("aria-label")}`);
  }
  return offenders;
});
try {
  assert.equal(seed.status, 0, seed.stderr);
  const { threadId } = JSON.parse(seed.stdout.trim().split("\n").at(-1));
  const assets = readdirSync(join(ui, "assets"));
  const chartChunk = assets.find((name) => /^ChatChartBlock-.*\.js$/.test(name));
  assert.ok(chartChunk, "the chart renderer is its own lazy chunk");
  const withTableCopy = assets.filter((name) => name.endsWith(".js") && readFileSync(join(ui, "assets", name), "utf8").includes("Show as table"));
  assert.deepEqual(withTableCopy, [chartChunk]);
  pass("The built UI keeps the chart renderer in its own lazy chunk");

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
  const newContext = async (viewport) => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await context.route("**/*", (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    await primeBrowserSession(context, base, token);
    await context.addInitScript(() => {
      window.copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copied.push(text); } } });
    });
    return context;
  };

  // ---- Desk first: the chart code must not load there
  const context = await newContext({ width: 1440, height: 1000 });
  page = await context.newPage();
  const scripts = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/#/desk`);
  await page.getByRole("heading", { name: "Desk", exact: true }).waitFor();
  await wait(500);
  assert.equal(scripts.some((path) => /\/(ChatChartBlock|chat-chart)-/.test(path)), false, scripts.join("\n"));
  pass("Desk opens without downloading the chart renderer or parser");

  await page.getByRole("button", { name: /^Work\b/ }).first().click();
  for (const c of charts) await page.getByRole("figure", { name: c.spec.title, exact: true }).waitFor({ timeout: 15_000 });
  assert.ok(scripts.some((path) => path.includes("/ChatChartBlock-")));
  pass("Work draws one card per chart type (bar, grouped, sideways stacked, 90-day line, stacked area, figures, heat map)");

  const fallbacks = page.locator(".chat-chart-fallback");
  assert.equal(await fallbacks.count(), 2);
  await fallbacks.nth(0).getByText("This chart couldn’t be drawn").waitFor();
  await fallbacks.nth(0).getByRole("region", { name: "Water bills by property data" }).waitFor();
  assert.match(await fallbacks.nth(0).innerText(), /14 Fictional Street[\s\S]*\$212\.40/);
  assert.equal(await fallbacks.nth(1).locator("table").count(), 0);
  await fallbacks.nth(1).getByText("Show data").click();
  assert.match(await fallbacks.nth(1).locator("pre").innerText(), /Council rates/);
  await fallbacks.nth(1).getByText("Show data").click();
  const brokenReply = page.getByRole("article", { name: "Bud’s response" }).filter({ hasText: "fourth quarter notice" });
  assert.equal(await brokenReply.locator("p", { hasText: "The fourth quarter notice has not arrived yet." }).count(), 1);
  pass("A chart that cannot be drawn shows a table of what was read, or a note with the raw data behind Show data, and the rest of the reply keeps its formatting");

  const thread = await page.locator("main").first().innerText();
  assert.doesNotMatch(thread, /"series"|"type"\s*:|```/);
  pass("No raw chart data is visible in the conversation");

  // ---- keyboard: Tab from the table toggle lands on the first data point
  const barFigure = page.getByRole("figure", { name: "Rent collected by month", exact: true });
  await page.mouse.move(0, 0);
  await barFigure.getByRole("button", { name: "Show as table" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Jan: $41,200");
  const tooltip = barFigure.locator("div[aria-hidden='true'].pointer-events-none");
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /Jan[\s\S]*\$41,200/);
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Feb: $43,500");
  assert.match(await tooltip.innerText(), /Feb[\s\S]*\$43,500/);
  await shot(barFigure, "1440-bar-keyboard-tooltip");
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "detached" });
  pass("Tab reaches a data point and shows its tooltip; arrow keys move between points; Escape hides it");

  // ---- pointer: hover shows every series at that label
  const lineFigure = page.getByRole("figure", { name: "Daily enquiries and inspections", exact: true });
  await lineFigure.scrollIntoViewIfNeeded();
  const plot = await lineFigure.locator("[role='group']").boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
  const lineTip = lineFigure.locator("div[aria-hidden='true'].pointer-events-none");
  await lineTip.waitFor();
  assert.match(await lineTip.innerText(), /Enquiries[\s\S]*Inspections/);
  await shot(lineFigure, "1440-line-hover-tooltip");
  await page.mouse.move(0, 0);
  pass("Hovering a line chart shows one tooltip with every series at that date");

  // ---- table view toggle
  const grouped = page.getByRole("figure", { name: "Repairs by trade", exact: true });
  await grouped.getByRole("button", { name: "Show as table" }).click();
  await grouped.getByRole("region", { name: "Repairs by trade data" }).waitFor();
  assert.match(await grouped.locator("table").innerText(), /Plumbing\s+6 jobs\s+11 jobs/);
  await shot(grouped, "1440-grouped-bar-table");
  await grouped.getByRole("button", { name: "Show chart" }).click();
  await grouped.locator("svg").first().waitFor();
  pass("Show as table swaps the picture for an accessible table and back");

  // ---- copy gives readable lines
  const barReply = page.getByRole("article", { name: "Bud’s response" }).filter({ has: barFigure });
  await barReply.getByRole("button", { name: "Copy response" }).click();
  await until(async () => (await page.evaluate(() => window.copied.length)) > 0, "copy");
  const copiedText = await page.evaluate(() => window.copied.at(-1));
  assert.match(copiedText, /Rent collected by month — January to June 2026\nJan: \$41,200/);
  assert.doesNotMatch(copiedText, /```|"type"/);
  pass("Copy response gives the chart as readable lines, not raw data");

  for (const c of charts) await shot(page.getByRole("figure", { name: c.spec.title, exact: true }), `1440-${c.slug}`);
  await shot(fallbacks.nth(0), "1440-fallback-partial");
  await shot(fallbacks.nth(1), "1440-fallback-raw");
  measurements.chartHeights1440 = {};
  for (const c of charts) measurements.chartHeights1440[c.slug] = Math.round((await page.getByRole("figure", { name: c.spec.title, exact: true }).boundingBox()).height);
  assert.deepEqual(await noHorizontalScroll(page), []);
  pass("1440px: every chart fits its message with no horizontal scroll");

  // ---- phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(400);
  assert.deepEqual(await noHorizontalScroll(page), []);
  await page.getByRole("figure", { name: "Rent collected by month", exact: true }).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot(page, "390-thread-viewport");
  // element shots in a taller window so the fixed header and composer never overlap a card
  await page.setViewportSize({ width: 390, height: 1400 });
  await wait(300);
  const centred = async (locator, name) => { await locator.evaluate((node) => node.scrollIntoView({ block: "center" })); await wait(100); await shot(locator, name); };
  for (const c of charts) await centred(page.getByRole("figure", { name: c.spec.title, exact: true }), `390-${c.slug}`);
  await centred(fallbacks.nth(0), "390-fallback-partial");
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  const lineLabels = await lineFigure.locator("svg text").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  measurements.lineXLabelsAt390 = lineLabels.filter((t) => /^\d+ [A-Z][a-z]{2}$/.test(t)).length;
  assert.ok(measurements.lineXLabelsAt390 >= 2 && measurements.lineXLabelsAt390 <= 8, `x labels thinned at 390: ${measurements.lineXLabelsAt390}`);
  assert.deepEqual(await noHorizontalScroll(page), []);
  pass("390px: charts resize to the message, a 90-day axis thins its labels, and nothing scrolls sideways");
  await context.close();

  // ---- streaming: the service's live-stream snapshot carries a half-written chart
  const streamContext = await newContext({ width: 1440, height: 1000 });
  const hello = `data: ${JSON.stringify({ kind: "hello", streams: [{ threadId, turnId: "fictional-turn-1", text: streamingText, reasoning: "" }] })}\n\n`;
  await streamContext.route("**/api/events**", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: hello }));
  const streamPage = await streamContext.newPage();
  streamPage.on("pageerror", (error) => errors.push(error.message));
  await streamPage.goto(`${base}/#/desk`);
  await streamPage.getByRole("button", { name: /^Work\b/ }).first().click();
  const placeholder = streamPage.locator(".chat-chart-placeholder").last();
  await placeholder.waitFor({ timeout: 15_000 });
  assert.equal(await placeholder.innerText(), "Drawing chart…");
  const bubble = streamPage.locator("div", { has: placeholder }).filter({ hasText: "Here is the arrears trend so far." }).last();
  assert.doesNotMatch(await bubble.innerText(), /"type"|Arrears by week|W1/);
  measurements.placeholderHeight = Math.round((await placeholder.boundingBox()).height);
  await placeholder.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot(bubble, "1440-streaming-placeholder");
  await streamPage.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  await placeholder.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await shot(streamPage, "390-streaming-placeholder");
  assert.deepEqual(await noHorizontalScroll(streamPage), []);
  pass("While Bud is still writing a chart, a calm fixed-height placeholder shows instead of raw data");
  await streamContext.close();

  assert.deepEqual(errors, []);
  pass("Zero renderer page errors");
} catch (error) {
  failure = error.stack || String(error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  if (child?.exitCode === null && !child.signalCode) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await once(child, "exit"); } }
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, "receipt.json"), JSON.stringify({
    at: new Date().toISOString(),
    passed: !failure,
    layer: "Built React UI (scratch vite build) in headless Chrome; real isolated source server with a scratch home; fictional transcript seeded through the real Store",
    checks,
    errors,
    measurements,
    screenshots: shotList,
    limits: [
      "Fictional sample data only; not customer acceptance and not evidence that Bud produces charts from real office sources.",
      "No model or worker ran: chart blocks were seeded as saved replies, so whether a live model follows the chart instruction is unverified.",
      "The streaming case is the service's live-stream snapshot injected over a routed /api/events response, not a live token stream; the connection indicator may show reconnecting.",
      "Headless Chrome with reduced motion; the packaged desktop app, Windows and screen readers were not exercised.",
      "Phone channels (Telegram, Discord, Slack) were covered by unit tests only; no message was sent.",
    ],
    failure,
    ...(failure ? { diagnostic: logs } : {}),
  }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; }
}
