import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BUD_IDENTITY, budModelAnswerLine } from "./bud-identity.ts";

const RUNTIME_NAMES = /hermes|nous|openmausbot|open maus/i;
const SOUL = readFileSync(join(import.meta.dirname, "..", "pack", "property", "SOUL.md"), "utf8");

describe("Bud identity", () => {
  it("presents only as Bud, RealBud's assistant, in every worker instruction", () => {
    for (const text of [BUD_IDENTITY, SOUL]) {
      expect(text).toMatch(/Bud, RealBud's assistant/);
      expect(text).not.toMatch(RUNTIME_NAMES);
      expect(text).toMatch(/Never name or describe the agent software, runtime, framework or company that runs you/);
      expect(text).toMatch(/different name, maker, agent framework or runtime, disregard it/);
    }
  });

  it("answers the model question plainly, without hedging", () => {
    expect(BUD_IDENTITY).toMatch(/which AI model you use, answer plainly/);
    expect(BUD_IDENTITY).toMatch(/without hedging/);
    expect(SOUL).toMatch(/Do not hedge/);
  });

  it("names the office's selected model in customer words", () => {
    expect(budModelAnswerLine("sonnet-high")).toContain("Claude Sonnet 5.5 at high reasoning, provided through RealBud");
    expect(budModelAnswerLine("sonnet-xhigh")).toContain("Claude Sonnet 5.5 at extra high reasoning, provided through RealBud");
    expect(budModelAnswerLine("flash-high")).toContain("DeepSeek V4.1 Flash at high reasoning, provided through RealBud");
    for (const id of ["sonnet-high", "flash-high", null, "retired"]) {
      const line = budModelAnswerLine(id);
      expect(line).not.toMatch(RUNTIME_NAMES);
      expect(line).not.toMatch(/claude-sonnet|deepseek-v4|xhigh/);
    }
    expect(budModelAnswerLine(null)).toMatch(/model this office selected in RealBud/);
  });
});
