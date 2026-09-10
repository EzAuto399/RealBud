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
const out = resolve(process.env.QA_OUTPUT ?? join(root, "outputs/telegram-ask-ux-2026-09-09/browser"));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error("Set PLAYWRIGHT_MODULE to the installed playwright-core module.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const scratch = mkdtempSync(join(tmpdir(), "realbud-message-ux-"));
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => {
    localStorage.setItem("realbud.first-run-done", "1");
    window.copyAttempts = []; window.failCopy = false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => {
      window.copyAttempts.push(text);
      if (window.failCopy) throw new Error("Fictional clipboard failure");
    } } });
  });
  page = await context.newPage(); const errors = [], messageWrites = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => { if (req.method() === "POST" && /\/messages(?:\/[^/]+\/edit)?$/.test(new URL(req.url()).pathname)) messageWrites.push(req.url()); });
  await page.goto(base); await page.getByRole("button", { name: /^Ask\b/ }).first().click();
  const request = page.getByRole("article", { name: "Yoda · Telegram", exact: true }).filter({ hasText: short });
  await request.waitFor();
  assert.equal(await request.locator(".ask-request-body").innerText(), short);
  assert.equal(await request.locator("svg circle").count(), 1);
  await request.getByRole("button", { name: "Copy request", exact: true }).click();
  assert.equal(await page.evaluate(() => window.copyAttempts.at(-1)), short);
  const composer = page.locator(".ask-composer textarea").first();
  // Product status requests remain available without a live model. Exercise
  // composition keys on an enabled composer without sending any work.
  await composer.fill("What's connected?");
  await composer.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: false, bubbles: true });
  assert.equal(await composer.inputValue(), "What's connected?", "IME final key cannot submit");
  await composer.fill("My unfinished desk request");
  await request.getByRole("button", { name: "Edit & resend", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Edit request", exact: true }).inputValue(), short);
  const editor = page.getByRole("textbox", { name: "Edit request", exact: true });
  await editor.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
  assert.equal(await editor.isVisible(), true, "IME Escape cannot cancel an edit");
  await editor.dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: false, bubbles: true });
  assert.equal(await editor.isVisible(), true, "IME final Enter cannot submit an edit");
  assert.equal(await editor.inputValue(), short);
  await page.keyboard.press("Escape");
  assert.equal(await composer.inputValue(), "My unfinished desk request");
  assert.equal(await request.getByRole("button", { name: "Edit & resend", exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByRole("button", { name: "Continue on phone", exact: true }).click();
  const phone = page.getByRole("dialog", { name: "Phone connections", exact: true });
  await phone.waitFor();
  await phone.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
  assert.equal(await phone.isVisible(), true, "IME Escape keeps setup open");
  await page.keyboard.press("Escape");
  await phone.waitFor({ state: "hidden" });
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
  assert.deepEqual(messageWrites, [], "composition checks must not send or edit work");
  const result = { passed: true, checks: ["channel mark and sender", "body-only copy", "edit body and cancel focus", "IME Enter and Escape preserve drafts", "composer draft preserved", "clipboard failure expansion and retry", "empty legacy record", "version navigation, focus and persistence", "320px and 390px layout", "44px mobile actions", "no browser errors"], liveTelegram: false, liveModel: false };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  writeFileSync(join(out, "failure.log"), `${error.stack}\n${logs}`); throw error;
} finally {
  await browser?.close(); child?.kill("SIGTERM"); rmSync(scratch, { recursive: true, force: true });
}
