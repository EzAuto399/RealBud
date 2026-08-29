#!/usr/bin/env node
// Day-in-the-life personas over the real HTTP API. No engines required.
// Covers the people who actually touch RealBud: a new licensee on first
// paint, the morning Desk loop, Ask (connect / secrets), Schedule, and You.
//
//   node --experimental-strip-types scripts/e2e-day-in-life.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18881);
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "realbud-e2e-day-"));
mkdirSync(join(home, ".realbud"), { recursive: true });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

let session = "";
const api = async (method, path, body) => {
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leaked = (value, needle) => JSON.stringify(value ?? {}).includes(needle);

const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
  cwd: ROOT,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(PORT),
    REALBUD_DATA_DIR: join(home, ".realbud"),
    REALBUD_TOOL_VERIFY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    if (Date.now() > deadline) throw new Error(`server never came up.\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}.\n${stderr}`);
    await sleep(150);
  }
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("session issued", Boolean(session));

  // ── New licensee: first paint is a book, not a morning already run ──
  const firstPaint = (await api("GET", "/api/desk")).body;
  check("first paint is the practice book", firstPaint?.mode === "demo" && firstPaint.properties.length >= 6);
  check("opening Desk does not start Recheck", firstPaint.lastRunAt == null && firstPaint.drafts.length === 0);
  check("first-paint book has no tenant notes in the queue projection", firstPaint.properties.every((property) => property.notes === undefined));

  // ── Morning PM: Recheck → Allow → never send ──
  const morning = (await api("POST", "/api/desk/check", {})).body;
  check("Recheck produces exception cards", morning?.drafts?.some((draft) => draft.status === "pending"));
  const pending = morning.drafts.find((draft) => draft.status === "pending");
  const send = await api("POST", `/api/desk/drafts/${pending.id}/send`, {});
  check("send stays 403 for every persona", send.status === 403);
  const allowed = await api("POST", `/api/desk/drafts/${pending.id}/allow`, { expectedRevision: morning.revision });
  check("Allow records wording without a sentAt", allowed.status === 200 && allowed.body?.draft?.status === "allowed" && !("sentAt" in (allowed.body?.draft ?? {})));

  // ── Ask: named connect, secrets, linked tool ──
  const bots = (await api("GET", "/api/bots")).body?.bots ?? [];
  const bud = bots.find((bot) => bot.id === "bud" || bot.name === "Bud") ?? bots[0];
  check("Ask has one Bud", Boolean(bud?.id));
  const nameOnly = await api("POST", `/api/bots/${bud.id}/messages`, { text: "connect me to notion" });
  check("name-only Notion opens the card", nameOnly.status === 202 && nameOnly.body?.service === "Notion" && nameOnly.body?.connected !== true);
  check("name-only Notion navigates to the Ask card", nameOnly.body?.navigation === "connections");
  const pocket = await api("POST", `/api/bots/${bud.id}/messages`, { text: "Connect WhatsApp token=placeholder_credential_value_123" });
  check("WhatsApp token in Ask is refused", pocket.status === 400 && pocket.body?.code === "CREDENTIAL_IN_ASK");
  const notionKey = "ntn_qaonlydeadbeef88";
  const linked = await api("POST", `/api/bots/${bud.id}/messages`, { text: `connect me to notion ${notionKey}` });
  check("named-tool key connects without navigation", linked.status === 202 && linked.body?.connected === true && linked.body?.navigation == null);
  check("Ask transcript does not keep the Notion key", !leaked(linked.body, notionKey));
  const afterAsk = (await api("GET", `/api/bots/${bud.id}`)).body;
  check("stored Ask messages do not keep the Notion key", !leaked(afterAsk, notionKey));
  const sourcesOn = await api("GET", "/api/office-sources?services=notion");
  check("office-sources lists Notion as connected", sourcesOn.status === 200 && sourcesOn.body?.services?.notion?.connected === true);
  const unlinked = await api("DELETE", "/api/office-sources/notion");
  check("You can unlink Notion from the card", unlinked.status === 200);
  const sourcesOff = await api("GET", "/api/office-sources?services=notion");
  check("unlink clears the Notion office source", sourcesOff.body?.services?.notion?.connected !== true);
  const relinked = await api("POST", `/api/bots/${bud.id}/messages`, { text: `connect me to notion ${notionKey}` });
  check("the same named key can connect again", relinked.status === 202 && relinked.body?.connected === true);
  const peek = await api("POST", `/api/bots/${bud.id}/messages`, { text: "what can you see inside of notion" });
  const peekVoice = (peek.body?.bot?.messages ?? []).findLast((message) => message.role === "bot" && message.kind === "text");
  check("a Notion peek stays on the saved key and does not reopen Connect", peek.status === 202 && peek.body?.navigation == null && /on this device/i.test(peekVoice?.text ?? ""));
  check("Bud does not deny a key that is on this device", !/no connection is active|not read in this build|cannot read pages/i.test(JSON.stringify(peek.body?.bot?.messages ?? [])));
  const deskNow = (await api("GET", "/api/desk")).body;
  const needsMe = await api("POST", `/api/bots/${bud.id}/messages`, { text: "What needs me?" });
  const deskVoice = (needsMe.body?.bot?.messages ?? []).findLast((message) => message.role === "bot" && message.kind === "text");
  check("Desk Ask answers from the live queue without a model", needsMe.status === 202 && needsMe.body?.bot?.busy !== true && /On Desk now|Desk has no exceptions|Desk is in recovery/i.test(deskVoice?.text ?? ""));
  check("Desk Ask does not claim the cards were hidden", !/cards were not shared|cannot see Desk/i.test(deskVoice?.text ?? ""));
  const held = deskNow.properties?.find((property) =>
    deskNow.escalations?.some((item) => item.propertyId === property.id)
    || deskNow.drafts?.some((item) => item.propertyId === property.id && item.status === "pending"),
  );
  if (held?.address) {
    check("Desk Ask names a property that is actually waiting", deskVoice?.text?.includes(held.address));
  }

  // ── You: linked tool is visible, book stays practice ──
  const config = (await api("GET", "/api/config")).body;
  const notion = (config?.linkedTools ?? []).find((tool) => tool.slug === "notion");
  check("You config lists the linked Notion tool", notion?.connected === true && notion?.label === "Notion");
  check("config JSON does not contain the Notion key", !leaked(config, notionKey));
  const deskAfter = (await api("GET", "/api/desk")).body;
  check("a linked app does not make the book live", deskAfter.mode === "demo");

  // ── Schedule: named loops only; inbound stays declared ──
  const loops = (await api("GET", "/api/loops")).body;
  check(
    "Schedule exposes the three named loops",
    loops?.loops?.map((loop) => loop.id).join(",") === "morning-arrears,owner-letter,inbound-triage",
  );
  const inbound = await api("POST", "/api/loops/inbound-triage/run", {});
  check("inbound triage still refuses to run", inbound.status === 409);
  const morningLoop = loops.loops.find((loop) => loop.id === "morning-arrears");
  const letterLoop = loops.loops.find((loop) => loop.id === "owner-letter");
  check("Friday letter starts paused on a new book", letterLoop?.available === true && letterLoop?.enabled === false);
  const paused = await api("PATCH", `/api/loops/${morningLoop.id}`, { enabled: false, expectedRevision: morningLoop.revision });
  check("PM can pause the morning clock", paused.status === 200 && paused.body?.loop?.enabled === false);
  const resumed = await api("PATCH", `/api/loops/${morningLoop.id}`, { enabled: true, expectedRevision: paused.body.loop.revision });
  check("PM can resume the morning clock", resumed.status === 200 && resumed.body?.loop?.enabled === true);

  // ── Principal: turn on Friday letter, then copy-only ──
  const enabledLetter = await api("PATCH", `/api/loops/${letterLoop.id}`, { enabled: true, expectedRevision: letterLoop.revision });
  check("principal can turn on Friday letters", enabledLetter.status === 200 && enabledLetter.body?.loop?.enabled === true);
  const letterRun = await api("POST", "/api/loops/owner-letter/run", {});
  check("Friday letter run is accepted", letterRun.status === 201, `${letterRun.status} ${letterRun.body?.error ?? ""}`);
  const runDeadline = Date.now() + 20_000;
  let letterDraft = null;
  for (;;) {
    const snap = (await api("GET", "/api/desk")).body;
    letterDraft = snap.drafts?.find((draft) => draft.kind === "owner-letter" && draft.status === "pending");
    if (letterDraft) break;
    if (Date.now() > runDeadline) break;
    await sleep(200);
  }
  if (letterDraft) {
    check("Friday letter send is 403", (await api("POST", `/api/desk/drafts/${letterDraft.id}/send`, {})).status === 403);
  } else {
    check("Friday letter produced a pending draft", false, "no owner-letter draft");
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("close", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} day-in-the-life step(s) failed`);
  process.exit(1);
}
console.log("\nDay-in-the-life walkthrough complete.");
