import { readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";
import { privateFixtureDirectory, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";
import * as workerProfiles from "./hermes-profile.ts";
import * as workerStatus from "./hermes-status.ts";
import { askWorker, draftRecipeFromText, lastJsonObject, shapeRecipeDraft } from "./recipe-draft.ts";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
      const deadline = Date.now() + 3000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
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
