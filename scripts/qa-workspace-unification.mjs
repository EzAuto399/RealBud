#!/usr/bin/env node
// Built app, real local persistence, fictional transcript. No channel/provider calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/workspace-unification-2026-09-09/browser"));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to the installed playwright-core module.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const scratch = mkdtempSync(join(tmpdir(), "realbud-workspace-ux-"));
mkdirSync(out, { recursive: true });
const data = join(scratch, "data"); mkdirSync(data);
const env = { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, REALBUD_DATA_DIR: data, VITEST: "true" };
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Offline fixture" } } }));
const short = "Can you chase the repair quote for 14 Sample Street?";
const long = Array.from({ length: 12 }, (_, index) => `Property ${index + 1}: follow up on the repair quote and keep the owner informed.`).join("\n");
const sender = "Alexandra from the property management team with a longer name";
const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { Store } from './server/store.ts';
  const store = new Store(() => ({ instanceId: 'ghost', model: '' }));
  const bot = store.createBot();
  store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: ${JSON.stringify(`[Telegram · Yoda] ${short}`)}, parentId: null });
  store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'I can help prepare the follow-up. Which contractor is handling the repair?' });
  store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: ${JSON.stringify(`[Telegram · ${sender}] ${long}`)} });
  const blank = store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: '[Telegram · Yoda]' });
  store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: '[Telegram · Yoda] Original request', parentId: blank.id });
  store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'Original response (fictional).' });
  store.appendMessage(bot.threadId, { role: 'user', kind: 'text', text: 'Revised request', parentId: blank.id });
  store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'Revised response (fictional).' });
`], { cwd: root, env, encoding: "utf8" });
let child, browser, page, logs = "";
try {
  assert.equal(seed.status, 0, seed.stderr);
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server/index.ts")], { cwd: root, env: { ...env, OMB_PORT: String(port), OMB_STATIC_DIR: join(root, "dist") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  const until = async (check, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (await check().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Timed out: ${label}`);
  };
  await until(async () => (await fetch(`${base}/api/health`)).ok, "server startup");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => {
    localStorage.setItem("realbud.first-run-done", "1");
    window.copyAttempts = []; window.failCopy = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => {
      window.copyAttempts.push(text);
      if (window.failCopy) throw new Error("Fictional clipboard failure");
    } } });
  });
  page = await context.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.getByRole("button", { name: /^Ask\b/ }).first().click();
  const request = page.getByRole("article", { name: "Yoda · Telegram", exact: true }).filter({ hasText: short });
  await request.waitFor();
  assert.equal(await request.locator(".ask-request-body").innerText(), short);
  assert.equal(await request.locator("svg circle").count(), 1);
  await request.getByRole("button", { name: "Copy request", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copyAttempts.at(-1)), short);
  const composer = page.locator(".ask-composer textarea").first();
  await composer.fill("My unfinished desk request");
  await request.getByRole("button", { name: "Edit & resend", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Edit request", exact: true }).inputValue(), short);
  await page.keyboard.press("Escape");
  assert.equal(await composer.inputValue(), "My unfinished desk request");
  assert.equal(await request.getByRole("button", { name: "Edit & resend", exact: true }).evaluate(el => el === document.activeElement), true);
  const longRequest = page.getByRole("article", { name: `${sender} · Telegram`, exact: true });
  assert.equal(await longRequest.getByRole("button", { name: "Read full request" }).getAttribute("aria-expanded"), "false");
  await page.evaluate(() => { window.failCopy = true; });
  await longRequest.getByRole("button", { name: "Copy request", exact: true }).click();
  await longRequest.getByRole("button", { name: "Try copying again" }).waitFor();
  assert.equal(await longRequest.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded"), "true");
  await page.evaluate(() => { window.failCopy = false; });
  await longRequest.getByRole("button", { name: "Try copying again" }).click();
  assert.equal(await page.evaluate(() => window.copyAttempts.at(-1)), long);
  await longRequest.getByRole("button", { name: "Show less" }).click();
  const blank = page.getByRole("article", { name: "Yoda · Telegram", exact: true }).filter({ hasText: "No message text was saved." });
  assert.equal(await blank.getByRole("button").count(), 0);
  const versions = page.getByRole("navigation", { name: /^Request versions,/ });
  await versions.getByRole("button", { name: "Previous request version" }).click();
  await page.getByText("Original response (fictional).", { exact: true }).waitFor();
  assert.equal(await versions.evaluate(el => el === document.activeElement), true, "version switch keeps keyboard focus");
  assert.equal(await versions.getByRole("button", { name: "Previous request version" }).isDisabled(), true);
  await versions.getByRole("button", { name: "Next request version" }).click();
  await page.getByText("Revised response (fictional).", { exact: true }).waitFor();
  await page.reload(); await page.getByRole("button", { name: /^Ask\b/ }).first().click();
  await page.getByText("Revised response (fictional).", { exact: true }).waitFor();
  await request.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, "telegram-ask-desktop.png") });
  await request.screenshot({ path: join(out, "telegram-request-detail.png") });
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  const go = async name => { await nav.getByRole("button", { name, exact: true }).click(); };
  // Read older work, visit another screen, and return to the same position.
  await page.keyboard.press("PageUp");
  const thread = page.locator(".ask-thread");
  await thread.evaluate(el => { el.scrollTop = 35; });
  await until(async () => Math.abs(await thread.evaluate(el => el.scrollTop) - 35) < 2, "conversation position");
  await go("Desk");
  await page.getByRole("heading", { name: "Desk", exact: true }).waitFor();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  let setup = page.getByRole("dialog", { name: "Office connections", exact: true });
  await setup.waitFor();
  assert.equal(await page.locator(".rb-app-shell").getAttribute("inert"), "", "background is inert during setup");
  await setup.getByRole("button", { name: "Phone", exact: true }).click();
  setup = page.getByRole("dialog", { name: "Phone connections", exact: true });
  await setup.getByRole("region", { name: "Telegram", exact: true }).waitFor();
  assert.equal(await setup.getByRole("region", { name: "Telegram", exact: true }).locator("svg circle").count(), 1);
  const telegramSetup = setup.getByRole("region", { name: "Telegram", exact: true });
  await telegramSetup.getByRole("button", { name: "Connect", exact: true }).click();
  await telegramSetup.locator('input[type="password"]').fill("fictional-unsaved-token");
  await setup.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("dialog", { name: "Office connections", exact: true }).getByRole("button", { name: "Phone", exact: true }).click();
  setup = page.getByRole("dialog", { name: "Phone connections", exact: true });
  assert.equal(await setup.getByRole("region", { name: "Telegram", exact: true }).locator('input[type="password"]').inputValue(), "fictional-unsaved-token");
  await setup.getByRole("region", { name: "Telegram", exact: true }).locator('input[type="password"]').fill("");
  await setup.getByRole("region", { name: "Telegram", exact: true }).getByRole("button", { name: "Hide", exact: true }).click();
  await page.keyboard.press("Meta+3");
  await setup.waitFor();
  await page.screenshot({ path: join(out, "desk-phone-setup.png") });
  await setup.getByRole("button", { name: "Close Phone connections", exact: true }).click();
  await page.getByRole("heading", { name: "Desk", exact: true }).waitFor();
  await go("Ask");
  await until(async () => Math.abs(await thread.evaluate(el => el.scrollTop) - 35) < 3, "conversation position restored");
  assert.equal(await composer.inputValue(), "My unfinished desk request");
  await go("Schedule");
  await page.getByRole("heading", { name: "Schedule", exact: true }).waitFor();
  await page.getByRole("button", { name: "Write the steps myself", exact: true }).click();
  await page.getByRole("textbox", { name: "Job name", exact: true }).fill("Repair follow-up (fictional)");
  await page.getByRole("textbox", { name: "Inputs and context", exact: true }).fill("Review the supplied repair quote for 14 Sample Street.");
  await page.getByRole("textbox", { name: "Steps — one per line", exact: true }).fill("Read the supplied quote.\nPrepare a draft follow-up for review.");
  await page.getByRole("textbox", { name: "What should the result show?", exact: true }).fill("A draft follow-up with any missing facts marked.");
  // A failed refresh after a successful save must retry only the read.
  let failScheduleRefresh = true, saves = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/recipes" && req.method() === "POST") saves++; });
  await page.route("**/api/loops", route => failScheduleRefresh ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fictional refresh failure" }) }) : route.continue());
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  const partial = page.getByRole("alert").filter({ hasText: "Your job was saved, but its latest schedule and results could not be loaded." });
  await partial.waitFor();
  assert.equal(saves, 1, "one plan save");
  failScheduleRefresh = false;
  await partial.getByRole("button", { name: "Try again", exact: true }).click();
  await partial.waitFor({ state: "hidden" });
  assert.equal(saves, 1, "refresh recovery never repeats the save");
  assert.ok(await page.getByRole("region", { name: "Work context", exact: true }).filter({ hasText: "Repair follow-up" }).count());
  // Setup does not erase plan inputs or move the PM to another page.
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Bud", exact: true }).click();
  await page.getByRole("dialog", { name: "Set up Bud", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("textbox", { name: "Job name", exact: true }).inputValue(), "Repair follow-up (fictional)");
  await page.getByRole("button", { name: "Job plans", exact: true }).click();
  await page.screenshot({ path: join(out, "schedule-plan.png") });
  await go("You");
  await page.getByRole("heading", { name: "You", exact: true }).waitFor();
  await page.getByRole("button", { name: "Phone", exact: true }).click();
  await page.getByRole("region", { name: "Telegram", exact: true }).waitFor();
  await page.screenshot({ path: join(out, "you-phone.png") });
  await go("Schedule");
  assert.equal(await page.getByRole("textbox", { name: "Job name", exact: true }).inputValue(), "Repair follow-up (fictional)");
  // Carry a fictional saved-result reference into Ask and remove it explicitly.
  const roster = await (await fetch(`${base}/api/bots`)).json();
  const draftKey = `bot:${roster.bots[0].id}`;
  await page.evaluate(({ draftKey }) => {
    const rows = JSON.parse(localStorage.getItem("omb-draft-attachments") || "{}");
    rows[draftKey] = [{ kind: "paste", id: "job-result-fixture", label: "Repair follow-up (fictional)", text: "Fictional saved reference, not approval.", size: 38, lines: 1 }];
    localStorage.setItem("omb-draft-attachments", JSON.stringify(rows));
  }, { draftKey });
  await go("Ask");
  const reference = page.getByRole("region", { name: "Work context", exact: true }).filter({ hasText: "Repair follow-up (fictional)" });
  await reference.waitFor();
  assert.equal(await composer.inputValue(), "My unfinished desk request");
  await reference.getByRole("button", { name: "Remove work context: Repair follow-up (fictional)", exact: true }).click();
  await reference.waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), "My unfinished desk request");
  await go("Schedule");
  const timing = page.locator('input[type="time"][aria-label$="time of day"]').first();
  assert.ok(await timing.count(), "a routine timing control is available for the navigation check");
  {
    const timingLabel = await timing.getAttribute("aria-label");
    await timing.evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true; });
    await timing.fill("10:30");
    await go("Ask"); await go("Schedule");
    const retainedTiming = page.getByLabel(timingLabel, { exact: true });
    assert.equal(await retainedTiming.inputValue(), "10:30", "unsaved timing survives navigation");
  }
  // Unconfirmed actions need a persistent dismissible notice, never a timed disappearance.
  await go("Ask");
  await page.route("**/active-branch", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fictional action could not be confirmed" }) }));
  await versions.getByRole("button", { name: "Previous request version" }).click();
  const notice = page.getByRole("alert").filter({ hasText: "Fictional action could not be confirmed" });
  await notice.waitFor();
  const appeared = Date.now();
  await until(async () => Date.now() - appeared >= 6500, "error retention interval");
  await notice.getByRole("button", { name: "Dismiss message", exact: true }).click();
  await notice.waitFor({ state: "hidden" });
  await page.unroute("**/active-branch");
  for (const screen of ["Desk", "Schedule", "You"]) {
    await go(screen); await page.getByRole("heading", { name: screen, exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${screen} mobile overflow`);
    await page.screenshot({ path: join(out, `${screen.toLowerCase()}-390.png`) });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await go("Ask");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await request.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}px`);
    const bounds = await request.getByRole("button", { name: "Edit & resend" }).boundingBox();
    assert.ok(bounds.height >= 44, "mobile touch target");
    await longRequest.scrollIntoViewIfNeeded();
    assert.ok(await longRequest.evaluate(el => el.scrollWidth <= el.clientWidth), "long name fits message");
    await request.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `telegram-ask-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ["setup stays on Desk and Schedule", "shared phone mark", "setup fields survive section switching", "background inert and focus recovery", "conversation reading position", "plan save partial success and read-only retry", "plan retained across navigation", "unsaved routine timing", "persistent dismissible failure", "all four mobile screens", "remove work reference without losing wording", "channel mark and sender", "body-only copy", "edit body and cancel focus", "composer draft preserved", "clipboard failure expansion and retry", "empty legacy record", "version navigation, focus and persistence", "320px and 390px layout", "44px mobile actions", "no browser errors"], liveTelegram: false, liveModel: false };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  writeFileSync(join(out, "failure.log"), `${error.stack}\n${logs}`); throw error;
} finally {
  await browser?.close(); child?.kill("SIGTERM"); rmSync(scratch, { recursive: true, force: true });
}
