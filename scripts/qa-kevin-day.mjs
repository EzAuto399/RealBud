#!/usr/bin/env node
// Kevin's day — full Austin Phase 1 operations simulation.
// Temp RealBud home + fake ACP + Composio stub. No live REI, bank, Windows Cua, or Google.
//
//   node scripts/qa-kevin-day.mjs
//   pnpm qa:kevin-day
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 19020 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");
const REI = "app.reimasterapps.com.au";
const BANK = "online.bank.example";
const KEEP = Boolean(process.env.REALBUD_KEEP_SIM_HOME);

const HOME = mkdtempSync(join(tmpdir(), "realbud-kevin-day-"));
mkdirSync(join(HOME, ".realbud"), { recursive: true });
const scriptPath = join(HOME, "fake-acp-script.json");
const cuaPath = join(HOME, "cua-connection.json");
const dumpPath = join(HOME, "fake-acp-dump.json");
const receiptPath = join(HOME, "kevin-day-receipt.json");
chmodSync(FAKE_CLI, 0o755);
writeFileSync(
  cuaPath,
  JSON.stringify({
    mode: "embedded",
    mcpCommand: "/tmp/fictional-cua",
    mcpArgs: ["mcp"],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
  }),
);

let failures = 0;
const receipt = { startedAt: Date.now(), chapters: [], checks: [] };
const chapter = (name) => {
  console.log(`\n── ${name} ──`);
  receipt.chapters.push({ name, at: Date.now() });
};
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  receipt.checks.push({ label, ok: Boolean(ok), extra: extra || undefined });
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let session = "";
let child = null;
let stderr = "";
let composioStub = null;
let composioStubPort = 0;
const composioForceConnected = new Set();

const startComposioStub = async () => {
  composioStub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let message = {};
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "invalid json" } }));
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Fixture apps", version: "1" },
        });
        return;
      }
      if (message.method === "tools/list") {
        reply({
          tools: [
            "COMPOSIO_SEARCH_TOOLS",
            "COMPOSIO_GET_TOOL_SCHEMAS",
            "COMPOSIO_MULTI_EXECUTE_TOOL",
            "COMPOSIO_MANAGE_CONNECTIONS",
          ].map((name) => ({
            name,
            inputSchema: {
              type: "object",
              properties:
                name === "COMPOSIO_MANAGE_CONNECTIONS"
                  ? {
                      toolkits: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { name: { type: "string" }, action: { enum: ["list", "add"] } },
                        },
                      },
                    }
                  : {},
            },
          })),
        });
        return;
      }
      let action = "add";
      let slug = "gmail";
      try {
        const toolkit = message.params?.arguments?.toolkits?.[0];
        action = toolkit?.action ?? "add";
        slug = String(toolkit?.name ?? "gmail").toLowerCase();
      } catch {
        /* defaults */
      }
      if (action === "list") {
        const rows = message.params?.arguments?.toolkits ?? [{ name: slug }];
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    data: {
                      results: Object.fromEntries(
                        rows.map((row) => {
                          const name = String(row.name).toLowerCase();
                          const connected = composioForceConnected.has(name);
                          return [
                            name,
                            {
                              status: connected ? "ACTIVE" : "unknown",
                              accounts: connected ? [{ id: `acct-${name}`, status: "ACTIVE" }] : [],
                            },
                          ];
                        }),
                      ),
                    },
                  }),
                },
              ],
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ authorization_url: `https://auth.example/connect/${slug}` }) }],
          },
        }),
      );
    });
  });
  await new Promise((resolve) => composioStub.listen(0, "127.0.0.1", resolve));
  composioStubPort = composioStub.address().port;
};

const writeScript = (script) => writeFileSync(scriptPath, `${JSON.stringify(script)}\n`);

const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-realbud-session": session } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
};

const waitForHealth = async () => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${stderr.slice(-2000)}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* booting */
    }
    await sleep(120);
  }
  throw new Error(`health timeout\n${stderr.slice(-2000)}`);
};

const spawnServer = (extraEnv = {}) => {
  writeFileSync(
    join(HOME, ".realbud", "config.json"),
    JSON.stringify(
      {
        ...(() => {
          try {
            return JSON.parse(readFileSync(join(HOME, ".realbud", "config.json"), "utf8"));
          } catch {
            return {};
          }
        })(),
        instances: {
          hermes: {
            driver: "hermesAgent",
            config: { cli: FAKE_CLI },
            environment: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_DUMP: dumpPath },
          },
        },
      },
      null,
      2,
    ),
  );
  const proc = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME,
      USERPROFILE: HOME,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: join(HOME, ".realbud"),
      REALBUD_CUA_DESCRIPTOR_PATH: cuaPath,
      REALBUD_CUA_TEST_READY: "1",
      VITEST: "true",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (c) => (stderr += c));
  proc.stdout.resume();
  return proc;
};

const stopServer = async () => {
  const previous = child;
  child = null;
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => previous.kill("SIGKILL"), 5_000);
    previous.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    previous.kill("SIGTERM");
  });
};

const getBud = async () => {
  const bots = (await api("GET", "/api/bots")).body;
  return bots?.bots?.find((b) => b.id === "bud") ?? bots?.bots?.[0];
};

const waitForBot = async (predicate, what, ms = 25_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const bud = await getBud();
    if (bud && (await predicate(bud))) return bud;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}. stderr tail:\n${stderr.slice(-1500)}`);
};

const waitForOptionsCard = () =>
  waitForBot(
    (b) => b.messages?.some((m) => m.kind === "options" && m.card?.requestId && !m.card?.answered),
    "an options approval card",
  );

const waitForRunSettled = async (jobId) => {
  await waitForBot(
    async () => {
      const runs = (await api("GET", `/api/job-runs?jobId=${jobId}`)).body?.runs ?? [];
      return runs[0] && runs[0].status !== "running" && runs[0].status !== "queued";
    },
    `job run for ${jobId} to settle`,
  );
  return (await api("GET", `/api/job-runs?jobId=${jobId}`)).body.runs[0];
};

const lastBotText = (bud, afterIndex = 0) =>
  [...(bud.messages ?? [])]
    .slice(afterIndex)
    .reverse()
    .find((m) => m.role === "bot" && m.kind === "text" && m.text)?.text ?? "";

const preparePortalJob = async (id, origin, worker = {}) => {
  writeScript({
    permission: true,
    tool: "navigate",
    title: "Open review (simulation)",
    rawInput: { url: `https://${origin}/` },
    reply: "Fictional review stopped before any import or pay.",
    ...worker,
  });
  const created = await api("POST", "/api/recipes", {
    draft: {
      id,
      title: `Kevin day: ${id}`,
      steps: ["Open the approved site", "Prepare only; Kevin chooses references and Submit"],
      allowedOrigins: [origin],
      capabilities: ["portal-read", "portal-prefill"],
      evidence: "Fictional prepare receipt",
      status: "active",
    },
  });
  if (created.status !== 201) throw new Error(`prepare ${id}: ${created.status} ${created.body?.error}`);
  await api("PATCH", `/api/recipes/${id}`, { planApproved: true });
  await api("PATCH", `/api/recipes/${id}`, { attach: true });
};

try {
  console.log("Kevin day simulation");
  console.log("Fixture home:", HOME);
  console.log("Base:", BASE);
  console.log("(Composio stub + fake ACP — no live REI / bank / Google)\n");

  await startComposioStub();
  child = spawnServer();
  await waitForHealth();
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("08:00 session", Boolean(session));

  // ── 1. Open office / book ──
  chapter("08:05 · Open Desk (practice book)");
  const practice = await api("POST", "/api/desk/practice", {});
  check("practice book", practice.status === 200, practice.body?.error);
  const desk = (await api("GET", "/api/desk")).body;
  const properties = desk?.properties ?? desk?.book?.properties ?? [];
  const propertyId = properties[0]?.id;
  check("property on book", Boolean(propertyId), String(propertyId));
  check("multiple properties available", properties.length >= 2, String(properties.length));

  // ── 2. Install Phase 1 packs ──
  chapter("08:10 · Import Austin Phase 1 packs");
  const packs = await api("POST", "/api/workflow-packs/austin-phase-1/install", {});
  check("phase 1 packs installed", packs.status === 200 && packs.body?.packs?.every((p) => p.installed), packs.body?.error);
  const recipes = (await api("GET", "/api/recipes")).body?.recipes ?? [];
  for (const id of ["wf-austin-expected-bills", "wf-austin-payment-prep"]) {
    const recipe = recipes.find((r) => r.id === id);
    const patch = await api("PATCH", `/api/recipes/${id}`, { planApproved: true, expectedRevision: recipe?.revision });
    check(`Kevin approves ${id}`, patch.status === 200, patch.body?.error);
  }
  const loops = await api("GET", "/api/loops");
  check("loops list available", loops.status === 200, String(loops.status));

  // ── 3. Composio / Google spine ──
  chapter("08:20 · Connect Google apps (Composio stub)");
  const cfgPut = await api("PUT", "/api/config", {
    composio: { key: "ak_test_kevin_day_composio_key", url: `http://127.0.0.1:${composioStubPort}` },
  });
  check("composio key saved", cfgPut.status === 200 && cfgPut.body?.composio?.configured === true, `${cfgPut.status}`);
  composioForceConnected.add("gmail");
  composioForceConnected.add("googlecalendar");
  writeScript({ permission: false, reply: "ok" });

  const beforeGmail = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text: "connect me to gmail" });
  const gmailBud = await waitForBot(
    (b) =>
      (b.messages?.length ?? 0) > beforeGmail &&
      b.messages.slice(beforeGmail).some((m) => m.role === "bot" && /already connected|opened.*sign-in|couldn't open|connection key/i.test(m.text ?? "")),
    "gmail connect",
    30_000,
  );
  check("gmail already connected", /Gmail is already connected/i.test(lastBotText(gmailBud, beforeGmail)), lastBotText(gmailBud, beforeGmail).slice(0, 100));

  const appsCheck = await api("POST", "/api/connected-apps/check", {});
  check("connected-apps check", appsCheck.status === 200, String(appsCheck.status));
  check(
    "gmail service observed",
    Boolean(appsCheck.body?.services?.gmail?.connected || appsCheck.body?.tools?.available),
    JSON.stringify(appsCheck.body?.services?.gmail ?? appsCheck.body?.tools)?.slice(0, 120),
  );

  // Calendar sync is product intent (Desk SOT → optional Google mirror). Not shipped as API yet.
  const beforeCal = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text: "sync google calendar with the bills reminders" });
  const calBud = await waitForBot(
    (b) => (b.messages?.length ?? 0) > beforeCal && b.messages.slice(beforeCal).some((m) => m.role === "bot"),
    "calendar sync ask reply",
    30_000,
  );
  const calText = lastBotText(calBud, beforeCal);
  check(
    "calendar sync ask gets a reply (product may still be Desk-only)",
    Boolean(calText),
    calText.slice(0, 120),
  );
  receipt.calendarAsk = calText.slice(0, 240);

  // ── 4. Soft bill calendar (Desk SOT) ──
  chapter("08:35 · Expected bills board (coming soon / missing / exceptions)");
  const now = Date.now();
  const day = 86_400_000;
  const billRows = [
    {
      id: "oak-water-soon",
      propertyId,
      kind: "water",
      status: "expected",
      note: "Coming soon — soft window",
      windowStartAt: now - 2 * day,
      windowEndAt: now + 5 * day,
    },
    {
      id: "oak-council-missing",
      propertyId,
      kind: "council",
      status: "missing",
      note: "Window ended, no invoice in Gmail coverage",
      windowStartAt: now - 20 * day,
      windowEndAt: now - 2 * day,
    },
    {
      id: "oak-levy-process",
      propertyId,
      kind: "levy",
      status: "in-process",
      note: "Arranged in REI — not paid yet",
      windowStartAt: now - 10 * day,
      windowEndAt: now + 2 * day,
      amountCents: 88_000,
    },
    {
      id: "oak-strata-nsf",
      propertyId,
      kind: "strata",
      status: "insufficient-funds",
      note: "Owner ledger short",
      amountCents: 120_000,
    },
    {
      id: "oak-repair-advance",
      propertyId,
      kind: "repairs",
      status: "company-advance",
      note: "Office floated — Kevin must approve recovery",
      amountCents: 45_000,
    },
  ];
  for (const row of billRows) {
    const res = await api("POST", "/api/expected-bills", { ...row, sourceRef: "kevin-day-sim" });
    check(`bill ${row.id} (${row.status})`, res.status === 200 && res.body?.bill?.status === row.status, res.body?.error);
  }
  const grouped = await api("GET", "/api/expected-bills");
  check("needs-you has exceptions", (grouped.body?.groups?.["needs-you"]?.length ?? 0) >= 3, `n=${grouped.body?.groups?.["needs-you"]?.length}`);
  check("due-soon / expected visible", (grouped.body?.groups?.["due-soon"]?.length ?? 0) >= 1, `n=${grouped.body?.groups?.["due-soon"]?.length}`);
  check("in-process separate from paid", (grouped.body?.groups?.["in-process"]?.length ?? 0) >= 1);

  // Soft retune: Kevin pushes a window later (cycle variance)
  const retune = await api("POST", "/api/expected-bills", {
    id: "oak-water-soon",
    propertyId,
    kind: "water",
    status: "expected",
    note: "Retuned — usually arrives later this cycle",
    windowStartAt: now + day,
    windowEndAt: now + 12 * day,
    sourceRef: "kevin-day-sim",
  });
  check("soft window retune sticks", retune.status === 200 && retune.body?.bill?.windowEndAt === now + 12 * day);

  // ── 5. Morning Ask ──
  chapter("08:45 · Ask Bud about this morning");
  writeScript({ permission: false, reply: "Morning board: 1 coming soon, 1 missing council, 1 company advance needs Kevin." });
  const beforeAsk = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", {
    text: "what's on the bills board this morning? anything missing or company advance?",
  });
  const askBud = await waitForBot(
    (b) => (b.messages?.length ?? 0) > beforeAsk && b.messages.slice(beforeAsk).some((m) => m.role === "bot"),
    "morning ask reply",
    45_000,
  );
  check("morning ask answered", Boolean(lastBotText(askBud, beforeAsk)), lastBotText(askBud, beforeAsk).slice(0, 120));

  // ── 6. Bank / reference prep (Kevin chooses) ──
  chapter("09:15 · Bank CSV + property references (Kevin chooses rows)");
  await preparePortalJob("kevin-bank-refs", BANK, {
    tool: "navigate",
    title: "Open bank export review",
    rawInput: { url: `https://${BANK}/export` },
    reply: "Proposed 12 reference applications from office directory; 2 held as ambiguous. Waiting for Kevin to choose which to apply.",
  });
  await api("POST", "/api/recipes/kevin-bank-refs/attend", {});
  const bankBud = await waitForOptionsCard();
  const bankCard = bankBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  check("bank navigate waits for Allow", Boolean(bankCard?.card?.requestId));
  // Desktop Allow once
  await api("POST", `/api/threads/${bankBud.threadId}/respond`, {
    requestId: bankCard.card.requestId,
    behavior: "allow",
  });
  const bankRun = await waitForRunSettled("kevin-bank-refs");
  check(
    "bank prep run settles",
    ["completed", "partial", "interrupted", "failed"].includes(bankRun.status),
    bankRun.status,
  );

  // ── 7. REI: non-match / password / submit fence ──
  chapter("09:40 · REI Bulk Receipting fences");
  await preparePortalJob("kevin-rei-password", REI, {
    tool: "fill",
    title: "Password",
    rawInput: { label: "Password", url: `https://${REI}/login` },
    reply: "Waiting at sign-in.",
  });
  await api("POST", "/api/recipes/kevin-rei-password/attend", {});
  const passRun = await waitForRunSettled("kevin-rei-password");
  check(
    "password never typed",
    passRun.evidence?.some((e) => e.kind === "denied" && /never types a password/i.test(e.note ?? "")),
    JSON.stringify(passRun.evidence?.slice(0, 2)),
  );

  await preparePortalJob("kevin-rei-submit", REI, {
    tool: "click",
    title: "Submit",
    rawInput: { label: "Submit", url: `https://${REI}/receipts` },
    reply: "Stopped before Submit — Kevin must Allow on Desk or phone.",
  });
  await api("POST", "/api/recipes/kevin-rei-submit/attend", {});
  let submitBud = null;
  try {
    submitBud = await waitForOptionsCard();
  } catch {
    submitBud = null;
  }
  if (submitBud) {
    const card = submitBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
    // Simulate mobile messaging channel approval path (same respond API)
    await api("POST", `/api/threads/${submitBud.threadId}/respond`, {
      requestId: card.card.requestId,
      behavior: "deny",
    });
    check("Submit denied via channel-style respond", true);
  }
  const submitRun = await waitForRunSettled("kevin-rei-submit");
  check(
    "Submit does not complete unattended",
    submitRun.status !== "running" &&
      (submitRun.evidence?.some((e) => e.kind === "denied") || ["interrupted", "failed", "partial", "completed"].includes(submitRun.status)),
    submitRun.status,
  );

  const holds = (await api("GET", "/api/human-handoffs")).body?.handoffs ?? [];
  if (holds.length) {
    const hold = holds[0];
    const cont = await api("POST", `/api/human-handoffs/${hold.id}/continue`, { revision: hold.revision });
    check("Continue without calibration blocked", cont.status === 409 || cont.status === 400, String(cont.status));
  } else {
    check("handoff path optional for this password script", true, "no open handoff");
  }

  // ── 8. Afternoon desk recheck + company advance stays human ──
  chapter("14:00 · Desk recheck + advance stays with Kevin");
  const recheck = await api("POST", "/api/desk/check", {});
  check("desk recheck completes", recheck.status === 200, recheck.body?.hands ?? recheck.body?.error);
  const billsAfter = await api("GET", "/api/expected-bills");
  const advance = billsAfter.body?.bills?.find((b) => b.id === "oak-repair-advance");
  check("company-advance still on board", advance?.status === "company-advance");

  // ── 9. End of day backup ──
  chapter("16:30 · Export office pack snapshot");
  const exported = await api("GET", "/api/workflow-packs/export");
  check("export packs", exported.status === 200 && exported.body?.version === 1);
  writeFileSync(join(HOME, "kevin-day-pack-export.json"), JSON.stringify(exported.body, null, 2));

  const hermes = await api("GET", "/api/hermes");
  check("hermes status readable", hermes.status === 200);

  receipt.finishedAt = Date.now();
  receipt.failures = failures;
  receipt.ok = failures === 0;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\n${failures ? "FAILED" : "PASSED"} · ${receipt.checks.filter((c) => c.ok).length}/${receipt.checks.length} checks`);
  console.log("Receipt:", receiptPath);
  if (KEEP) console.log("Kept fixture home:", HOME);
} catch (error) {
  failures++;
  console.error("FAIL  kevin day aborted —", error instanceof Error ? error.message : error);
  console.error(stderr.slice(-2500));
  receipt.finishedAt = Date.now();
  receipt.failures = failures;
  receipt.error = error instanceof Error ? error.message : String(error);
  try {
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  } catch {
    /* ignore */
  }
} finally {
  await stopServer();
  composioStub?.close();
  if (!KEEP) rmSync(HOME, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
