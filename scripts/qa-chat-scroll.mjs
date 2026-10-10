#!/usr/bin/env node
// Work thread scrolling with real wheel input: built React UI (scratch build,
// never the shared dist/) served by a real isolated source server with a
// scratch home and a long fictional transcript. No worker, model, channel or
// customer account is involved and nothing is sent.
//
//   pnpm exec vite build --outDir <scratch>/ui --emptyOutDir
//   REALBUD_UI_DIR=<scratch>/ui QA_LABEL=fixed PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… node scripts/qa-chat-scroll.mjs
//
// Every check is recorded (not thrown) so the same script can show which
// checks an older build fails. Exit code is 1 when any check fails.
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
const label = process.env.QA_LABEL ?? "run";
const output = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/chat-scroll-2026-10-10", label));
if (!process.env.REALBUD_UI_DIR) throw new Error("Set REALBUD_UI_DIR to a scratch vite build.");
const ui = resolve(process.env.REALBUD_UI_DIR);
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE.");
if (ui === resolve(root, "dist")) throw new Error("Build to a scratch directory; this script never serves the shared dist/.");
if (!existsSync(join(ui, "index.html"))) throw new Error(`No built UI at ${ui}.`);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
mkdirSync(output, { recursive: true });

const para = (i, n) => `Fictional note ${i}.${n}: the sample tenancy at ${10 + i} Example Street has a routine item to review. Nothing here is real office data; it only makes the conversation long enough to scroll.`;
const transcript = Array.from({ length: 24 }, (_, i) => [
  { role: "user", text: `Fictional question ${i + 1}: what is next for ${10 + i} Example Street?` },
  { role: "bot", text: [1, 2, 3].map((n) => para(i + 1, n)).join("\n\n") + (i === 23 ? "\n\nEnd of the fictional thread." : "") },
]).flat();

const scratch = mkdtempSync(join(realpathSync(tmpdir()), "realbud-chat-scroll-"));
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

const results = [], errors = [], shots = [];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
let child, browser, logs = "", failure;
const record = (viewport, check, pass, detail) => {
  results.push({ viewport, check, pass, detail });
  console.log(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} [${label} ${viewport}] ${check} ${JSON.stringify(detail)}`);
};

try {
  assert.equal(seed.status, 0, seed.stderr);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((done) => reservation.close(done));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env: { ...env, OMB_PORT: String(port), OMB_STATIC_DIR: ui }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { logs = (logs + bytes).slice(-20000); });
  const deadline = Date.now() + 15_000;
  while (!(await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false))) {
    if (Date.now() > deadline) throw new Error("Timed out: server startup");
    await wait(100);
  }
  const token = await readSessionToken(data);
  const headers = { "content-type": "application/json", "x-realbud-session": token };
  let onboarding = await (await fetch(`${base}/api/onboarding`, { headers })).json();
  for (const stage of ["office-rules", "complete"]) {
    const saved = await fetch(`${base}/api/onboarding`, { method: "PUT", headers, body: JSON.stringify({ expectedScope: onboarding.scope, expectedRevision: onboarding.revision, stage }) });
    onboarding = await saved.json();
    assert.equal(saved.status, 200, `Onboarding ${stage}: ${JSON.stringify(onboarding)}`);
  }

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const vp = `${viewport.width}x${viewport.height}`;
    // Motion left on: "Jump to latest" uses a smooth scroll for short jumps.
    const context = await browser.newContext({ viewport, reducedMotion: "no-preference" });
    await context.route("**/*", (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    await primeBrowserSession(context, base, token);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${vp}: ${error.message}`));
    const shot = async (name) => { const path = join(output, `${vp}-${name}.png`); await page.screenshot({ path }); shots.push(path); };
    const thread = page.locator(".ask-thread");
    const jump = page.getByRole("button", { name: "Jump to latest messages" });
    const metrics = () => thread.evaluate((el) => ({ distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    const pointAtThread = async () => {
      const box = await thread.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
    };
    const wheel = async (deltaY, times, gap = 30) => { for (let i = 0; i < times; i += 1) { await page.mouse.wheel(0, deltaY); await wait(gap); } };

    await page.goto(`${base}/#/desk`);
    await page.getByRole("heading", { name: "Desk", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Work\b/ }).first().click();
    await page.getByText("End of the fictional thread.").waitFor({ timeout: 15_000 });
    await thread.waitFor();
    await wait(800);

    // 1. long enough to scroll, opens at the end
    const start = await metrics();
    record(vp, "1 thread scrolls and opens at the end", start.scrollHeight > start.clientHeight + 400 && start.distance < 4, start);
    await shot("1-start");

    // 2. small upward wheel steps near the end stay up
    await pointAtThread();
    await wheel(-20, 6);
    await wait(600);
    const up = await metrics();
    const jumpAfterUp = await jump.isVisible();
    record(vp, "2 small upward wheel near the end stays up and shows Jump to latest", up.distance > 60 && jumpAfterUp, { ...up, jumpVisible: jumpAfterUp });
    await shot("2-wheel-up");

    // 3. wheel down to the end re-arms follow
    await pointAtThread();
    for (let i = 0; i < 30 && (await metrics()).distance >= 4; i += 1) await wheel(120, 1, 60);
    await wheel(120, 2, 60);
    await wait(500);
    const down = await metrics();
    const jumpAfterDown = await jump.isVisible();
    record(vp, "3 wheel down to the end hides Jump to latest", down.distance < 4 && !jumpAfterDown, { ...down, jumpVisible: jumpAfterDown });
    await shot("3-wheel-down");

    // 4. a short jump (within the smooth-scroll range) reaches the end
    await pointAtThread();
    await wheel(-100, 3, 60);
    await wait(500);
    const before = await metrics();
    const jumpShown = await jump.isVisible();
    if (jumpShown) {
      await shot("4a-before-jump");
      await jump.click();
      const samples = [];
      for (let i = 0; i < 8; i += 1) { samples.push((await metrics()).distance); await wait(100); }
      await wait(100);
      const after = await metrics();
      record(vp, "4 Jump to latest reaches the end", after.distance < 4 && !(await jump.isVisible()), { before: before.distance, samplesEvery100ms: samples, after: after.distance });
      await shot("4b-after-jump");
    } else {
      record(vp, "4 Jump to latest reaches the end", false, { before: before.distance, note: "Jump to latest was not visible after scrolling up 300px; could not click it" });
      await shot("4-no-jump");
    }

    // 5. height changes while following keep the latest in view
    await pointAtThread();
    for (let i = 0; i < 30 && (await metrics()).distance >= 4; i += 1) await wheel(120, 1, 60);
    await wait(400);
    const following = await metrics();
    const panel = page.locator("summary", { hasText: "Tasks, book & saved jobs" });
    const panelShown = await panel.isVisible().catch(() => false);
    if (panelShown) {
      await panel.click();
      await wait(600);
      const opened = await metrics();
      record(vp, "5a opening Tasks, book & saved jobs keeps the end in view", opened.distance < 4, { before: following, after: opened });
      await shot("5a-panel-open");
      await panel.click();
      await wait(400);
    } else {
      record(vp, "5a opening Tasks, book & saved jobs keeps the end in view", null, { note: "Panel not rendered: it needs a ready worker, which this fixture has none of" });
    }
    const composer = page.locator(".ask-composer textarea").first();
    const composerCount = await composer.count();
    const composerEditable = composerCount > 0 && (await composer.isEditable().catch(() => false));
    if (composerEditable) {
      const h0 = await composer.evaluate((el) => el.getBoundingClientRect().height);
      await composer.fill(Array.from({ length: 8 }, (_, i) => `Draft line ${i + 1} (not sent)`).join("\n"));
      await wait(600);
      const h1 = await composer.evaluate((el) => el.getBoundingClientRect().height);
      const grown = await metrics();
      record(vp, "5b composer growing to 8 lines keeps the end in view", h1 > h0 + 20 && grown.distance < 4, { composerHeight: [Math.round(h0), Math.round(h1)], ...grown });
      await shot("5b-composer-grown");
      await composer.fill("");
      await wait(400);
    } else {
      record(vp, "5b composer growing to 8 lines keeps the end in view", null, { note: "Composer textarea not editable in this fixture (no ready worker)", textareas: composerCount });
    }
    for (let i = 0; i < 30 && (await metrics()).distance >= 4; i += 1) { await pointAtThread(); await wheel(120, 1, 60); }
    await page.setViewportSize({ width: viewport.width, height: viewport.height - 200 });
    await wait(600);
    const shrunk = await metrics();
    // Chrome clamps scrollTop when the scroller shrinks, so 5c can pass without
    // any follow code; 5d grows the content itself (text reflows taller).
    record(vp, "5c window 200px shorter keeps the end in view", shrunk.distance < 4, { ...shrunk, note: "not discriminating: the browser clamps scrollTop to the new end" });
    await shot("5c-window-shorter");
    await page.setViewportSize(viewport);
    await wait(400);
    for (let i = 0; i < 30 && (await metrics()).distance >= 4; i += 1) { await pointAtThread(); await wheel(120, 1, 60); }
    await wait(400);
    const wide = await metrics();
    const narrowWidth = viewport.width >= 1000 ? 820 : Math.round(viewport.width * 0.75);
    await page.setViewportSize({ width: narrowWidth, height: viewport.height });
    await wait(600);
    const narrow = await metrics();
    // Content height (scrollHeight) or the thread's own height (clientHeight)
    // changes without a new message; without either change the check proves nothing.
    const changed = narrow.scrollHeight !== wide.scrollHeight || narrow.clientHeight !== wide.clientHeight;
    record(vp, `5d window ${narrowWidth}px wide (thread or content height changes) keeps the end in view`, changed ? narrow.distance < 4 : null, { before: wide, after: narrow });
    await shot("5d-window-narrower");
    await context.close();
  }
} catch (error) {
  failure = error.stack || String(error);
} finally {
  await browser?.close();
  if (child?.exitCode === null && !child.signalCode) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), wait(5000)]); if (child.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await once(child, "exit"); } }
  rmSync(scratch, { recursive: true, force: true });
  const failed = results.filter((r) => r.pass === false);
  writeFileSync(join(output, "receipt.json"), JSON.stringify({
    at: new Date().toISOString(),
    label,
    ui,
    passed: !failure && failed.length === 0,
    layer: "Built React UI (scratch vite build) in headless Chrome; real isolated source server with a scratch home; fictional transcript seeded through the real Store; real mouse.wheel input on .ask-thread",
    results,
    errors,
    screenshots: shots,
    limits: [
      "Fictional transcript only; no worker or model ran and no turn streamed, so follow during a live streamed reply is not exercised here.",
      "Headless Chrome; the packaged desktop app, Windows, trackpads with momentum and touch input were not exercised.",
      "null results mean the fixture could not show that surface, not a pass.",
    ],
    failure,
    ...(failure ? { diagnostic: logs } : {}),
  }, null, 2));
  if (failure) console.error(failure);
  if (failure || failed.length) process.exitCode = 1;
}
