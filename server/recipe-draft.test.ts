import { readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";
import { privateFixtureDirectory, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";
import * as workerProfiles from "./hermes-profile.ts";
import * as workerStatus from "./hermes-status.ts";
import * as workerProcesses from "./procs.ts";
import { askWorker, draftRecipeFromText, lastJsonObject, shapeRecipeDraft } from "./recipe-draft.ts";
import { clearManagedAccess, FICTIONAL_GRANTED_KEY, grantManagedAccess } from "./testing/managed-grant.ts";
import { startAskModelRelay } from "./ask-model-relay.ts";
import { propertyProfileDir } from "./hermes-pack.ts";

const dirs: string[] = [];

function sequencedWorker(answers: string[]) {
  const fixture = fakeHermes("unused");
  dirs.push(fixture.dir);
  const callsFile = join(fixture.dir, "calls.json");
  const script = join(fixture.dir, "sequenced-worker.mjs");
  writeFileSync(script, [
    "#!/usr/bin/env node",
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'if (process.argv.includes("--version")) { console.log("Hermes Agent v0.20.3 (2026.8.16.2)"); process.exit(0); }',
    `const path = ${JSON.stringify(callsFile)};`,
    'const calls = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];',
    `const answers = ${JSON.stringify(answers)};`,
    'const answer = answers[calls.length] ?? "Unexpected extra model request";',
    'calls.push(process.argv.slice(2)); writeFileSync(path, JSON.stringify(calls));',
    'process.stdout.write(answer);',
  ].join("\n"));
  chmodSync(script, 0o755);
  return {
    opts: { cli: script, root: fixture.dir },
    calls: () => JSON.parse(readFileSync(callsFile, "utf8")) as string[][],
  };
}

const fictionalCard = {
  title: "Review selected invoices",
  steps: ["Read the selected invoices", "Prepare unresolved matches for review"],
  allowedOrigins: [],
  evidence: "Invoice source and unresolved matches",
  capabilities: ["read-files", "analyse", "draft"],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearManagedAccess();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("complete worker JSON", () => {
  it("launches each selected member profile without reading the base or another member profile", async () => {
    const { dir } = fakeHermes("unused"); dirs.push(dir);
    const script = join(dir, "member-profile.mjs");
    writeFileSync(script, `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv.includes('--version')) { console.log('Hermes Agent v0.20.3 (2026.8.16.2)'); process.exit(0); }\nconst args=process.argv.slice(2);const profile=args[args.indexOf('--profile')+1];\nconsole.log(JSON.stringify({profile,soul:readFileSync(join(process.env.HERMES_HOME,'profiles',profile,'SOUL.md'),'utf8')}));\n`);
    chmodSync(script, 0o755);
    for (const member of ['alice', 'bob']) {
      const selection=workerProfiles.hermesProfileFor('property',member);
      const path=join(dir,'profiles',selection.profile);privateFixtureDirectory(path);
      writePrivateFixtureFile(join(path,'SOUL.md'),`Fictional ${member} private profile`);
      writePrivateFixtureFile(join(path,'config.yaml'),'approvals:\n  mode: manual\ncron_mode: deny\n');
      const result=await workerProfiles.withWorkerProfile(member,()=>askWorker('Profile boundary',{cli:script,root:dir}));
      expect(result.ok).toBe(true);
      if(result.ok)expect(JSON.parse(result.stdout)).toEqual({profile:selection.profile,soul:`Fictional ${member} private profile`});
    }
  });

  it("does not fall back to an installed base pack when the selected member pack is missing", async () => {
    const {dir,script,argsFile}=fakeHermes('must not launch');dirs.push(dir);
    expect(await workerProfiles.withWorkerProfile('missing',()=>askWorker('No fallback',{cli:script,root:dir}))).toMatchObject({ok:false});
    expect(existsSync(argsFile)).toBe(false);
  });

  it("holds launch when the selected identity changes during the awaited version probe", async () => {
    const {dir,script,argsFile}=fakeHermes('must not launch');dirs.push(dir);
    let selection=workerProfiles.hermesProfileFor('property');
    vi.spyOn(workerProfiles,'currentWorkerProfile').mockImplementation(()=>selection);
    vi.spyOn(workerStatus,'probeHermesVersion').mockImplementation(async()=>{
      await Promise.resolve();selection=workerProfiles.hermesProfileFor('property','other-member');
      return 'Hermes Agent v0.20.3 (2026.8.16.2)';
    });
    expect(await askWorker('Changed selection',{cli:script,root:dir})).toMatchObject({ok:false});
    expect(existsSync(argsFile)).toBe(false);
  });

  it("launches the checked profile instead of an ambient personal Hermes home", async () => {
    const { dir } = fakeHermes("unused"); dirs.push(dir);
    const captured = join(dir, "worker-environment.json");
    const script = join(dir, "profile-check.mjs");
    writeFileSync(script, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) { console.log('Hermes Agent v0.20.3 (2026.8.16.2)'); process.exit(0); }\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ home: process.env.HERMES_HOME, safe: process.env.HERMES_SAFE_MODE, args: process.argv.slice(2) }));\nconsole.log('profile checked');\n`);
    chmodSync(script, 0o755);
    vi.stubEnv("HERMES_HOME", join(dir, "unrelated-personal-home"));
    vi.stubEnv("REALBUD_HERMES_HOME", join(dir, "other-realbud-home"));
    expect(await askWorker("Synthetic profile test", { cli: script, root: dir })).toMatchObject({ ok: true });
    const child = JSON.parse(readFileSync(captured, "utf8"));
    expect(child).toMatchObject({ home: dir, safe: "1" });
    expect(child.args.slice(0, 2)).toEqual(["--profile", "property"]);
  });

  it("gives the one-shot worker only the Ask relay's token and overlay, never the office key, and nothing to a tampered endpoint", async () => {
    const { dir } = fakeHermes("unused"); dirs.push(dir);
    const captured = join(dir, "worker-key.json");
    const script = join(dir, "key-check.mjs");
    writeFileSync(script, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) { console.log('Hermes Agent v0.20.3 (2026.8.16.2)'); process.exit(0); }\nwriteFileSync(${JSON.stringify(captured)}, JSON.stringify({ grant: process.env.REALBUD_MODEL_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, modelvia: process.env.MODELVIA_API_KEY ?? null, managedDir: process.env.HERMES_MANAGED_DIR ?? null }));\nconsole.log('ok');\n`);
    chmodSync(script, 0o755);
    vi.stubEnv("OPENAI_API_KEY", "fictional-ambient-openai");
    vi.stubEnv("MODELVIA_API_KEY", "fictional-ambient-modelvia");
    vi.stubEnv("REALBUD_MODEL_API_KEY", "fictional-ambient-grant");
    grantManagedAccess(dir);
    const relay = await startAskModelRelay({ root: dir, overlayDir: join(dir, "relay-overlay") });
    try {
      expect(await askWorker("Synthetic grant test", { cli: script, root: dir })).toMatchObject({ ok: true });
      const child = JSON.parse(readFileSync(captured, "utf8"));
      expect(child).toMatchObject({ openai: null, modelvia: null, managedDir: relay.overlayDir });
      expect(child.grant).toEqual(expect.any(String));
      expect(child.grant).not.toBe(FICTIONAL_GRANTED_KEY);
      // The worker can write its own profile: a changed endpoint gets neither the relay nor a key.
      const config = join(propertyProfileDir(dir), "config.yaml");
      writeFileSync(config, readFileSync(config, "utf8").replace("https://gateway.fictional.test/v1", "https://attacker.invalid/v1"));
      expect(await askWorker("Synthetic tamper test", { cli: script, root: dir })).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ grant: null, openai: null, modelvia: null, managedDir: null });
      clearManagedAccess();
      expect(await askWorker("Synthetic unpaired test", { cli: script, root: dir })).toMatchObject({ ok: true });
      expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual({ grant: null, openai: null, modelvia: null, managedDir: null });
    } finally { await relay.close(); }
  });

  it("does not start cancelled preparation", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await askWorker("unused", { signal: controller.signal })).toEqual({ ok: false, detail: "Preparation cancelled." });
  });

  it.skipIf(process.platform === "win32")("kills the owned preparation process when cancelled", async () => {
    const { dir, script } = fakeHermes("unused"); dirs.push(dir);
    const pidFile = join(dir, "worker.pid");
    writeFileSync(script, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Hermes Agent v0.20.3 (2026.8.16.2)'; exit 0; fi\necho $$ > '${pidFile}'\nexec sleep 60\n`);
    chmodSync(script, 0o755);
    const controller = new AbortController();
    const pending = askWorker("bounded test", { cli: script, root: dir, signal: controller.signal });
    try {
      // `echo` creates the file before it writes the pid; an empty read is pid 0,
      // and process.kill(0, 0) signals this test's own group. Wait for the newline.
      const written = () => existsSync(pidFile) && /^\d+\n$/.test(readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 3000;
      while (!written() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(written()).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort();
      expect(await pending).toEqual({ ok: false, detail: "Preparation cancelled." });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { controller.abort(); await pending; }
  });
  it("reads the final complete object despite fences and an extra closing brace", () => {
    const final = { title: "Owner update", schedule: { time: "16:00", weekdays: [5] } };
    expect(lastJsonObject(`Earlier: {"title":"old"}\n\`\`\`json\n${JSON.stringify(final)}\n}\n\`\`\``)).toEqual(final);
  });

  it("preserves braces, escaped quotes, backslashes and fences inside report text", () => {
    const final = { outputs: ['Report with {braces}, "quotes", \\paths and ```code``` inside.'] };
    expect(lastJsonObject(JSON.stringify(final))).toEqual(final);
  });

  it("rejects malformed fields and does not extract a nested object from a truncated reply", () => {
    expect(lastJsonObject('{"summary":bad}')).toBeNull();
    expect(lastJsonObject('{"summary":"unfinished", "nested":{"summary":"not a receipt"}')).toBeNull();
  });
});

describe("draftRecipeFromText", () => {
  it("asks for named-site read/search capabilities without suggesting submission or granting approval", async () => {
    const worker = sequencedWorker([JSON.stringify({
      ...fictionalCard, allowedOrigins: ["portal.fictional.example"], capabilities: ["portal-read", "portal-prefill", "analyse"],
    })]);
    const result = await shapeRecipeDraft("Read and search invoices on portal.fictional.example; leave records unchanged.", worker.opts);
    const args = worker.calls()[0];
    const prompt = args[args.indexOf("-q") + 1];
    expect(prompt).toContain("Include portal-read when the job must read a named website.");
    expect(prompt).toContain("Include portal-prefill only when that job requires entering search or filter fields");
    expect(prompt).toContain("Never return portal-submit");
    expect(prompt).toContain("unapproved suggestion, not permission to act");
    expect(result.draft).toMatchObject({
      capabilities: ["portal-read", "portal-prefill", "analyse"], status: "shadow",
      planApprovedAt: null, approvedRevision: null, submitAcknowledgedAt: null,
    });
  });

  it("regenerates one overlong step without truncating work, changing the job or granting authority", async () => {
    const invalid = { ...fictionalCard, steps: ["FICTIONAL_PRIVATE_OUTPUT".repeat(12)] };
    const corrected = { ...fictionalCard, description: "Model tried to replace the job" };
    const worker = sequencedWorker([JSON.stringify(invalid), JSON.stringify(corrected)]);
    const description = "Review the selected fictional invoices.\nKeep  both spaces; never submit or pay.";
    const result = await shapeRecipeDraft(description, { ...worker.opts, toolsets: ["file", "web"] });
    expect(result.draft).toMatchObject({
      ...fictionalCard, description, status: "shadow", revision: 1,
      planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null,
    });
    const calls = worker.calls();
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args[args.indexOf("--toolsets") + 1]).toBe("todo");
      expect(args[args.indexOf("-q") + 1].endsWith(`Job:\n${description}`)).toBe(true);
      expect(args[args.indexOf("-q") + 1]).not.toContain("FICTIONAL_PRIVATE_OUTPUT");
    }
    expect(calls[1][calls[1].indexOf("-q") + 1]).toContain("Each step must be 1 to 200 characters.");
  });

  it("stops after a second invalid card and keeps the actionable validation failure", async () => {
    const invalid = JSON.stringify({ ...fictionalCard, steps: ["x".repeat(201)] });
    const worker = sequencedWorker([invalid, invalid, JSON.stringify(fictionalCard)]);
    expect(await shapeRecipeDraft("Review selected fictional invoices.", worker.opts)).toEqual({
      draft: null, detail: "Bud's job card needs a correction: Each step must be 1 to 200 characters.",
    });
    expect(worker.calls()).toHaveLength(2);
  });

  it("rejects a prohibited capability on both attempts instead of silently dropping it", async () => {
    const invalid = JSON.stringify({ ...fictionalCard, capabilities: ["analyse", "payment"] });
    const worker = sequencedWorker([invalid, invalid]);
    expect(await shapeRecipeDraft("Prepare a fictional payment review; never release payment.", worker.opts)).toEqual({
      draft: null, detail: "Bud's job card needs a correction: That job asks for a capability Bud cannot be granted.",
    });
    expect(worker.calls()).toHaveLength(2);
  });

  it("regenerates an incomplete JSON response without feeding the broken content back", async () => {
    const worker = sequencedWorker(['{"title":"FICTIONAL_PRIVATE_OUTPUT",', JSON.stringify(fictionalCard)]);
    expect((await shapeRecipeDraft("Review selected fictional invoices.", worker.opts)).draft?.title).toBe(fictionalCard.title);
    const calls = worker.calls();
    expect(calls).toHaveLength(2);
    const repair = calls[1][calls[1].indexOf("-q") + 1];
    expect(repair).toContain("Return one complete JSON job card with the required fields.");
    expect(repair).not.toContain("FICTIONAL_PRIVATE_OUTPUT");
  });

  it.each(["launch", "network", "timeout"])("does not regenerate after a %s failure", async (kind) => {
    const { dir, script } = fakeHermes("unused"); dirs.push(dir);
    vi.spyOn(workerStatus, "probeHermesVersion").mockResolvedValue("Hermes Agent v0.20.3 (2026.8.16.2)");
    const launch = vi.spyOn(workerProcesses, "execFileCli").mockImplementation((_cli, _args, _opts, cb) => {
      cb(Object.assign(new Error("fictional worker failure"), {
        code: kind === "launch" ? "ENOENT" : "ECONNRESET", killed: kind === "timeout",
      }), "", "");
      return null;
    });
    expect(await shapeRecipeDraft("Review selected fictional invoices.", { cli: script, root: dir })).toEqual({
      draft: null, detail: kind === "timeout" ? "Bud took too long." : "Bud could not answer.",
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate when access to the selected worker pack is unavailable", async () => {
    const { dir, script } = fakeHermes("unused"); dirs.push(dir);
    rmSync(propertyProfileDir(dir), { recursive: true });
    const probe = vi.spyOn(workerStatus, "probeHermesVersion");
    expect(await shapeRecipeDraft("Review selected fictional invoices.", { cli: script, root: dir })).toMatchObject({
      draft: null, detail: expect.stringContaining("pack is missing"),
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([1, 2])("stops on cancellation during attempt %s without another model call", async (cancelOn) => {
    const { dir, script } = fakeHermes("unused"); dirs.push(dir);
    const controller = new AbortController();
    vi.spyOn(workerStatus, "probeHermesVersion").mockResolvedValue("Hermes Agent v0.20.3 (2026.8.16.2)");
    const signals: (AbortSignal | undefined)[] = [];
    const launch = vi.spyOn(workerProcesses, "execFileCli").mockImplementation((_cli, _args, opts, cb) => {
      signals.push(opts.signal);
      if (signals.length === cancelOn) controller.abort();
      cb(null, "Not a JSON card", "");
      return null;
    });
    expect(await shapeRecipeDraft("Review selected fictional invoices.", { cli: script, root: dir, signal: controller.signal })).toEqual({
      draft: null, detail: "Preparation cancelled.",
    });
    expect(launch).toHaveBeenCalledTimes(cancelOn);
    expect(signals.at(-1)).toBe(signals[0]);
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it.each([false, true])("shares the original timeout budget with repair (exhausted: %s)", async (exhausted) => {
    const { dir, script } = fakeHermes("unused"); dirs.push(dir);
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(workerStatus, "probeHermesVersion").mockResolvedValue("Hermes Agent v0.20.3 (2026.8.16.2)");
    const budgets: (number | undefined)[] = [];
    const launch = vi.spyOn(workerProcesses, "execFileCli").mockImplementation((_cli, _args, opts, cb) => {
      budgets.push(opts.timeout);
      now += exhausted ? 100 : 30;
      cb(null, budgets.length === 1 ? "Not a JSON card" : JSON.stringify(fictionalCard), "");
      return null;
    });
    const result = await shapeRecipeDraft("Review selected fictional invoices.", { cli: script, root: dir, timeoutMs: 100 });
    if (exhausted) {
      expect(result).toEqual({ draft: null, detail: "Bud took too long." });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(budgets).toEqual([100]);
    } else {
      expect(result.draft?.title).toBe(fictionalCard.title);
      expect(budgets).toEqual([100, 70]);
    }
  });

  it("returns a shadow card when the worker names a job", async () => {
    const { dir, script, argsFile } = fakeHermes(
      `Here you go.\n{"title":"Friday arrears","steps":["Open the arrears report","Park 7+ day late tenancies on Desk"],"allowedOrigins":["https://www.PropertyMe.com.au/report"],"evidence":"arrears rows"}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday check PropertyMe arrears.", { cli: script, root: dir });
    expect(draft).toMatchObject({
      title: "Friday arrears",
      description: "Every Friday check PropertyMe arrears.",
      steps: ["Open the arrears report", "Park 7+ day late tenancies on Desk"],
      allowedOrigins: ["propertyme.com.au"],
      evidence: "arrears rows",
      capabilities: ["read-book", "analyse", "draft"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
      status: "shadow",
      revision: 1,
      approvedRevision: null,
    });
    expect(typeof draft?.id).toBe("string");
    expect(typeof draft?.createdAt).toBe("number");
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args[args.indexOf("--toolsets") + 1]).toBe("todo");
    expect(args).not.toContain("terminal");
    expect(args).not.toContain("delegation");
  });

  it("returns 503-shaped miss when the worker answers junk", async () => {
    const { dir, script } = fakeHermes("Sure, just open the portal and have a look.");
    dirs.push(dir);
    const shaped = await shapeRecipeDraft("Check arrears.", { cli: script, root: dir });
    expect(shaped.draft).toBeNull();
    expect(`Bud could not shape that job — ${shaped.detail}`).toMatch(/could not shape that job/);
    expect(shaped.detail).toMatch(/without a job card/);
  });

  it("explains an invalid field without exposing the worker's content", async () => {
    const privateMarker = "PRIVATE_WORKER_CONTENT";
    const { dir, script } = fakeHermes(JSON.stringify({
      title: "Review quotes",
      steps: ["Read the selected quotes"],
      allowedOrigins: [],
      evidence: privateMarker.repeat(12),
    }));
    dirs.push(dir);
    const shaped = await shapeRecipeDraft("Review selected quotes.", { cli: script, root: dir });
    expect(shaped.draft).toBeNull();
    expect(shaped.detail).toBe("Bud's job card needs a correction: Evidence must be at most 200 characters.");
    expect(shaped.detail).not.toContain(privateMarker);
  });

  it("does not spawn the live worker under VITEST without a cli stub", async () => {
    const draft = await draftRecipeFromText("Check arrears.");
    expect(draft).toBeNull();
  });

  it("keeps a named cadence on the card", async () => {
    const { dir, script } = fakeHermes(
      `{"title":"Friday arrears","steps":["Open the arrears report"],"allowedOrigins":["propertyme.com.au"],"evidence":"arrears rows","schedule":{"time":"16:00","weekdays":[5]}}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday 4pm check PropertyMe arrears.", { cli: script, root: dir });
    expect(draft?.schedule).toEqual({ time: "16:00", weekdays: [5] });
  });

  it("drops a junk cadence instead of failing the draft", async () => {
    const { dir, script } = fakeHermes(
      `{"title":"Friday arrears","steps":["Open the arrears report"],"allowedOrigins":["propertyme.com.au"],"evidence":"arrears rows","schedule":{"time":"4pm","weekdays":["Friday"]}}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday 4pm check PropertyMe.", { cli: script, root: dir });
    expect(draft?.title).toBe("Friday arrears");
    expect(draft?.schedule).toBeNull();
  });

  it("keeps only allowlisted prepare capabilities", async () => {
    const { dir, script } = fakeHermes(
      `{"title":"Owner research","steps":["Research the named source","Draft a note"],"allowedOrigins":[],"evidence":"source links","capabilities":["web-research","analyse","draft"]}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Research the market and draft an owner note.", { cli: script, root: dir });
    expect(draft?.capabilities).toEqual(["web-research", "analyse", "draft"]);
  });
});
