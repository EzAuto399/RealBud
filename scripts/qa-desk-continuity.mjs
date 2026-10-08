#!/usr/bin/env node
// Built UI + real local API + fictional app provider. No customer data or live OAuth.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/desk-continuity-2026-09-09/browser"));
const runtime = process.env.PLAYWRIGHT_MODULE;
if (!runtime) throw new Error("Set PLAYWRIGHT_MODULE to the installed playwright or playwright-core module.");
const { chromium } = await import(runtime);
const scratch = mkdtempSync(join(tmpdir(), "realbud-continuity-"));
mkdirSync(outDir, { recursive: true });
const dataDir = join(scratch, "data"); mkdirSync(dataDir);
const cli = join(scratch, "worker.mjs");
writeFileSync(cli, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.0 (2026.8.31)');\n`); chmodSync(cli, 0o755);
const fixtureKey = "ak_fictional_desk_continuity_key";
let active = false, signingIn = false, fail = false;
const calls = [];
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const message = JSON.parse(raw); calls.push({ method: message.method, params: message.params });
  if ((req.headers["x-api-key"] ?? req.headers["x-consumer-api-key"]) !== fixtureKey || fail) { res.writeHead(503).end(); return; }
  if (message.id === undefined) { res.writeHead(202).end(); return; }
  let result = {};
  if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Fictional office", version: "1" } };
  if (message.method === "tools/list") result = { tools: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS"].map(name => ({ name, inputSchema: { type: "object", properties: name === "COMPOSIO_MANAGE_CONNECTIONS" ? { toolkits: { type: "array", items: { type: "object" } } } : {} } })) };
  if (message.method === "tools/call") {
    assert.equal(message.params.name, "COMPOSIO_MANAGE_CONNECTIONS", "walkthrough must never execute an app tool");
    const rows = message.params.arguments.toolkits;
    if (rows.some(row => row.action === "add")) {
      signingIn = true;
      result = { content: [{ type: "text", text: JSON.stringify({ redirect_url: "https://signin.example.test/gmail" }) }] };
    } else {
      assert.ok(rows.every(row => row.action === "list"));
      result = { content: [{ type: "text", text: JSON.stringify({ data: { results: Object.fromEntries(rows.map(row => [row.name, {
        status: row.name === "gmail" ? active ? "ACTIVE" : signingIn ? "INITIATED" : "unknown" : "unknown",
        accounts: row.name === "gmail" && (active || signingIn) ? [{ id: "fictional-office", label: "PM office (fictional)", status: active ? "ACTIVE" : "INITIATED" }] : [],
      }])) } }) }] };
    }
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
const finishFirstRun = async base => {
  // First run is a server receipt (/api/onboarding), not a browser flag: walk the
  // profile -> office-rules -> complete stages without seeding the sample desk.
  const headers = { "content-type": "application/json", "x-realbud-session": await readSessionToken(dataDir) };
  let state = await (await fetch(`${base}/api/onboarding`, { headers })).json();
  for (const stage of ["office-rules", "complete"]) {
    const saved = await fetch(`${base}/api/onboarding`, { method: "PUT", headers, body: JSON.stringify({ expectedScope: state.scope, expectedRevision: state.revision, stage }) });
    state = await saved.json();
    assert.equal(saved.status, 200, `Onboarding ${stage} failed: ${JSON.stringify(state)}`);
  }
};
let child, browser, page, logs = "";
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ composio: { key: fixtureKey, url: `http://127.0.0.1:${provider.address().port}/mcp` }, instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_DATA_DIR: dataDir, REALBUD_HERMES_CLI: cli, OMB_PORT: String(port), OMB_STATIC_DIR: process.env.REALBUD_UI_DIR ?? join(root, "dist"), VITEST: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  const until = async (check, label, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  await until(async () => (await fetch(`${base}/api/health`)).ok, "server startup");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await primeBrowserSession(context, base, await readSessionToken(dataDir));
  await context.route("https://signin.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Fictional sign-in</h1>" }));
  await finishFirstRun(base);
  page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.getByRole("button", { name: /^Work\b/ }).first().click();
  const composer = page.locator("textarea").first();
  const draft = "Chase the repair quote for 14 Sample Street.";
  await composer.fill(draft);
  await page.getByRole("button", { name: "Add files or apps", exact: true }).click();
  await page.getByRole("dialog", { name: "Add to your work" }).getByRole("button", { name: "Connect an app", exact: true }).click();
  const connections = page.getByRole("dialog", { name: "Office connections", exact: true });
  // Connections are activated by the administrator (fictional key in config.json), not typed in Work.
  await connections.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await until(async () => signingIn, "fictional sign-in request");
  active = true; await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await connections.waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), draft, "connecting keeps the PM draft");
  await page.getByRole("button", { name: "Add files or apps", exact: true }).click();
  await page.getByRole("dialog", { name: "Add to your work" }).getByText("Available", { exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "ask-connected-desktop.png") });
  await page.keyboard.press("Escape");
  const ask = async text => { await composer.fill(text); await composer.press("Enter"); await until(async () => !(await composer.inputValue()), "Ask accepts product control"); };
  await ask("what are we connected to?");
  await until(async () => /Gmail.*connected/.test(await page.locator("main").innerText()), "live inventory reply");
  await composer.fill(draft);
  // Connected apps stay available in Ask — no per-turn on/off control.
  assert.equal(await page.getByRole("button", { name: /Turn off Gmail in Ask/i }).count(), 0);
  assert.equal(await page.locator(".ask-composer-frame").getByText(/Gmail/).count(), 0, "connected apps do not add persistent composer badges");
  assert.equal(await composer.inputValue(), draft);
  await ask("what are we connected to?");
  await until(async () => /Gmail.*connected/i.test(await page.locator("main").innerText()), "connected source stays available in Ask");
  await ask("Schedule something for me");
  await until(async () => (await page.locator("main").innerText()).includes("Nothing has changed yet"), "schedule reply");
  await composer.fill(draft);
  await page.getByRole("button", { name: "Schedule work", exact: true }).last().click();
  const schedule = page.getByRole("dialog", { name: "Schedule work", exact: true }); await schedule.waitFor();
  await schedule.getByRole("button", { name: "Teach Bud a job", exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "schedule-within-ask.png") });
  await schedule.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
  assert.equal(await schedule.isVisible(), true, "IME Escape keeps schedule open");
  await page.keyboard.press("Escape"); await schedule.waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), draft, "closing schedule preserves work");
  await page.getByRole("button", { name: "Schedule work", exact: true }).last().click();
  await schedule.getByRole("button", { name: "Open Schedule", exact: true }).click();
  await page.getByRole("heading", { name: "Schedule", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Work\b/ }).first().click();
  assert.equal(await composer.inputValue(), draft, "schedule navigation preserves work");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add files or apps", exact: true }).click();
  await page.getByRole("dialog", { name: "Add to your work" }).getByText("Available", { exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "ask-sources-mobile.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow");
  fail = true;
  await page.getByRole("dialog", { name: "Add to your work" }).getByRole("button", { name: "Check access", exact: true }).click();
  await until(async () => /Couldn’t check office apps|Could not verify app access/.test(await page.getByRole("dialog", { name: "Add to your work" }).innerText()), "failed refresh visible");
  fail = false;
  await page.getByRole("dialog", { name: "Add to your work" }).getByRole("button", { name: "Check access", exact: true }).click();
  await until(async () => (await page.getByRole("dialog", { name: "Add to your work" }).innerText()).includes("Available"), "refresh recovery restores source availability");
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ["draft survives setup", "automatic OAuth return refresh", "live deterministic inventory", "source remains available", "source state survives refresh", "schedule stays in Ask", "mobile overflow", "failed refresh and recovery", "no browser errors"], liveProvider: false, liveModel: false, providerRequests: calls.length, signInRequests: calls.filter(call => call.params?.arguments?.toolkits?.some(row => row.action === "add")).length, mailboxOperations: 0 };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(outDir, "failure-screenshot.png") }).catch(() => {});
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ passed: false, error: error.message }));
  writeFileSync(join(outDir, "failure.log"), `${error.stack}\n${logs}`); throw error;
} finally {
  await browser?.close(); child?.kill("SIGTERM"); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
