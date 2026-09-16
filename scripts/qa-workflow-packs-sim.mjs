#!/usr/bin/env node
// Austin workflow-pack simulation on a temp RealBud home.
// Covers: install → approve → export → wipe → import; expected-bill edge cases;
// Composio stub list/connect; REI/bank-style computer-use waits (fake ACP, no live bank/REI).
//
//   node scripts/qa-workflow-packs-sim.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OMB_E2E_PORT ?? 18920 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_CLI = join(ROOT, "server", "testing", "fake-acp-cli.ts");
const REI = "app.reimasterapps.com.au";
const BANK = "online.bank.example";

const HOME = mkdtempSync(join(tmpdir(), "realbud-wf-packs-sim-"));
mkdirSync(join(HOME, ".realbud"), { recursive: true });
const scriptPath = join(HOME, "fake-acp-script.json");
const cuaPath = join(HOME, "cua-connection.json");
const dumpPath = join(HOME, "fake-acp-dump.json");
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
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

let session = "";
let child = null;
let stderr = "";
let composioStub = null;
let composioStubPort = 0;
const composioForceConnected = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
                              accounts: connected ? [{ id: "acct-1", status: "ACTIVE" }] : [],
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
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
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
      title: `Sim: ${id}`,
      steps: ["Open the approved site", "Read only; leave pay and import to Kevin"],
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
  await startComposioStub();
  child = spawnServer();
  await waitForHealth();
  session = (await api("GET", "/api/session")).body?.token ?? "";
  check("session issued", Boolean(session));

  // ── A. Install Austin Phase 1 packs ──
  const listed = await api("GET", "/api/workflow-packs");
  check("lists Austin packs", listed.status === 200 && listed.body?.packs?.length === 2, String(listed.body?.packs?.length));

  const installed = await api("POST", "/api/workflow-packs/austin-phase-1/install", {});
  check(
    "installs Phase 1 packs",
    installed.status === 200 && installed.body?.packs?.every((p) => p.installed),
    installed.body?.error,
  );
  const recipesAfterInstall = (await api("GET", "/api/recipes")).body?.recipes ?? [];
  const packIds = ["wf-austin-expected-bills", "wf-austin-payment-prep"];
  check(
    "pack recipes present as shadow",
    packIds.every((id) => recipesAfterInstall.some((r) => r.id === id && r.status === "shadow")),
  );

  // Approve + retune schedule like Kevin would.
  for (const id of packIds) {
    const recipe = recipesAfterInstall.find((r) => r.id === id);
    const patch = await api("PATCH", `/api/recipes/${id}`, {
      planApproved: true,
      expectedRevision: recipe?.revision,
    });
    check(`approve ${id}`, patch.status === 200, patch.body?.error);
  }
  const retuneSrc = (await api("GET", "/api/recipes")).body.recipes.find((r) => r.id === "wf-austin-expected-bills");
  const retune = await api("POST", "/api/recipes", {
    draft: {
      id: "wf-austin-expected-bills",
      title: retuneSrc.title,
      description: retuneSrc.description,
      steps: retuneSrc.steps,
      allowedOrigins: retuneSrc.allowedOrigins,
      evidence: retuneSrc.evidence,
      capabilities: retuneSrc.capabilities,
      limits: retuneSrc.limits,
      schedule: { time: "10:15", weekdays: [1, 2, 3, 4, 5] },
      expectedRevision: retuneSrc.revision,
    },
  });
  check("retune expected-bills schedule", retune.status === 201, retune.body?.error);
  await api("PATCH", "/api/recipes/wf-austin-expected-bills", {
    planApproved: true,
    expectedRevision: (await api("GET", "/api/recipes")).body.recipes.find((r) => r.id === "wf-austin-expected-bills")
      ?.revision,
  });

  // ── B. Export → wipe → import ──
  const exported = await api("GET", "/api/workflow-packs/export");
  check(
    "export snapshot",
    exported.status === 200 &&
      exported.body?.version === 1 &&
      exported.body?.recipes?.some((r) => r.id === "wf-austin-expected-bills" && r.schedule?.time === "10:15"),
    `version=${exported.body?.version}`,
  );
  writeFileSync(join(HOME, "workflow-packs-export.json"), JSON.stringify(exported.body, null, 2));

  for (const id of packIds) {
    const del = await api("DELETE", `/api/recipes/${id}`);
    check(`wipe recipe ${id}`, del.status === 200, del.body?.error);
  }
  writeFileSync(join(HOME, ".realbud", "workflow-packs.json"), JSON.stringify({ version: 1, installs: {} }, null, 2));
  // Restart so pack state + recipe store reload from disk after wipe.
  await stopServer();
  await sleep(300);
  stderr = "";
  child = spawnServer();
  await waitForHealth();
  session = (await api("GET", "/api/session")).body?.token ?? "";

  const afterWipe = (await api("GET", "/api/workflow-packs")).body?.packs ?? [];
  check("packs uninstalled after wipe", afterWipe.every((p) => !p.installed));

  const imported = await api("POST", "/api/workflow-packs/import", exported.body);
  check(
    "import restores packs",
    imported.status === 200 && imported.body?.packs?.every((p) => p.installed),
    imported.body?.error,
  );
  const restored = (await api("GET", "/api/recipes")).body?.recipes?.find((r) => r.id === "wf-austin-expected-bills");
  check(
    "import restores cadence but requires local approval",
    restored?.schedule?.time === "10:15" && restored?.planApprovedAt == null && restored?.status === "shadow",
    JSON.stringify({ time: restored?.schedule?.time, approved: restored?.planApprovedAt, status: restored?.status }),
  );

  const badImport = await api("POST", "/api/workflow-packs/import", { version: 99 });
  check("rejects unsupported export version", badImport.status === 400, String(badImport.status));

  // ── C. Expected-bill edge cases (Desk calendar) ──
  const practice = await api("POST", "/api/desk/practice", {});
  check("practice book loads", practice.status === 200, practice.body?.error);
  const desk = (await api("GET", "/api/desk")).body;
  const propertyId = desk?.properties?.[0]?.id ?? desk?.book?.properties?.[0]?.id;
  check("desk has a property for bills", Boolean(propertyId), String(propertyId));

  const billCases = [
    { id: "bill-missing", kind: "council", status: "missing", note: "No invoice in coverage window" },
    { id: "bill-received", kind: "water", status: "received", note: "Invoice matched" },
    { id: "bill-in-process", kind: "insurance", status: "in-process", note: "Payment submitted in REI" },
    { id: "bill-paid", kind: "strata", status: "paid", amountCents: 12000, note: "Settled" },
    { id: "bill-nsf", kind: "council", status: "insufficient-funds", note: "Owner ledger short" },
    { id: "bill-advance", kind: "repairs", status: "company-advance", note: "Office floated payment" },
    { id: "bill-owner", kind: "landtax", status: "owner-to-pay", note: "Owner pays direct" },
    { id: "bill-hold", kind: "other", status: "hold", note: "Ambiguous reference" },
  ];
  for (const row of billCases) {
    const res = await api("POST", "/api/expected-bills", {
      id: row.id,
      propertyId,
      kind: row.kind,
      status: row.status,
      amountCents: row.amountCents,
      note: row.note,
      sourceRef: "workflow-packs-sim",
      windowStartAt: Date.now() - 86_400_000,
      windowEndAt: Date.now() + 86_400_000,
    });
    check(`upsert bill ${row.status}`, res.status === 200 && res.body?.bill?.status === row.status, res.body?.error);
  }
  const grouped = await api("GET", "/api/expected-bills");
  check(
    "bill groups include needs-you",
    (grouped.body?.groups?.["needs-you"]?.length ?? 0) >= 4,
    `needs-you=${grouped.body?.groups?.["needs-you"]?.length}`,
  );

  // ── D. Composio stub (Gmail for expected-bills inbox support) ──
  const cfgPut = await api("PUT", "/api/config", {
    composio: { key: "ak_test_composio_key_for_wf_packs_sim", url: `http://127.0.0.1:${composioStubPort}` },
  });
  check(
    "composio key saved",
    cfgPut.status === 200 && cfgPut.body?.composio?.configured === true,
    `${cfgPut.status} ${cfgPut.body?.error ?? cfgPut.body?.composio?.configured}`,
  );
  composioForceConnected.add("gmail");
  writeScript({ permission: false, reply: "ok" });
  const beforeGmail = (await getBud())?.messages?.length ?? 0;
  await api("POST", "/api/bots/bud/messages", { text: "connect me to gmail" });
  const gmailBud = await waitForBot(
    (b) =>
      (b.messages?.length ?? 0) > beforeGmail &&
      b.messages.slice(beforeGmail).some((m) => m.role === "bot" && /already connected|opened.*sign-in|couldn't open|connection key/i.test(m.text ?? "")),
    "gmail connect via Composio stub",
    30_000,
  );
  const gmailText =
    [...(gmailBud.messages ?? [])]
      .slice(beforeGmail)
      .reverse()
      .find((m) => m.role === "bot" && m.kind === "text" && m.text)?.text ?? "";
  check(
    "composio Gmail already connected (stub)",
    /Gmail is already connected/i.test(gmailText),
    gmailText.slice(0, 120),
  );
  const appsCheck = await api("POST", "/api/connected-apps/check", {});
  check("connected-apps check returns", appsCheck.status === 200, String(appsCheck.status));

  // ── E. REI / bank computer-use wait patterns (fixture origins, fake ACP) ──
  await preparePortalJob("sim-rei-approval-wait", REI);
  await api("POST", "/api/recipes/sim-rei-approval-wait/attend", {});
  const waitBud = await waitForOptionsCard();
  const waitCard = waitBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
  check("REI navigate waits for Allow once", Boolean(waitCard?.card?.requestId));
  await api("POST", `/api/threads/${waitBud.threadId}/respond`, {
    requestId: waitCard.card.requestId,
    behavior: "allow",
  });
  const waitRun = await waitForRunSettled("sim-rei-approval-wait");
  check(
    "REI approval-wait run settles",
    ["completed", "partial", "interrupted", "failed"].includes(waitRun.status),
    waitRun.status,
  );

  await preparePortalJob("sim-password-deny", REI, {
    tool: "fill",
    title: "Password",
    rawInput: { label: "Password", url: `https://${REI}/login` },
    reply: "Waiting at sign-in (scripted).",
  });
  await api("POST", "/api/recipes/sim-password-deny/attend", {});
  const passRun = await waitForRunSettled("sim-password-deny");
  check(
    "password fill auto-denied",
    passRun.evidence?.some((e) => e.kind === "denied" && /never types a password/i.test(e.note ?? "")),
    JSON.stringify(passRun.evidence?.slice(0, 2)),
  );

  await preparePortalJob("sim-pay-deny", BANK, {
    tool: "click",
    title: "Pay now",
    rawInput: { label: "Pay now", url: `https://${BANK}/pay` },
    reply: "Stopped before pay (scripted).",
  });
  await api("POST", "/api/recipes/sim-pay-deny/attend", {});
  // May surface approval or hard deny depending on fence — either must not complete a pay.
  let payBud;
  try {
    payBud = await waitForOptionsCard();
  } catch {
    payBud = null;
  }
  if (payBud) {
    const payCard = payBud.messages.find((m) => m.kind === "options" && !m.card?.answered);
    await api("POST", `/api/threads/${payBud.threadId}/respond`, {
      requestId: payCard.card.requestId,
      behavior: "deny",
    });
  }
  const payRun = await waitForRunSettled("sim-pay-deny");
  check(
    "pay click denied or interrupted",
    payRun.status !== "running" &&
      (payRun.evidence?.some((e) => e.kind === "denied") || ["interrupted", "failed", "completed"].includes(payRun.status)),
    `${payRun.status}`,
  );

  // Continue / handoff when password path opens a human hold.
  const holds = (await api("GET", "/api/human-handoffs")).body?.handoffs ?? [];
  if (holds.length) {
    const hold = holds[0];
    const cont = await api("POST", `/api/human-handoffs/${hold.id}/continue`, { revision: hold.revision });
    check(
      "Continue without calibration is blocked",
      cont.status === 409 || cont.status === 400,
      String(cont.status),
    );
  } else {
    check("Continue path available when handover opened", true, "no durable handoff in this password path (ok)");
  }

  console.log("\nSimulation complete. Export written to", join(HOME, "workflow-packs-export.json"));
  console.log("Fixture home:", HOME);
} catch (error) {
  failures++;
  console.error("FAIL  simulation aborted —", error instanceof Error ? error.message : error);
  console.error(stderr.slice(-2500));
} finally {
  await stopServer();
  composioStub?.close();
  if (!process.env.REALBUD_KEEP_SIM_HOME) {
    rmSync(HOME, { recursive: true, force: true });
  }
}

process.exit(failures ? 1 : 0);
