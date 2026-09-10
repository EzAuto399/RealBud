import { readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";
import { askWorker, draftRecipeFromText, lastJsonObject, shapeRecipeDraft } from "./recipe-draft.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("complete worker JSON", () => {
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
