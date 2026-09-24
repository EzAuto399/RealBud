import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobCapability, Recipe } from "../shared/contracts.ts";
import { ATTEND_ERRORS, ATTENDED_UNVERIFIED_RESULT, attendBlocked, attendedJobSystemBlock, attendedSettleStatus, browserActionEvidence, fenceEvidence, grantedBrowserTools, humanSigninNeeded, portalBrowserPolicy, portalSignInCompleteIntent, submitHoldLine } from "./attended-run.ts";
import { JobRunStore } from "./job-runs.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { BrowserApprovalStore, legacyBrowserGrant } from "./browser-authority.ts";
import { startBrowserBroker, type BrowserActionRecord } from "./browser-broker.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import { legacyBrowserActions, parseBrowserTaskGrant, type BrowserActionClass, type BrowserTaskGrant, type BrowserTaskUpload } from "../shared/browser-task.ts";
import { startCuaControl } from "../electron/cua-control.mjs";
let fixtureControl: Awaited<ReturnType<typeof startCuaControl>>;
const taskGrant = (actions: BrowserActionClass[], uploads: BrowserTaskUpload[] = []): BrowserTaskGrant => parseBrowserTaskGrant({
  version: 1, purpose: "browser-task-grant", id: "grant-fictional-1", runId: "run-1", route: "ask", request: { text: "Fictional task", sha256: "a".repeat(64) },
  sites: ["portal.example"], browser: { id: null, accountMarker: null }, actions, consequential: "ask-each", uploads, expiresAt: null, budget: null,
});
describe("worker sign-in handover requests", () => {
  it.each(["Please sign in to continue.", "Login is required before I can read the bank export.", "Waiting for you to finish sign-in."])("recognizes a request without a password tool: %s", text => expect(humanSigninNeeded(text)).toBe("login"));
  it("recognizes a verification-code request", () => expect(humanSigninNeeded("Please complete the verification code in the bank window.")).toBe("mfa"));
  // Session expiry is the realistic mid-run case: the person signed in earlier, the
  // portal dropped them, and the worker says so instead of trying a password tool.
  // This must hold for sign-in and never fall through to a settle that could submit.
  it.each([
    "Your session has expired. Sign in again to continue.",
    "The portal session expired — please sign in.",
    "Session timed out, log in again to view the arrears report.",
    "Your login has expired. Please sign in to PropertyMe.",
  ])("treats an expired session as a sign-in hold, not a failure: %s", text => expect(humanSigninNeeded(text)).toBe("login"));
  it("still calls an expired session with a code an mfa hold", () => {
    expect(humanSigninNeeded("Your session expired — a verification code is required to continue.")).toBe("mfa");
  });
  it("does not invent a sign-in hold when the worker reports the session is fine", () => {
    expect(humanSigninNeeded("Session is active and the arrears report is open.")).toBeNull();
    expect(humanSigninNeeded("Signed in successfully; reading the ledger now.")).toBeNull();
  });
  it.each(["Already signed in and the bank export is ready.", "No login is needed.", "References reviewed."])("does not reinterpret a completed observation: %s", text => expect(humanSigninNeeded(text)).toBeNull());
});

describe("portal browser policy (RealBud layer)", () => {
  it("prefers the person's open browser and forbids a second isolated login window", () => {
    const policy = portalBrowserPolicy();
    expect(policy).toMatch(/already-open job-site tab/i);
    expect(policy).toMatch(/Never launch another browser/i);
    expect(policy).toMatch(/Stop\/restart does not authorize replaying/i);
    expect(policy).toMatch(/release the browser first/i);
  });

  it("embeds that policy in the attended job system block", () => {
    const block = attendedJobSystemBlock({
      title: "Vantage login",
      description: "Read only the supplied account; do not use connected apps.",
      steps: ["Open portal", "Read dashboard"],
      allowedOrigins: ["vantagestrata.residentportal.au.resvu.io"],
      evidence: "Dashboard read-back",
      capabilities: ["portal-read"],
      submitAcknowledgedAt: null,
    });
    expect(block).toContain("Vantage login");
    expect(block).toContain("vantagestrata.residentportal.au.resvu.io");
    expect(block).toMatch(/already-open job-site tab/i);
    expect(block).toMatch(/Never launch another browser/i);
    expect(block).toContain("Inputs and context:\nRead only the supplied account; do not use connected apps.");
    expect(block).toContain("do not expand the allowed sites or tool permissions");
    expect(block).toContain("naming the source site");
  });

  it("lists the browser tools the run's grant allows", () => {
    const tools = (block: string) => block.match(/browser tools for this saved job: ([^.]+)\./)?.[1];
    expect(tools(portalBrowserPolicy())).toBe("browser_tabs, browser_borrow, browser_read, browser_navigate, browser_fill, browser_click_semantic and browser_release");
    expect(tools(attendedJobSystemBlock(recipe({ capabilities: ["portal-read"] }))))
      .toBe("browser_tabs, browser_borrow, browser_read, browser_navigate, browser_click_semantic and browser_release");
    expect(tools(attendedJobSystemBlock(recipe()))).toContain("browser_fill");
    const task = taskGrant(["read", "navigate", "click", "fill", "keys", "download", "upload"], [{ name: "fictional-lease.pdf", sha256: "b".repeat(64) }]);
    expect(tools(attendedJobSystemBlock(recipe(), task))).toBe("browser_tabs, browser_borrow, browser_read, browser_navigate, browser_fill, browser_click_semantic, browser_press, browser_select, browser_download, browser_upload and browser_release");
    // Upload needs files given to the task; keys and downloads need their own action class.
    expect(grantedBrowserTools(taskGrant(["read", "upload"]), true)).toEqual(["browser_tabs", "browser_borrow", "browser_read", "browser_release"]);
    expect(portalBrowserPolicy([])).toMatch(/^This job has no browser tools\./);
  });

  it("names exactly the tools the broker offers for that grant", async () => {
    const root = privateTempRoot(join(tmpdir(), "rb-attended-tools-"));
    const runtime = new BrowserRuntime({ root, command: async () => ({}), executable: async () => "/fixture/bsk", startDaemon: async () => {} });
    const offered = async (options: { capabilities: JobCapability[]; grant?: BrowserTaskGrant }) => {
      // A saved job passes its own grant explicitly, built from its capabilities as the host does.
      const grant = options.grant ?? legacyBrowserGrant({ runId: "run-1", allowedOrigins: ["portal.example"], capabilities: options.capabilities });
      const broker = await startBrowserBroker({ runtime, threadId: "thread-1", runId: "run-1", context: { allowedOrigins: ["portal.example"], capabilities: options.capabilities },
        grant, approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }),
        isActive: () => true, approve: async () => false, assertCapability: () => {} });
      try {
        const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        return ((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name);
      } finally { broker.close(); await broker.released(); }
    };
    try {
      const all = taskGrant(["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"], [{ name: "fictional-lease.pdf", sha256: "b".repeat(64) }]);
      expect(grantedBrowserTools(all, true)).toEqual(await offered({ capabilities: ["portal-read"], grant: all }));
      const prefill: JobCapability[] = ["portal-read", "portal-prefill", "portal-submit"];
      expect(grantedBrowserTools({ actions: legacyBrowserActions(prefill), uploads: [] }, false)).toEqual(await offered({ capabilities: prefill }));
      // A read-only job is offered exactly what its policy names: no browser_fill.
      const readOnly = await offered({ capabilities: ["portal-read"] });
      expect(readOnly).toEqual(grantedBrowserTools({ actions: legacyBrowserActions(["portal-read"]), uploads: [] }, false));
      expect(readOnly).not.toContain("browser_fill");
    } finally { await removeFixture(root); }
  });

  it.each(["done", "Done.", "signed in", "I'm signed in", "ok we are signed in", "finished signing in"])(
    "treats sign-in complete chat as handoff Continue, not a new computer turn: %s",
    (text) => expect(portalSignInCompleteIntent(text)).toBe(true),
  );

  it.each(["please check the dashboard", "done with the levy export for unit 12", "Already signed in and the bank export is ready."])(
    "does not hijack ordinary Ask text: %s",
    (text) => expect(portalSignInCompleteIntent(text)).toBe(false),
  );
});

describe("fence evidence identity", () => {
  it("names the denied browser action in the retained receipt", () => {
    expect(
      fenceEvidence(
        { tool: "navigate", summary: "open arrears" },
        { kind: "deny", reason: "Only sites named in a saved job. Ask Bud to set the routine up as a job first." },
        42,
      ),
    ).toEqual({
      at: 42,
      kind: "denied",
      note: "Tried to open a page. Only sites named in a saved job. Ask Bud to set the routine up as a job first.",
    });
  });
});

describe("browser action records in the run's evidence", () => {
  const base: BrowserActionRecord = { grantId: "legacy-0123456789abcdef0123456789abcdef", tool: "browser_press", origin: "https://portal.example", path: "/levies/pay",
    label: 'textbox "Amount (AUD)" value="1,240.00"', class: "consequential", decision: "approved", outcome: "succeeded", key: "Enter" };
  const entry = (note: string) => ({ at: 7, kind: "action" as const, note });

  it("keeps the record's identifiers and hashes, never a field value or a file path", () => {
    const pressed = browserActionEvidence(entry('Pressed Enter in textbox "Amount (AUD)" value="1,240.00" on portal.example.'), base);
    expect(pressed).toEqual({ at: 7, kind: "action", note: 'Pressed Enter in textbox "Amount (AUD)" on portal.example. Action record: tool=browser_press class=consequential decision=approved outcome=succeeded key=Enter page=https://portal.example/levies/pay control="Amount (AUD)" grant=legacy-0123456789abcdef0123456789abcdef' });
    expect(pressed.note).not.toContain("1,240.00");
    const typed = browserActionEvidence(entry('Pressed Shift+q in textbox "Notes" on portal.example.'), { ...base, key: "Shift+q", class: "routine", decision: "allowed", label: 'textbox "Notes"' });
    expect(typed.note).toMatch(/^Pressed a character in textbox "Notes" on portal\.example\. Action record: .* key=character /);
    expect(typed.note).not.toMatch(/\bq\b/);
    const chosen = browserActionEvidence(entry("Chose an option."), { ...base, tool: "browser_select", key: undefined, valuesHash: "c".repeat(64), label: 'combobox "Frequency"' });
    expect(chosen.note).toContain(`values-sha256=${"c".repeat(64)}`);
    const downloaded = browserActionEvidence(entry("Downloaded 'Fictional statement.pdf'."), { ...base, tool: "browser_download", key: undefined, class: "routine", decision: "allowed", label: 'link "Download statement"',
      download: { name: "Fictional statement.pdf", size: 1234, sha256: "d".repeat(64), contentType: "application/pdf" } });
    expect(downloaded.note).toContain(`file-sha256=${"d".repeat(64)} bytes=1234 type=application/pdf`);
    const uploaded = browserActionEvidence(entry("Uploaded the task's file."), { ...base, tool: "browser_upload", key: undefined, outcome: "unknown", label: 'button "Choose file"',
      upload: { fileIdHash: "e".repeat(64), sha256: "f".repeat(64) } });
    expect(uploaded.note).toContain("outcome=unknown");
    expect(uploaded.note).toContain(`file-sha256=${"f".repeat(64)} file-id-sha256=${"e".repeat(64)}`);
    for (const item of [pressed, chosen, downloaded, uploaded]) expect(item.note).not.toMatch(/\/synthetic|\/Users|\.part\b|incoming/);
    // A malformed hash is dropped rather than kept as text.
    expect(browserActionEvidence(entry("x"), { ...base, valuesHash: "not-a-hash /synthetic/file" }).note).not.toContain("not-a-hash");
  });

  it("stays within the evidence note limit, redacted, and keeps the record whole", async () => {
    const long = browserActionEvidence(entry(`Pressed Enter with api_key=fictionalfictional123 ${"filler ".repeat(120)}`),
      { ...base, path: `/${"p".repeat(300)}`, grantId: `g${"1".repeat(199)}`, label: `button "${"L".repeat(300)}"` });
    expect(long.note.length).toBeLessThanOrEqual(500);
    expect(long.note).not.toContain("fictionalfictional123");
    expect(long.note).toMatch(/… Action record: tool=browser_press .* grant=g1{47}$/);
    // The run store keeps the note whole: nothing past its 500-character limit is cut.
    const dir = mkdtempSync(join(tmpdir(), "rb-attended-evidence-"));
    const store = new JobRunStore({ file: join(dir, "job-runs.json") });
    try {
      const run = store.enqueue(recipe(), { mode: "attended", trigger: "manual", idempotencyKey: "fictional-evidence-1" }).run;
      store.start(run.id, "Running.");
      expect(store.appendEvidence(run.id, [long]).evidence.at(-1)?.note).toBe(long.note);
    } finally { store.close(); await removeFixture(dir); }
  });
});

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

function recipe(partial: Partial<Recipe> = {}): Recipe {
  return {
    id: "job-1",
    title: "Levy check",
    description: "Read the levy portal",
    steps: ["Open the portal", "Read the levy"],
    allowedOrigins: ["vantagestrata.com.au"],
    evidence: "Levy balance",
    capabilities: ["portal-read", "portal-prefill"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    siteNotes: null,
    status: "active",
    createdAt: 1,
    schedule: null,
    planApprovedAt: 2,
    revision: 1,
    updatedAt: 1,
    approvedRevision: 1,
    attachment: { attachedAt: 3, acknowledged: "human-login-and-submit" },
    submitAcknowledgedAt: null,
    ...partial,
  };
}

describe("attend preconditions", () => {
  it("returns each blocked message exactly", () => {
    expect(attendBlocked(undefined, { cuaReady: true, busy: false, inFlight: false })).toEqual({
      status: 404,
      error: ATTEND_ERRORS.unknown,
    });
    expect(
      attendBlocked(recipe({ planApprovedAt: null, approvedRevision: null }), {
        cuaReady: true,
        busy: false,
        inFlight: false,
      }),
    ).toEqual({ status: 409, error: ATTEND_ERRORS.plan });
    expect(attendBlocked(recipe({ attachment: null }), { cuaReady: true, busy: false, inFlight: false })).toEqual({
      status: 409,
      error: ATTEND_ERRORS.attach,
    });
    expect(
      attendBlocked(recipe({ capabilities: ["read-book"] }), { cuaReady: true, busy: false, inFlight: false }),
    ).toEqual({ status: 409, error: ATTEND_ERRORS.origins });
    expect(attendBlocked(recipe(), { cuaReady: false, busy: false, inFlight: false })).toEqual({
      status: 409,
      error: ATTEND_ERRORS.cua,
    });
    expect(attendBlocked(recipe(), { cuaReady: true, busy: false, inFlight: true })).toEqual({
      status: 409,
      error: ATTEND_ERRORS.overlap,
    });
    expect(attendBlocked(recipe(), { cuaReady: true, busy: true, inFlight: false })).toEqual({
      status: 409,
      error: ATTEND_ERRORS.busy,
    });
    expect(attendBlocked(recipe(), { cuaReady: true, busy: false, inFlight: false })).toBeNull();
  });

  it.each([
    "All done.",
    "vantagestrata.com.au shows outstanding balance",
    "Couldn't attach with the computer tools alone this run. Bring realbud-qa.localhost:60090 to the front. What the same page showed on the last read: invoice QA-B104, AUD 420.00.",
  ])("does not certify completion from assistant prose: %s", text => {
    // Extra model fields must not become completion authority. The current
    // attended bridge has no validated result receipt, even when ACP says ok.
    const turn = { ok: true, text, allowedOrigins: ["vantagestrata.com.au", "realbud-qa.localhost"] };
    expect(attendedSettleStatus(turn)).toBe("partial");
  });

  it("retains unsuccessful outcomes and review boundaries", () => {
    expect(attendedSettleStatus({ ok: false })).toBe("failed");
    expect(attendedSettleStatus({ ok: false, stopReason: "cancelled" })).toBe(
      "cancelled",
    );
    expect(submitHoldLine("Ready for you to Pay")).toEqual(["Submit/Pay/Send stay with you"]);
  });

  it("gives cancellation and interruption precedence over successful read-back", () => {
    for (const ok of [true, false]) {
      const readBack = { ok, text: "vantagestrata.com.au shows outstanding balance", allowedOrigins: ["vantagestrata.com.au"] };
      expect(attendedSettleStatus({ ...readBack, stopReason: "cancelled" })).toBe("cancelled");
      for (const stopReason of ["interrupted", "stall", "timeout"]) {
        expect(attendedSettleStatus({ ...readBack, stopReason })).toBe("interrupted");
      }
    }
  });

  it("marks a queued attended run missed after a day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-attend-sweep-"));
    let now = 1_000;
    const store = new JobRunStore({ file: join(dir, "job-runs.json"), now: () => now });
    const queued = store.enqueue(recipe(), {
      mode: "attended",
      trigger: "schedule",
      idempotencyKey: "job-1:1:slot",
      detail: "Ready to run beside you — press Start when you are at the screen.",
    }).run;
    now = 1_000 + 24 * 60 * 60_000 + 5;
    expect(store.sweepQueuedAttended()[0]).toMatchObject({
      id: queued.id,
      status: "missed",
      detail: "Not started — the run waited a day for someone at the screen.",
    });
    store.close();
    // Windows can hold the folder briefly after the last write (EPERM); retry, never fail on cleanup.
    await removeFixture(dir);
  });
});

posixOnly("attended run route (fake ACP)", () => {
  let child: ChildProcess;
  let home: string;
  let session = "";
  let stderr = "";
  let scriptPath = "";
  let cuaPath = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session) headers["x-realbud-session"] = session;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const writeScript = (script: Record<string, unknown>) => {
    writeFileSync(scriptPath, `${JSON.stringify(script)}\n`);
  };

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  async function saveReadyJob(id: string, extras: Record<string, unknown> = {}) {
    const created = await api("POST", "/api/recipes", {
      draft: {
        id,
        title: "Levy check",
        steps: ["Open the portal", "Read the levy"],
        allowedOrigins: ["vantagestrata.com.au"],
        evidence: "Levy balance",
        capabilities: ["portal-read", "portal-prefill"],
        status: "active",
        ...extras,
      },
    });
    expect(created.status).toBe(201);
    expect((await api("PATCH", `/api/recipes/${id}`, { planApproved: true })).status).toBe(200);
    expect((await api("PATCH", `/api/recipes/${id}`, { attach: true })).status).toBe(200);
  }

  beforeAll(async () => {
    fixtureControl = await startCuaControl({ release: async () => {}, verify: async () => false, restore: async () => {} });
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "realbud-attend-"));
    mkdirSync(join(home, ".realbud"), { recursive: true });
    scriptPath = join(home, "fake-acp-script.json");
    cuaPath = join(home, "cua-connection.json");
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
      join(home, ".realbud", "config.json"),
      JSON.stringify({
        instances: {
          hermes: {
            driver: "hermesAgent",
            config: { cli: FAKE_CLI },
            environment: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_DUMP: join(home, "fake-acp-dump.json") },
          },
        },
      }),
    );

    // This route suite supplies a synthetic browser connection, just as it
    // supplies a fake ACP worker. Broker/runtime suites exercise real ownership.
    const browserFixture = join(home, "browser-fixture.mjs");
    writeFileSync(browserFixture, `import { existsSync } from "node:fs";
import { browserRuntime } from ${JSON.stringify(new URL("./browser-runtime.ts", import.meta.url).href)};
browserRuntime.status = async () => ({ state: existsSync(${JSON.stringify(cuaPath)}) ? "ready" : "disconnected", enabled: true, browsers: [], selectedBrowserId: "fixture", active: false, checkedAt: Date.now(), version: "0.3.0", port: 52800, detail: "Synthetic browser connection" });
browserRuntime.resumeConnection = async () => {};
`);
    child = spawn(process.execPath, ["--import", browserFixture, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        VITEST: "true",
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
        REALBUD_CUA_DESCRIPTOR_PATH: cuaPath,
        REALBUD_CUA_TEST_READY: "1",
        ...fixtureControl.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const boot = await fetch(`${BASE}/api/session`);
    session = String(((await boot.json()) as { token?: string }).token ?? "");
  }, 30_000);

  afterAll(async () => {
    await fixtureControl?.close();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("returns each 409 with its exact message", async () => {
    expect((await api("POST", "/api/recipes/missing/attend", {})).body.error).toBe(ATTEND_ERRORS.unknown);

    const draft = await api("POST", "/api/recipes", {
      draft: {
        id: "att-plan",
        title: "Levy check",
        steps: ["Open the portal"],
        allowedOrigins: ["vantagestrata.com.au"],
        capabilities: ["portal-read"],
      },
    });
    expect(draft.status).toBe(201);
    expect((await api("POST", "/api/recipes/att-plan/attend", {})).body.error).toBe(ATTEND_ERRORS.plan);

    expect((await api("PATCH", "/api/recipes/att-plan", { planApproved: true })).status).toBe(200);
    expect((await api("POST", "/api/recipes/att-plan/attend", {})).body.error).toBe(ATTEND_ERRORS.attach);

    await saveReadyJob("att-files");
    const current = (await api("GET", "/api/recipes")).body.recipes.find((row: { id: string }) => row.id === "att-files");
    const stripped = await api("POST", "/api/recipes", {
      draft: { ...current, capabilities: ["read-book"] },
    });
    expect(stripped.status).toBe(201);
    expect(stripped.body.recipes.find((row: { id: string }) => row.id === "att-files")?.attachment).toBeTruthy();
    expect((await api("PATCH", "/api/recipes/att-files", { planApproved: true })).status).toBe(200);
    expect((await api("POST", "/api/recipes/att-files/attend", {})).body.error).toBe(ATTEND_ERRORS.origins);

    await saveReadyJob("att-cua");
    unlinkSync(cuaPath);
    expect((await api("POST", "/api/recipes/att-cua/attend", {})).body.error).toBe(ATTEND_ERRORS.cua);
    writeFileSync(
      cuaPath,
      JSON.stringify({
        mode: "embedded",
        mcpCommand: "/tmp/cua-driver",
        mcpArgs: ["mcp"],
        mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
      }),
    );
  });

  it("asks for navigate on the job's site and records asked evidence", async () => {
    await saveReadyJob("att-nav");
    writeScript({
      permission: true,
      tool: "navigate",
      title: "Open levy portal",
      rawInput: { url: "https://portal.vantagestrata.com.au/levy" },
      reply: "opening the portal",
    });
    const started = await api("POST", "/api/recipes/att-nav/attend", {});
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({
      jobId: "att-nav",
      mode: "attended",
      status: "running",
    });
    expect(typeof started.body.run.threadId).toBe("string");

    await waitFor(async () => {
      const bots = await api("GET", "/api/bots");
      const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
      return Boolean(bud?.messages?.some((message: { kind?: string }) => message.kind === "options"));
    }, "the navigate approval card");

    const runs = await api("GET", "/api/job-runs?jobId=att-nav");
    expect(runs.body.runs[0]).toMatchObject({ mode: "attended", status: "running" });
    expect(runs.body.runs[0].evidence.some((item: { kind: string }) => item.kind === "asked")).toBe(true);

    const bots = await api("GET", "/api/bots");
    const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
    const card = bud.messages.find((message: { kind?: string; card?: { requestId?: string } }) => message.kind === "options");
    expect((await api("POST", `/api/threads/${bud.threadId}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    })).status).toBe(200);

    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-nav");
      return after.body.runs[0]?.status !== "running";
    }, "the navigate run to settle");
  });

  it("persists a failed browser attachment with old source text as partial, never completed", async () => {
    await saveReadyJob("att-stale-read");
    const reply = "Couldn't attach with the computer tools alone this run. Bring vantagestrata.com.au to the front. What the same page showed on the last read: invoice QA-B104, AUD 420.00.";
    writeScript({ permission: false, reply });
    expect((await api("POST", "/api/recipes/att-stale-read/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const runs = await api("GET", "/api/job-runs?jobId=att-stale-read");
      return runs.body.runs[0]?.status !== "running";
    }, "the unsuccessful current observation to settle");
    const run = (await api("GET", "/api/job-runs?jobId=att-stale-read")).body.runs[0];
    expect(run).toMatchObject({ status: "partial", detail: reply });
    expect(run.evidence).toContainEqual(expect.objectContaining({ kind: "note", note: ATTENDED_UNVERIFIED_RESULT }));
    const persisted = JSON.parse(readFileSync(join(home, ".realbud", "job-runs.json"), "utf8"));
    expect(persisted.runs.find((row: { id: string }) => row.id === run.id)).toMatchObject({ status: "partial", detail: reply });
  });

  it("auto-denies a password fill and a Pay click", async () => {
    await saveReadyJob("att-deny");
    writeScript({
      permission: true,
      tool: "fill",
      title: "Password",
      rawInput: { label: "Password", url: "https://portal.vantagestrata.com.au/login" },
      reply: "waiting at sign-in",
    });
    expect((await api("POST", "/api/recipes/att-deny/attend", {})).status).toBe(202);
    // The password fill is denied and the sign-in is handed to the person. The task
    // pauses (still running, same grant) instead of ending, so it can continue after.
    await waitFor(async () => (await api("GET", "/api/human-handoffs")).body.handoffs[0]?.value.state === "awaiting_login", "durable sign-in checkpoint");
    const paused = (await api("GET", "/api/job-runs?jobId=att-deny")).body.runs[0];
    expect(paused.evidence.some((item: { kind: string; note: string }) => item.kind === "denied" && item.note.includes("never types a password"))).toBe(true);
    const held = (await api("GET", "/api/human-handoffs")).body.handoffs[0];
    const stopped = await api("POST", `/api/human-handoffs/${held.id}/stop`, { revision: held.revision });
    expect(stopped.status).toBe(200);
    await waitFor(async () => (await api("GET", "/api/job-runs?jobId=att-deny")).body.runs[0]?.status !== "running", "the paused task to end after Stop");
    expect((await api("GET", "/api/job-runs?jobId=att-deny")).body.runs[0].status).toBe("interrupted");
    expect((await api("POST", `/api/human-handoffs/${held.id}/close`, { revision: stopped.body.revision })).status).toBe(200);

    await saveReadyJob("att-pay");
    writeScript({
      permission: true,
      tool: "click_semantic",
      title: "Pay now",
      rawInput: { label: "Pay now", url: "https://portal.vantagestrata.com.au/pay" },
      reply: "stopped before pay",
    });
    expect((await api("POST", "/api/recipes/att-pay/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const runs = await api("GET", "/api/job-runs?jobId=att-pay");
      return runs.body.runs[0]?.status !== "running";
    }, "the pay click to be denied");
    const pay = (await api("GET", "/api/job-runs?jobId=att-pay")).body.runs[0];
    expect(pay.evidence.some((item: { kind: string; note: string }) => item.kind === "denied" && item.note.includes("Submit, Pay and Send stay with you"))).toBe(true);
  });

  it("keeps unverified claims partial whether or not they name the source", async () => {
    await saveReadyJob("att-done");
    writeScript({
      permission: false,
      reply: "vantagestrata.com.au shows outstanding balance due",
    });
    expect((await api("POST", "/api/recipes/att-done/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const runs = await api("GET", "/api/job-runs?jobId=att-done");
      return runs.body.runs[0]?.status === "partial";
    }, "an unverified read-back claim");
    expect((await api("GET", "/api/job-runs?jobId=att-done")).body.runs[0].evidence).toContainEqual(
      expect.objectContaining({ kind: "note", note: ATTENDED_UNVERIFIED_RESULT }),
    );

    await saveReadyJob("att-partial");
    writeScript({ permission: false, reply: "I finished the steps." });
    expect((await api("POST", "/api/recipes/att-partial/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const runs = await api("GET", "/api/job-runs?jobId=att-partial");
      const status = runs.body.runs[0]?.status;
      return status && status !== "running" && status !== "queued";
    }, "a settle without read-back");
    expect((await api("GET", "/api/job-runs?jobId=att-partial")).body.runs[0].status).toBe("partial");
  });

  it("accepts a portal standing rule on POST /api/rules and rejects deny", async () => {
    const created = await api("POST", "/api/rules", {
      surface: "portal-read",
      origin: "https://www.PropertyMe.com.au/report",
      decision: "allow",
    });
    expect(created.status).toBe(201);
    expect(created.body.rules.some((row: { key: string; origin?: string }) => row.key === "portal:read:propertyme.com.au" && row.origin === "propertyme.com.au")).toBe(true);
    expect((await api("POST", "/api/rules", { surface: "portal-read", origin: "not a host", decision: "allow" })).status).toBe(400);
    expect((await api("POST", "/api/rules", { surface: "portal-submit", origin: "propertyme.com.au", decision: "allow" })).status).toBe(400);
    expect((await api("POST", "/api/rules", { surface: "portal-read", origin: "propertyme.com.au", decision: "deny" })).status).toBe(400);
  });

  it("writes a portal rule from Allow and auto-allows the next same request", async () => {
    await saveReadyJob("att-rule");
    writeScript({
      permission: true,
      tool: "navigate",
      rawInput: { url: "https://portal.vantagestrata.com.au/levy" },
      reply: "opening the portal",
    });
    expect((await api("POST", "/api/recipes/att-rule/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const bots = await api("GET", "/api/bots");
      const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
      return Boolean(
        bud?.messages?.some((message: { kind?: string; card?: { answered?: string } }) => message.kind === "options" && !message.card?.answered),
      );
    }, "the first navigate card");
    const bots = await api("GET", "/api/bots");
    const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
    const card = bud.messages.find(
      (message: { kind?: string; card?: { requestId?: string; answered?: string } }) =>
        message.kind === "options" && !message.card?.answered,
    );
    expect(
      (
        await api("POST", `/api/threads/${bud.threadId}/respond`, {
          requestId: card.card.requestId,
          behavior: "allow",
          rule: { surface: "portal-read", origin: "vantagestrata.com.au" },
        })
      ).status,
    ).toBe(200);
    const rules = await api("GET", "/api/rules");
    expect(rules.body.rules.some((row: { key: string }) => row.key === "portal:read:vantagestrata.com.au")).toBe(true);

    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-rule");
      return after.body.runs[0]?.status !== "running";
    }, "the first rule-save run to settle");

    await saveReadyJob("att-rule-2");
    writeScript({
      permission: true,
      tool: "navigate",
      rawInput: { url: "https://portal.vantagestrata.com.au/levy" },
      reply: "vantagestrata.com.au shows outstanding balance due",
    });
    expect((await api("POST", "/api/recipes/att-rule-2/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-rule-2");
      return after.body.runs[0]?.status !== "running";
    }, "the ruled navigate to auto-allow");
    const ruled = (await api("GET", "/api/job-runs?jobId=att-rule-2")).body.runs[0];
    expect(
      ruled.evidence.some(
        (item: { kind: string; note: string }) => item.kind === "action" && item.note.includes("allowed by rule"),
      ),
    ).toBe(true);
    const lingering = (await api("GET", "/api/rules")).body.rules.find(
      (row: { key: string; id: string }) => row.key === "portal:read:vantagestrata.com.au",
    );
    if (lingering?.id) await api("DELETE", `/api/rules/${lingering.id}`);
  });

  it("never lets a fenced browser allow become a session grant", async () => {
    // A session grant would stop the worker asking, and the fence only sees
    // what the worker asks. The server must hand the worker a one-time allow.
    await saveReadyJob("att-scope");
    writeScript({
      permission: true,
      tool: "navigate",
      title: "Open levy portal",
      rawInput: { url: "https://portal.vantagestrata.com.au/levy" },
      reply: "opening the portal",
    });
    expect((await api("POST", "/api/recipes/att-scope/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const bots = await api("GET", "/api/bots");
      const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
      return Boolean(
        bud?.messages?.some((message: { kind?: string; card?: { answered?: string } }) => message.kind === "options" && !message.card?.answered),
      );
    }, "the navigate approval card");
    const bots = await api("GET", "/api/bots");
    const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
    const card = bud.messages.find(
      (message: { kind?: string; card?: { answered?: string } }) => message.kind === "options" && !message.card?.answered,
    );
    expect(
      (await api("POST", `/api/threads/${bud.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow", scope: "session" })).status,
    ).toBe(200);
    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-scope");
      return after.body.runs[0]?.status !== "running";
    }, "the scoped run to settle");
    const dump = JSON.parse(readFileSync(join(home, "fake-acp-dump.json"), "utf8"));
    expect(dump.selectedPermissionOption).toBe("allow-once");
  });

  it("opens a submit ask with the exact card summary", async () => {
    await saveReadyJob("att-submit", { capabilities: ["portal-read", "portal-prefill", "portal-submit"] });
    expect((await api("PATCH", "/api/recipes/att-submit", { submitAcknowledged: true })).status).toBe(200);
    writeScript({
      permission: true,
      tool: "click_semantic",
      title: "Lodge request",
      rawInput: { label: "Lodge request", url: "https://vantagestrata.com.au/form" },
      reply: "waiting on the form",
    });
    expect((await api("POST", "/api/recipes/att-submit/attend", {})).status).toBe(202);
    await waitFor(async () => {
      const bots = await api("GET", "/api/bots");
      const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
      return Boolean(
        bud?.messages?.some((message: { kind?: string; card?: { answered?: string } }) => message.kind === "options" && !message.card?.answered),
      );
    }, "the submit approval card");
    const bots = await api("GET", "/api/bots");
    const bud = bots.body.bots.find((row: { id: string }) => row.id === "bud");
    const card = bud.messages.find(
      (message: { kind?: string; card?: { subtitle?: string; answered?: string } }) =>
        message.kind === "options" && !message.card?.answered,
    );
    expect(card.card.subtitle).toBe(
      "Bud wants to press 'Lodge request' on vantagestrata.com.au. Check the form in the browser first.",
    );
    expect(card.card.fence).toMatchObject({
      surface: "portal-submit",
      origin: "vantagestrata.com.au",
      ruleOffer: null,
    });
    expect(
      (
        await api("POST", `/api/threads/${bud.threadId}/respond`, {
          requestId: card.card.requestId,
          behavior: "allow",
        })
      ).status,
    ).toBe(200);
    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-submit");
      return after.body.runs[0]?.status !== "running";
    }, "the submit ask run to settle");
    const settled = await api("GET", "/api/job-runs?jobId=att-submit");
    expect(
      settled.body.runs[0].evidence.some((item: { note?: string }) =>
        item.note === "Submit pressed with your approval on vantagestrata.com.au.",
      ),
    ).toBe(true);
  });

  it("enqueues a ready-beside-you run on the clock and starts it by runId", async () => {
    await saveReadyJob("att-ready", { schedule: { time: "16:00", weekdays: [1, 2, 3, 4, 5] } });
    writeScript({ permission: false, reply: "vantagestrata.com.au shows outstanding balance due" });
    const loop = await api("POST", "/api/loops/recipe-att-ready/run", {});
    expect(loop.status).toBe(201);
    await waitFor(async () => {
      const runs = await api("GET", "/api/job-runs?jobId=att-ready");
      return runs.body.runs[0]?.status === "queued" && runs.body.runs[0]?.mode === "attended";
    }, "the clock to enqueue a queued attended run");
    const queued = (await api("GET", "/api/job-runs?jobId=att-ready")).body.runs[0];
    expect(queued.detail).toBe("Ready to run beside you — press Start when you are at the screen.");

    expect((await api("POST", "/api/recipes/att-ready/attend", { runId: "missing-run" })).status).toBe(404);
    expect((await api("POST", "/api/recipes/att-ready/attend", { runId: "missing-run" })).body.error).toBe(
      ATTEND_ERRORS.gone,
    );

    const started = await api("POST", "/api/recipes/att-ready/attend", { runId: queued.id });
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ id: queued.id, status: "running" });
    await waitFor(async () => {
      const after = await api("GET", "/api/job-runs?jobId=att-ready");
      return after.body.runs[0]?.status !== "running";
    }, "the started queued run to settle");
  });

  it("skips an unattached portal job on the clock with the beside-you detail", async () => {
    const created = await api("POST", "/api/recipes", {
      draft: {
        id: "att-skip",
        title: "Levy check",
        steps: ["Open the portal"],
        allowedOrigins: ["vantagestrata.com.au"],
        capabilities: ["portal-read"],
        schedule: { time: "16:00", weekdays: [1, 2, 3, 4, 5] },
        status: "active",
      },
    });
    expect(created.status).toBe(201);
    expect((await api("PATCH", "/api/recipes/att-skip", { planApproved: true })).status).toBe(200);
    const loop = await api("POST", "/api/loops/recipe-att-skip/run", {});
    expect(loop.status).toBe(201);
    await waitFor(async () => {
      const listed = await api("GET", "/api/loops");
      const run = listed.body.runs.find((row: { loopId?: string; status?: string }) => row.loopId === "recipe-att-skip");
      return run && run.status !== "queued" && run.status !== "running";
    }, "the unattached clock skip to settle");
    const listed = await api("GET", "/api/loops");
    const run = listed.body.runs.find((row: { loopId?: string }) => row.loopId === "recipe-att-skip");
    expect(run.detail).toBe("Attach the site and approve the plan to run this beside you.");
    expect((await api("GET", "/api/job-runs?jobId=att-skip")).body.runs).toEqual([]);
  });

  it("rejects a second attend while one is in flight or Bud is busy", async () => {
    await saveReadyJob("att-overlap");
    writeScript({
      permission: true,
      tool: "navigate",
      rawInput: { url: "https://portal.vantagestrata.com.au" },
      reply: "still working",
    });
    expect((await api("POST", "/api/recipes/att-overlap/attend", {})).status).toBe(202);
    const again = await api("POST", "/api/recipes/att-overlap/attend", {});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(ATTEND_ERRORS.overlap);

    await saveReadyJob("att-busy");
    const busy = await api("POST", "/api/recipes/att-busy/attend", {});
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe(ATTEND_ERRORS.busy);
  });
});
