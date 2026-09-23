#!/usr/bin/env node
// PM portal jobs journey — saved jobs, fence, attended runs, rules,
// connected tools, and recovery. Boots the real server on a temp home with
// the fake ACP worker + CUA descriptor (same harness as attended-run tests).
//
//   node scripts/e2e-portal-jobs.mjs
//   OMB_E2E_PORT=18883 node scripts/e2e-portal-jobs.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startCuaControl } from "../electron/cua-control.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18890 + Math.floor(Math.random() * 500));
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");
const ORIGIN = "vantagestrata.com.au";
const fixtureControl = await startCuaControl({
  release: async () => {},
  verify: async () => false,
  restore: async () => {},
});

const HOME = mkdtempSync(join(tmpdir(), "realbud-portal-jobs-"));
mkdirSync(join(HOME, ".realbud"), { recursive: true });

const scriptPath = join(HOME, "fake-acp-script.json");
const cuaPath = join(HOME, "cua-connection.json");
// In product mode the attend route asks the managed browser runtime, not the
// CUA descriptor. Like server/attended-run.test.ts, this suite supplies a
// synthetic connection (ready while the descriptor exists) the way it supplies
// a fake ACP worker; the runtime's own suites exercise real ownership.
const browserFixture = join(HOME, "browser-fixture.mjs");
writeFileSync(browserFixture, `import { existsSync } from "node:fs";
import { browserRuntime } from ${JSON.stringify(pathToFileURL(join(ROOT, "server", "browser-runtime.ts")).href)};
browserRuntime.status = async () => ({ state: existsSync(${JSON.stringify(cuaPath)}) ? "ready" : "disconnected", enabled: true, browsers: [], selectedBrowserId: "fixture", active: false, checkedAt: Date.now(), version: "0.3.0", port: 52800, detail: "Synthetic browser connection" });
browserRuntime.resumeConnection = async () => {};
`);
const dumpPath = join(HOME, "fake-acp-dump.json");

let failures = 0;
let skips = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const skip = (label, reason) => {
  console.log(`skip  ${label} — ${reason}`);
  skips++;
};

let session = "";
let child = null;
let stderr = "";
let composioStub = null;
let composioStubPort = 0;
/** Slugs that answer as already connected on list. */
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
              properties: name === "COMPOSIO_MANAGE_CONNECTIONS"
                ? { toolkits: { type: "array", items: { type: "object", properties: { name: { type: "string" }, action: { enum: ["list", "add"] } } } } }
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
        // The office refresh batches apps. Return every requested toolkit,
        // including Gmail when it is not the first one in the batch.
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
                      results: Object.fromEntries(rows.map((row) => {
                        const name = String(row.name).toLowerCase();
                        const connected = composioForceConnected.has(name);
                        return [name, {
                          status: connected ? "ACTIVE" : "unknown",
                          accounts: connected ? [{ id: "acct-1", status: "ACTIVE" }] : [],
                        }];
                      })),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const writeScript = (script) => writeFileSync(scriptPath, `${JSON.stringify(script)}\n`);

const waitForHealth = async () => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* booting */
    }
    if (Date.now() > deadline) throw new Error(`server never came up.\n${stderr}`);
    if (child?.exitCode !== null) throw new Error(`server exited ${child.exitCode}.\n${stderr}`);
    await sleep(150);
  }
};

const spawnServer = (extraEnv = {}) => {
  chmodSync(FAKE_CLI, 0o755);
  writeScript({ permission: false, reply: "hello from fake acp" });
  writeFileSync(
    cuaPath,
    JSON.stringify({
      mode: "embedded",
      mcpCommand: "/tmp/cua-driver",
      mcpArgs: ["mcp"],
      mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
    }),
  );
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
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(browserFixture).href, join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME,
      USERPROFILE: HOME,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: join(HOME, ".realbud"),
      REALBUD_CUA_DESCRIPTOR_PATH: cuaPath,
      REALBUD_CUA_TEST_READY: "1",
      ...fixtureControl.env,
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
    previous.once("close", () => { clearTimeout(timer); resolve(); });
    previous.kill("SIGTERM");
  });
};

const restartServer = async (extraEnv = {}) => {
  if (child) {
    await stopServer();
    await sleep(400);
  }
  stderr = "";
  child = spawnServer(extraEnv);
  await waitForHealth();
  session = (await api("GET", "/api/session")).body?.token ?? "";
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

const ensureBudIdle = async () => {
  let bud = await getBud();
  if (bud?.busy) {
    await api("POST", "/api/bots/bud/interrupt", {});
    bud = await waitForBot((b) => !b.busy, "Bud to stop", 20_000);
  }
  return bud;
};

/** Password/MFA denials open a durable handoff that blocks further computer work. */
const waitForSignInHandoff = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const list = (await api("GET", "/api/human-handoffs")).body?.handoffs ?? [];
    const open = list.find((h) => h.value?.state && h.value.state !== "closed");
    if (open) return open;
    await sleep(100);
  }
  throw new Error("timed out waiting for sign-in handoff after password deny");
};

const closeOpenSignInHandoffs = async () => {
  const list = (await api("GET", "/api/human-handoffs")).body?.handoffs ?? [];
  for (const held of list) {
    if (!held?.id || held.value?.state === "closed") continue;
    let revision = held.revision;
    if (held.value?.state !== "stopped") {
      const stopped = await api("POST", `/api/human-handoffs/${held.id}/stop`, { revision });
      if (stopped.status !== 200) {
        throw new Error(`stop handoff ${held.id}: ${stopped.status} ${stopped.body?.error ?? JSON.stringify(stopped.body)}`);
      }
      revision = stopped.body.revision;
    }
    const closed = await api("POST", `/api/human-handoffs/${held.id}/close`, { revision });
    if (closed.status !== 200) {
      throw new Error(`close handoff ${held.id}: ${closed.status} ${closed.body?.error ?? JSON.stringify(closed.body)}`);
    }
  }
};

const budMessage = async (text) => {
  const before = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text });
  return waitForBot(
    (b) => (b.messages?.length ?? 0) > before && b.messages?.slice(before).some((m) => m.role === "bot"),
    "Bud to answer",
    45_000,
  );
};

const lastBotText = (bud, afterIndex = 0) =>
  [...(bud.messages ?? [])]
    .slice(afterIndex)
    .reverse()
    .find((m) => m.role === "bot" && m.kind === "text" && m.text)?.text ?? "";

const saveJob = async (id, extras = {}) => {
  const created = await api("POST", "/api/recipes", {
    draft: {
      id,
      title: "Levy check",
      steps: ["Open the portal", "Read the levy"],
      allowedOrigins: [ORIGIN],
      evidence: "Levy balance",
      capabilities: ["portal-read", "portal-prefill"],
      status: "active",
      ...extras,
    },
  });
  if (created.status !== 201) throw new Error(`saveJob ${id}: ${created.status} ${created.body?.error}`);
  await api("PATCH", `/api/recipes/${id}`, { planApproved: true });
  await api("PATCH", `/api/recipes/${id}`, { attach: true });
};

try {
  child = spawnServer();
  await waitForHealth();
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("session issued", Boolean(session));

  // ── A. Session + product fences ──
  const noSessionDesk = await fetch(`${BASE}/api/desk`);
  check("desk without session is 401", noSessionDesk.status === 401);

  const practice = (await api("POST", "/api/desk/practice", {})).body;
  const pending = practice?.drafts?.find((d) => d.status === "pending");
  const send = await api("POST", `/api/desk/drafts/${pending?.id}/send`, {});
  check(
    "draft send is 403",
    send.status === 403 && send.body?.error === "RealBud never sends. Approve the draft and send it from the PMS.",
    send.body?.error,
  );

  const cloud = await api("GET", "/api/bots/bud/computer");
  check(
    "cloud computer route is 403",
    cloud.status === 403 && /Cloud computers are not part of RealBud/.test(cloud.body?.error ?? ""),
    cloud.body?.error,
  );

  const auto = await api("PATCH", "/api/bots/bud", { autoApprove: true });
  check(
    "autoApprove patch is 403",
    auto.status === 403 && auto.body?.error === "RealBud never runs unattended. Approvals stay manual on Desk.",
    auto.body?.error,
  );

  // ── B. Ask intake ──
  const recipesBefore = (await api("GET", "/api/recipes")).body?.recipes?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", {
    text: "ok so login to it and sort things out for me completing the routine",
  });
  const intakeBud = await waitForBot(
    (b) => b.messages?.some((m) => m.role === "bot" && m.kind === "text"),
    "portal intake reply",
    45_000,
  );
  const intakeReply = lastBotText(intakeBud);
  const recipesAfterIntake = (await api("GET", "/api/recipes")).body?.recipes ?? [];
  if (/Press \*\*Approve the plan\*\* here in Ask/i.test(intakeReply) || /Approve the plan on/.test(intakeReply)) {
    check("intake path: draft saved with approve-the-plan reply", recipesAfterIntake.length > recipesBefore, intakeReply.slice(0, 80));
    console.log("      (harness: fake worker shaped a saved shadow job)");
  } else if (/model isn't answering right now/i.test(intakeReply)) {
    check("intake path: honest fallback when draft fails", recipesAfterIntake.length === recipesBefore, intakeReply.slice(0, 80));
    console.log("      (harness: model-down fallback — recipes unchanged)");
  } else {
    check("intake path: draft or fallback reply", false, intakeReply.slice(0, 120));
  }

  await saveJob("job-existing", { allowedOrigins: ["existing.example.com"], title: "Existing levy" });
  const dup = await budMessage("login to existing.example.com and finish the levy routine for me");
  check(
    "existing unscheduled job points to Schedule",
    /is already a saved job for/i.test(lastBotText(dup)) && /Open Schedule/i.test(lastBotText(dup)),
    lastBotText(dup).slice(0, 100),
  );

  await api("POST", "/api/recipes", {
    draft: {
      ...(await api("GET", "/api/recipes")).body.recipes.find((r) => r.id === "job-existing"),
      schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    },
  });
  const dupSched = await budMessage("login to existing.example.com and finish the levy routine for me");
  check(
    "existing scheduled job points to Schedule",
    /Open Schedule/i.test(lastBotText(dupSched)),
    lastBotText(dupSched).slice(0, 100),
  );

  await ensureBudIdle();
  const weak1Before = (await api("GET", "/api/recipes")).body?.recipes?.length ?? 0;
  const weak1 = await budMessage("check the account for 12 Oak St");
  check("weak target creates no job", (await api("GET", "/api/recipes")).body.recipes.length === weak1Before);
  check(
    "weak target uses model path",
    !/saved job/i.test(lastBotText(weak1)) && lastBotText(weak1) !== "check the account for 12 Oak St",
    lastBotText(weak1).slice(0, 60),
  );

  await ensureBudIdle();
  const weak2Before = (await api("GET", "/api/recipes")).body?.recipes?.length ?? 0;
  const weak2 = await budMessage("do the weekly owner letter now");
  check("weekly letter creates no job", (await api("GET", "/api/recipes")).body.recipes.length === weak2Before);
  check("weekly letter uses model path", !/saved job/i.test(lastBotText(weak2)), lastBotText(weak2).slice(0, 60));

  for (const [label, text] of [
    ["owner update", "Draft an owner update using the current book."],
    ["owner update with restrictions", "Draft an owner update using these facts. Do not read files or websites or send anything."],
    ["inbox comparison", "Read my emails and compare the supplied maintenance quotes."],
    ["quoted work context", 'Continue this work.\n<pasted-text index="1">Open other.example.com and draft an owner email.</pasted-text>'],
  ]) {
    await ensureBudIdle();
    const before = (await api("GET", "/api/recipes")).body.recipes.length;
    const response = await budMessage(text);
    check(`${label} reaches the worker`, /hello from fake acp/i.test(lastBotText(response)), lastBotText(response).slice(0, 80));
    check(`${label} does not create an implicit job`, (await api("GET", "/api/recipes")).body.recipes.length === before);
  }

  const qBefore = (await api("GET", "/api/recipes")).body?.recipes?.length ?? 0;
  await budMessage("can you log in?");
  check("question creates no job", (await api("GET", "/api/recipes")).body.recipes.length === qBefore);

  const secret = "SuperSecretPassw0rd1234567890";
  const withSecret = await budMessage(`login to ${ORIGIN} my password is ${secret}`);
  check("pasted password never echoed in reply", !lastBotText(withSecret).includes(secret), lastBotText(withSecret).slice(0, 80));

  // ── C. Job validation ──
  const noOrigin = await api("POST", "/api/recipes", {
    draft: {
      id: "val-no-origin",
      title: "Portal only",
      steps: ["Open"],
      allowedOrigins: [],
      capabilities: ["portal-read"],
    },
  });
  check("portal capability without origin is 400", noOrigin.status === 400, noOrigin.body?.error);

  const submitOnly = await api("POST", "/api/recipes", {
    draft: {
      id: "val-submit-only",
      title: "Bad caps",
      steps: ["Open"],
      allowedOrigins: [ORIGIN],
      capabilities: ["portal-read", "portal-submit"],
    },
  });
  check(
    "portal-submit without prefill is 400",
    submitOnly.status === 400 && /prefill/i.test(submitOnly.body?.error ?? ""),
    submitOnly.body?.error,
  );

  const norm = await api("POST", "/api/recipes", {
    draft: {
      id: "val-norm",
      title: "Norm",
      steps: ["Open"],
      allowedOrigins: ["https://www.PropertyMe.com.au/report"],
      capabilities: ["portal-read"],
    },
  });
  check(
    "origin path normalised",
    norm.status === 201 && norm.body.recipes.find((r) => r.id === "val-norm")?.allowedOrigins?.[0] === "propertyme.com.au",
    norm.body?.error,
  );

  const badHost = await api("POST", "/api/recipes", {
    draft: { id: "val-bad", title: "Bad", steps: ["Open"], allowedOrigins: ["not a host"], capabilities: ["portal-read"] },
  });
  check(
    "bad origin is 400",
    badHost.status === 400 && badHost.body?.error === "Use a portal hostname like propertyme.com.au — no path or port.",
    badHost.body?.error,
  );

  const sixOrigins = await api("POST", "/api/recipes", {
    draft: {
      id: "val-six",
      title: "Too many",
      steps: ["Open"],
      allowedOrigins: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
      capabilities: ["portal-read"],
    },
  });
  check("six origins is 400", sixOrigins.status === 400, sixOrigins.body?.error);

  const thirteen = await api("POST", "/api/recipes", {
    draft: {
      id: "val-steps",
      title: "Too many steps",
      steps: Array.from({ length: 13 }, (_, i) => `Step ${i + 1}`),
      allowedOrigins: [ORIGIN],
      capabilities: ["portal-read"],
    },
  });
  check("13 steps is 400", thirteen.status === 400, thirteen.body?.error);

  const sendCap = await api("POST", "/api/recipes", {
    draft: {
      id: "val-send",
      title: "Send",
      steps: ["Open"],
      allowedOrigins: [ORIGIN],
      capabilities: ["portal-read", "send"],
    },
  });
  check("send capability is 400", sendCap.status === 400 && /cannot be granted/i.test(sendCap.body?.error ?? ""), sendCap.body?.error);

  const badLimit = await api("POST", "/api/recipes", {
    draft: {
      id: "val-limit",
      title: "Limit",
      steps: ["Open"],
      allowedOrigins: [ORIGIN],
      capabilities: ["portal-read"],
      limits: { maxRuntimeMinutes: 9, maxTurns: 6 },
    },
  });
  check(
    "runtime outside 1–5 minutes is 400",
    badLimit.status === 400 && badLimit.body?.error === "Job runtime must be between 1 and 5 minutes.",
    badLimit.body?.error,
  );

  // ── D. Approval, attach, submit ack ──
  await api("POST", "/api/recipes", {
    draft: { id: "gate-plan", title: "Gate", steps: ["Open"], allowedOrigins: [ORIGIN], capabilities: ["portal-read"] },
  });
  const beforePlan = await api("POST", "/api/recipes/gate-plan/attend", {});
  check("attend before approval is 409", beforePlan.status === 409 && beforePlan.body?.error === "Approve the plan first.", beforePlan.body?.error);

  await api("PATCH", "/api/recipes/gate-plan", { planApproved: true });
  const beforeAttach = await api("POST", "/api/recipes/gate-plan/attend", {});
  check(
    "attend before attach is 409",
    beforeAttach.status === 409 && /Attach this site first/i.test(beforeAttach.body?.error ?? ""),
    beforeAttach.body?.error,
  );

  await api("POST", "/api/recipes", {
    draft: { id: "gate-bare", title: "Bare", steps: ["Open"], allowedOrigins: [], capabilities: ["read-book"] },
  });
  await api("PATCH", "/api/recipes/gate-bare", { planApproved: true });
  const bareAttach = await api("PATCH", "/api/recipes/gate-bare", { attach: true });
  check(
    "attach without portal site is 409",
    bareAttach.status === 409 && bareAttach.body?.error === "Add the portal site and a portal capability before attaching it.",
    bareAttach.body?.error,
  );

  await saveJob("gate-no-submit");
  const badAck = await api("PATCH", "/api/recipes/gate-no-submit", { submitAcknowledged: true });
  check(
    "submitAcknowledged without portal-submit is 409",
    badAck.status === 409 && /portal-submit capability/i.test(badAck.body?.error ?? ""),
    badAck.body?.error,
  );

  await saveJob("gate-edit", { capabilities: ["portal-read", "portal-prefill", "portal-submit"] });
  await api("PATCH", "/api/recipes/gate-edit", { submitAcknowledged: true });
  const current = (await api("GET", "/api/recipes")).body.recipes.find((r) => r.id === "gate-edit");
  const editedOrigins = await api("POST", "/api/recipes", {
    draft: { ...current, allowedOrigins: ["propertyme.com.au"] },
  });
  const afterOriginEdit = editedOrigins.body.recipes.find((r) => r.id === "gate-edit");
  check("editing origins clears attachment", afterOriginEdit?.attachment == null);
  check("editing origins clears submitAcknowledgedAt", afterOriginEdit?.submitAcknowledgedAt == null);

  await saveJob("gate-cap", { capabilities: ["portal-read", "portal-prefill", "portal-submit"] });
  await api("PATCH", "/api/recipes/gate-cap", { submitAcknowledged: true });
  const capCurrent = (await api("GET", "/api/recipes")).body.recipes.find((r) => r.id === "gate-cap");
  const editedCaps = await api("POST", "/api/recipes", {
    draft: { ...capCurrent, capabilities: ["portal-read", "portal-prefill"] },
  });
  const afterCapEdit = editedCaps.body.recipes.find((r) => r.id === "gate-cap");
  check("editing capabilities clears submitAcknowledgedAt only", afterCapEdit?.submitAcknowledgedAt == null && afterCapEdit?.attachment != null);

  // ── E. Rules ──
  await ensureBudIdle();
  const ruleOk = await api("POST", "/api/rules", {
    surface: "portal-read",
    origin: "https://portal.vantagestrata.com.au/levies",
    decision: "allow",
  });
  check(
    "portal-read rule is 201",
    ruleOk.status === 201 && ruleOk.body.rules.some((r) => r.key === "portal:read:portal.vantagestrata.com.au"),
    `${ruleOk.status} ${JSON.stringify(ruleOk.body?.rules?.map((r) => r.key))}`,
  );

  const ruleDeny = await api("POST", "/api/rules", { surface: "portal-read", origin: ORIGIN, decision: "deny" });
  check("portal rule deny is 400", ruleDeny.status === 400 && ruleDeny.body?.error === "Portal rules can only allow.", ruleDeny.body?.error);

  const ruleSubmit = await api("POST", "/api/rules", { surface: "portal-submit", origin: ORIGIN, decision: "allow" });
  check("portal-submit surface is 400", ruleSubmit.status === 400, ruleSubmit.body?.error);

  const beforeDup = (await api("GET", "/api/rules")).body.rules.length;
  await api("POST", "/api/rules", {
    surface: "portal-read",
    origin: "https://portal.vantagestrata.com.au/levies",
    decision: "allow",
  });
  const afterDup = (await api("GET", "/api/rules")).body.rules.length;
  check("duplicate portal rule is idempotent", afterDup === beforeDup);

  const listed = await api("GET", "/api/rules");
  check(
    "GET rules lists surface and origin",
    listed.body.rules.some((r) => r.key?.startsWith("portal:") && r.origin === "portal.vantagestrata.com.au"),
  );
  const toDelete = listed.body.rules.find((r) => r.key === "portal:read:portal.vantagestrata.com.au");
  if (toDelete?.id) {
    const deleted = await api("DELETE", `/api/rules/${toDelete.id}`);
    check("DELETE rule removes it", deleted.status === 200);
  }

  // ── F. Attended run (fake worker) ──
  await ensureBudIdle();
  for (const rule of (await api("GET", "/api/rules")).body.rules.filter((r) => r.key?.startsWith("portal:"))) {
    await api("DELETE", `/api/rules/${rule.id}`);
  }
  await saveJob("run-nav");
  writeScript({
    permission: true,
    tool: "navigate",
    title: "Open levy portal",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: "opening the portal",
  });
  const navStart = await api("POST", "/api/recipes/run-nav/attend", {});
  check("navigate attend accepted", navStart.status === 202, `${navStart.status} ${JSON.stringify(navStart.body)}`);
  const navBud = await waitForOptionsCard();
  const navCard = navBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  check("navigate card fence is portal-read", navCard?.card?.fence?.surface === "portal-read");
  check("navigate card offers a rule", Boolean(navCard?.card?.fence?.ruleOffer));
  await api("POST", `/api/threads/${navBud.threadId}/respond`, {
    requestId: navCard.card.requestId,
    behavior: "allow",
  });
  const navRun = await waitForRunSettled("run-nav");
  check("navigate run settles", navRun.status !== "running");

  await saveJob("run-scope");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: "scoped",
  });
  await api("POST", "/api/recipes/run-scope/attend", {});
  const scopeBud = await waitForOptionsCard();
  const scopeCard = scopeBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  await api("POST", `/api/threads/${scopeBud.threadId}/respond`, {
    requestId: scopeCard.card.requestId,
    behavior: "allow",
    scope: "session",
  });
  await waitForRunSettled("run-scope");
  const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
  check("session scope becomes allow-once", dump.selectedPermissionOption === "allow-once");

  await saveJob("run-pass");
  writeScript({
    permission: true,
    tool: "fill",
    title: "Password",
    rawInput: { label: "Password", url: `https://portal.${ORIGIN}/login` },
    reply: "waiting at sign-in",
  });
  await api("POST", "/api/recipes/run-pass/attend", {});
  // The sign-in is handed to the person and the task pauses, still running, so it
  // can continue afterwards; Stop from the handoff ends it.
  await waitForSignInHandoff();
  const pausedPass = ((await api("GET", "/api/job-runs?jobId=run-pass")).body?.runs ?? [])[0];
  check(
    "password fill auto-denied",
    (pausedPass?.evidence ?? []).some((e) => e.kind === "denied" && /never types a password/i.test(e.note)),
  );
  await closeOpenSignInHandoffs();
  const passRun = await waitForRunSettled("run-pass");
  check("paused sign-in task ends interrupted after Stop", passRun.status === "interrupted", passRun.status);
  check(
    "sign-in handoff cleared after password deny",
    ((await api("GET", "/api/human-handoffs")).body?.handoffs ?? []).every((h) => h.value?.state === "closed"),
  );

  await saveJob("run-pay");
  writeScript({
    permission: true,
    tool: "click_semantic",
    title: "Pay now",
    rawInput: { label: "Pay now", url: `https://portal.${ORIGIN}/pay` },
    reply: "stopped before pay",
  });
  await api("POST", "/api/recipes/run-pay/attend", {});
  const payRun = await waitForRunSettled("run-pay");
  check(
    "Pay click denied",
    payRun.evidence.some((e) => e.kind === "denied" && /Submit, Pay and Send stay with you/i.test(e.note)),
  );

  await saveJob("run-off");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: "https://evil.example.com/form" },
    reply: "wrong site",
  });
  await api("POST", "/api/recipes/run-off/attend", {});
  const offRun = await waitForRunSettled("run-off");
  check(
    "off-origin navigate denied",
    offRun.evidence.some((e) => e.kind === "denied" && e.note.includes("That site is not on this job.")),
  );

  await saveJob("run-no-submit");
  writeScript({
    permission: true,
    tool: "click_semantic",
    title: "Save",
    rawInput: { label: "Save", url: `https://${ORIGIN}/form` },
    reply: "blocked",
  });
  await api("POST", "/api/recipes/run-no-submit/attend", {});
  const noSubmitRun = await waitForRunSettled("run-no-submit");
  check(
    "submit without capability denied",
    noSubmitRun.evidence.some((e) => e.kind === "denied" && /cannot press Submit/i.test(e.note)),
  );

  await saveJob("run-submit", { capabilities: ["portal-read", "portal-prefill", "portal-submit"] });
  await api("PATCH", "/api/recipes/run-submit", { submitAcknowledged: true });
  writeScript({
    permission: true,
    tool: "click_semantic",
    title: "Save",
    rawInput: { label: "Save", url: `https://${ORIGIN}/form` },
    reply: "waiting",
  });
  await api("POST", "/api/recipes/run-submit/attend", {});
  const submitBud = await waitForOptionsCard();
  const submitCard = submitBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  check(
    "submit card summary",
    submitCard?.card?.subtitle === `Bud wants to press 'Save' on ${ORIGIN}. Check the form in the browser first.`,
    submitCard?.card?.subtitle,
  );
  check("submit card ruleOffer is null", submitCard?.card?.fence?.ruleOffer == null);
  await api("POST", `/api/threads/${submitBud.threadId}/respond`, {
    requestId: submitCard.card.requestId,
    behavior: "allow",
  });
  await waitForRunSettled("run-submit");

  await saveJob("run-rule-save");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: "opening the portal",
  });
  await api("POST", "/api/recipes/run-rule-save/attend", {});
  const ruleBud = await waitForOptionsCard();
  const ruleCard = ruleBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  await api("POST", `/api/threads/${ruleBud.threadId}/respond`, {
    requestId: ruleCard.card.requestId,
    behavior: "allow",
    rule: { surface: "portal-read", origin: ORIGIN },
  });
  await waitForRunSettled("run-rule-save");
  check(
    "rule saved from Allow",
    (await api("GET", "/api/rules")).body.rules.some((r) => r.key === "portal:read:vantagestrata.com.au"),
  );

  await saveJob("run-rule-auto");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: `${ORIGIN} shows outstanding balance due`,
  });
  await api("POST", "/api/recipes/run-rule-auto/attend", {});
  const autoRun = await waitForRunSettled("run-rule-auto");
  check(
    "ruled navigate auto-allows",
    autoRun.evidence.some((e) => e.kind === "action" && /allowed by rule/i.test(e.note)),
  );
  check("permission evidence does not certify a current read", autoRun.status === "partial");

  await saveJob("run-done");
  writeScript({ permission: false, reply: `${ORIGIN} shows outstanding balance due` });
  await api("POST", "/api/recipes/run-done/attend", {});
  const doneRun = await waitForRunSettled("run-done");
  check("unverified read-back stays partial", doneRun.status === "partial");
  check("unverified receipt explains the review requirement", doneRun.evidence.some((e) => e.kind === "note" && e.note.includes("current browser result has not been verified")));

  await saveJob("run-partial");
  writeScript({ permission: false, reply: "I finished the steps." });
  await api("POST", "/api/recipes/run-partial/attend", {});
  const partialRun = await waitForRunSettled("run-partial");
  check("no read-back stays partial", partialRun.status === "partial");

  for (const rule of (await api("GET", "/api/rules")).body.rules.filter((r) => r.key?.startsWith("portal:"))) {
    await api("DELETE", `/api/rules/${rule.id}`);
  }
  await ensureBudIdle();
  await saveJob("run-interrupt");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: "still working",
  });
  await api("POST", "/api/recipes/run-interrupt/attend", {});
  await waitForOptionsCard();
  await api("POST", "/api/bots/bud/interrupt", {});
  await waitForBot((b) => !b.busy, "interrupt to settle", 15_000);
  const interruptRun = (await api("GET", "/api/job-runs?jobId=run-interrupt")).body.runs[0];
  check("interrupt run not running", interruptRun.status !== "running", interruptRun.status);
  console.log(`      (interrupt settled as ${interruptRun.status})`);

  await ensureBudIdle();
  await saveJob("run-overlap");
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: `https://portal.${ORIGIN}/levy` },
    reply: "still working",
  });
  await api("POST", "/api/recipes/run-overlap/attend", {});
  await waitForOptionsCard();
  const overlapAgain = await api("POST", "/api/recipes/run-overlap/attend", {});
  check(
    "second attend while running is 409",
    overlapAgain.status === 409 &&
      (overlapAgain.body?.error === "This job already has work waiting or running." ||
        overlapAgain.body?.error === "Bud is busy with another turn. Stop it or wait, then run again."),
    overlapAgain.body?.error,
  );
  console.log(`      (overlap message: ${overlapAgain.body?.error})`);
  await api("POST", "/api/bots/bud/interrupt", {});
  await waitForBot((b) => !b.busy, "overlap cleanup", 15_000);

  await ensureBudIdle();
  writeScript({
    permission: true,
    tool: "navigate",
    rawInput: { url: "https://example.com" },
    reply: "adhoc",
  });
  await api("POST", "/api/bots/bud/messages", { text: "what does the browser screen show right now" });
  const adhocBud = await waitForBot(
    (b) =>
      b.messages?.some(
        (m) =>
          (m.kind === "activity" && /Only sites named in a saved job/i.test(m.tool?.name ?? "")) ||
          (m.kind === "activity" && /Only sites named in a saved job/i.test(m.tool?.spoken ?? "")) ||
          (m.kind === "text" && /Only sites named in a saved job/i.test(m.text ?? "")),
      ),
    "adhoc computer denial",
    30_000,
  );
  check(
    "adhoc computer without fence denied",
    adhocBud.messages.some((m) => /Only sites named in a saved job/i.test(m.tool?.spoken ?? m.text ?? "")),
  );

  // ── G. Ready beside you ──
  await saveJob("ready-job", { schedule: { time: "16:00", weekdays: [1, 2, 3, 4, 5] } });
  writeScript({ permission: false, reply: `${ORIGIN} shows outstanding balance due` });
  const loopRun = await api("POST", "/api/loops/recipe-ready-job/run", {});
  check("scheduled loop run accepted", loopRun.status === 201);
  await waitForBot(
    async () => {
      const runs = (await api("GET", "/api/job-runs?jobId=ready-job")).body?.runs ?? [];
      return runs[0]?.status === "queued";
    },
    "queued attended run",
  );
  const queued = (await api("GET", "/api/job-runs?jobId=ready-job")).body.runs[0];
  check(
    "queued detail is ready beside you",
    queued.detail === "Ready to run beside you — press Start when you are at the screen.",
    queued.detail,
  );

  const badRunId = await api("POST", "/api/recipes/ready-job/attend", { runId: "nope" });
  check("missing runId is 404", badRunId.status === 404 && badRunId.body?.error === "That run is no longer waiting.", badRunId.body?.error);

  const started = await api("POST", "/api/recipes/ready-job/attend", { runId: queued.id });
  check("attend with runId starts running", started.status === 202 && started.body?.run?.status === "running");
  await waitForRunSettled("ready-job");

  await api("POST", "/api/recipes", {
    draft: {
      id: "ready-skip",
      title: "Unattached",
      steps: ["Open"],
      allowedOrigins: [ORIGIN],
      capabilities: ["portal-read"],
      schedule: { time: "16:00", weekdays: [1, 2, 3, 4, 5] },
      status: "active",
    },
  });
  await api("PATCH", "/api/recipes/ready-skip", { planApproved: true });
  await api("POST", "/api/loops/recipe-ready-skip/run", {});
  await sleep(500);
  const skipLoops = (await api("GET", "/api/loops")).body.runs.find((r) => r.loopId === "recipe-ready-skip");
  check(
    "unattached scheduled job skips with attach detail",
    skipLoops?.detail === "Attach the site and approve the plan to run this beside you.",
    skipLoops?.detail,
  );
  check("unattached skip creates no job run", ((await api("GET", "/api/job-runs?jobId=ready-skip")).body.runs ?? []).length === 0);

  await saveJob("ready-persist", { schedule: { time: "16:00", weekdays: [1, 2, 3, 4, 5] } });
  await api("POST", "/api/loops/recipe-ready-persist/run", {});
  await waitForBot(
    async () => {
      const runs = (await api("GET", "/api/job-runs?jobId=ready-persist")).body?.runs ?? [];
      return runs[0]?.status === "queued";
    },
    "persist queued run",
  );
  const persistId = (await api("GET", "/api/job-runs?jobId=ready-persist")).body.runs[0].id;
  await restartServer();
  const afterRestart = (await api("GET", "/api/job-runs?jobId=ready-persist")).body.runs.find((r) => r.id === persistId);
  check("queued run survives restart", afterRestart?.status === "queued", afterRestart?.status);

  // ── H. Receipts ──
  const receiptRuns = (await api("GET", "/api/job-runs?jobId=run-pay")).body.runs;
  check("job runs newest first", receiptRuns.length >= 1 && receiptRuns[0].jobId === "run-pay");
  check(
    "evidence entries shaped { at, kind, note }",
    receiptRuns[0].evidence.every((e) => typeof e.at === "number" && typeof e.kind === "string" && typeof e.note === "string"),
  );
  check(
    "approvalRequests mentions Submit/Pay/Send when summary does",
    payRun.approvalRequests?.includes("Submit/Pay/Send stay with you"),
    payRun.approvalRequests?.join(", "),
  );

  // ── I. Connected tools ──
  const connectNoKey = await budMessage("connect Notion");
  const connectNoKeyText = lastBotText(connectNoKey);
  check(
    "connect Notion without key explains setup",
    /Connected apps needs its private connection key/i.test(connectNoKeyText) &&
      /\*\*Connect Notion\*\*/i.test(connectNoKeyText) &&
      !/Hermes/i.test(connectNoKeyText) &&
      !/Error:/i.test(connectNoKeyText),
    connectNoKeyText.slice(0, 120),
  );

  await startComposioStub();
  composioForceConnected.clear();
  await api("PUT", "/api/config", {
    composio: { key: "ak_test_composio_key_for_e2e_harness", url: `http://127.0.0.1:${composioStubPort}` },
  });
  const cfgSaved = (await api("GET", "/api/config")).body;
  check("composio key saved for connect test", cfgSaved.composio?.configured === true, String(cfgSaved.composio?.configured));
  writeScript({ permission: false, reply: "ok" });
  await ensureBudIdle();
  const beforeConnect = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text: "connect Notion" });
  const connectKeyed = await waitForBot(
    (b) =>
      (b.messages?.length ?? 0) > beforeConnect &&
      b.messages.slice(beforeConnect).some(
        (m) =>
          m.role === "bot" &&
          m.kind === "text" &&
          (/I opened Notion sign-in/i.test(m.text ?? "") || /couldn't open/i.test(m.text ?? "")) &&
          !/private connection key once/i.test(m.text ?? ""),
      ),
    "connect Notion with key",
    30_000,
  );
  const connectKeyedText = lastBotText(connectKeyed, beforeConnect);
  check(
    "connect Notion with key opens stub sign-in",
    /I opened Notion sign-in/i.test(connectKeyedText) && /https:\/\/auth\.example\/connect\/notion/i.test(connectKeyedText),
    connectKeyedText.slice(0, 120),
  );

  composioForceConnected.add("gmail");
  await ensureBudIdle();
  const beforeAlready = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text: "connect me to gmail" });
  const already = await waitForBot(
    (b) =>
      (b.messages?.length ?? 0) > beforeAlready &&
      b.messages.slice(beforeAlready).some((m) => m.role === "bot" && /already connected/i.test(m.text ?? "")),
    "gmail already connected",
    15_000,
  );
  const alreadyText = lastBotText(already, beforeAlready);
  check(
    "connect Gmail when already linked does not mint OAuth",
    /Gmail is already connected/i.test(alreadyText) && !/auth\.example/i.test(alreadyText),
    alreadyText.slice(0, 120),
  );
  composioForceConnected.clear();

  const compoundBefore = (await api("GET", "/api/recipes")).body.recipes.length;
  const compound = await budMessage("connect Notion and delete a page");
  check("compound connect stays ordinary message", (await api("GET", "/api/recipes")).body.recipes.length === compoundBefore);
  check("compound connect is not connect intent only", !/Connected apps needs its private connection key/i.test(lastBotText(compound)), lastBotText(compound).slice(0, 80));

  // Portal intake must still prefer a plan over refusal after connect talk.
  const portalIntake = await budMessage("ok so login to it and sort things out for me completing the routine");
  const portalText = lastBotText(portalIntake);
  check(
    "portal login request is not refused",
    !/I can't log/i.test(portalText) &&
      (/saved job/i.test(portalText) || /Run beside me/i.test(portalText) || /Here's the plan/i.test(portalText) || /model isn't answering/i.test(portalText)),
    portalText.slice(0, 120),
  );
  // ── J. Recovery & honesty ──
  const hermes = (await api("GET", "/api/hermes")).body;
  check("hermes exposes model.attached boolean", typeof hermes.model?.attached === "boolean");
  check("hermes response has no keyHint", !("keyHint" in (hermes.model ?? {})) && !JSON.stringify(hermes).includes("keyHint"));

  const deskCheck = (await api("POST", "/api/desk/check", {})).body;
  check(
    "desk check miss is plain language",
    typeof deskCheck.handsDetail === "string" && !/stack|Traceback|at \w+\(/i.test(deskCheck.handsDetail),
    deskCheck.handsDetail?.slice(0, 80),
  );

  const practiceEsc = (await api("POST", "/api/desk/practice", {})).body;
  const esc = practiceEsc.escalations?.find((e) => e.reason === "statutory-clock");
  check("practice raises statutory-clock escalation", Boolean(esc?.detail && esc.detail.length > 20));
  await restartServer();
  const deskAfter = (await api("GET", "/api/desk")).body;
  const escAfter = deskAfter.escalations?.find((e) => e.reason === "statutory-clock");
  check(
    "escalation detail survives restart as sentences",
    Boolean(escAfter?.detail && escAfter.detail.length > 20 && !/^[a-z-]+$/.test(escAfter.detail.trim())),
    escAfter?.detail?.slice(0, 80),
  );

  if (failures) {
    console.error(`\n${failures} failure(s), ${skips} skip(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\nALL GREEN — portal jobs e2e (${skips} skip(s))`);
  }
} catch (error) {
  console.error(`\nFAIL  ${error.message}`);
  if (stderr) console.error(stderr.slice(-3000));
  process.exitCode = 1;
} finally {
  await stopServer();
  try {
    composioStub?.close();
  } catch {
    /* ignore */
  }
  try {
    await fixtureControl.close();
  } catch {
    /* ignore */
  }
  rmSync(HOME, { recursive: true, force: true });
}
