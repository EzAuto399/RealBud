import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { admitAskCredential } from "./ask-credentials.ts";
import { hasLinkedToolKey, listLinkedTools } from "./linked-tools.ts";

const dirs: string[] = [];
let previousVerify: string | undefined;

beforeAll(() => {
  previousVerify = process.env.REALBUD_TOOL_VERIFY;
  process.env.REALBUD_TOOL_VERIFY = "0";
});

afterAll(() => {
  if (previousVerify === undefined) delete process.env.REALBUD_TOOL_VERIFY;
  else process.env.REALBUD_TOOL_VERIFY = previousVerify;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("admit Ask credentials", () => {
  it("saves a Notion key and returns redacted text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-admit-"));
    dirs.push(dir);
    const admitted = await admitAskCredential("connect me to notion ntn_g9538deadbeef99", { dir });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("expected admit");
    expect(admitted.text).not.toContain("ntn_");
    expect(admitted.text).toMatch(/connect me to notion/i);
    expect(admitted.linked).toMatchObject({ slug: "notion", connected: true });
    expect(hasLinkedToolKey("notion", { dir })).toBe(true);
    expect(JSON.stringify(listLinkedTools({ dir }))).not.toContain("ntn_");
  });

  it("refuses a bare token with no named tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-admit-"));
    dirs.push(dir);
    expect(await admitAskCredential("token=placeholder_credential_value_123", { dir })).toMatchObject({
      ok: false,
      code: "CREDENTIAL_IN_ASK",
    });
  });

  it("still refuses a WhatsApp token in Ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-admit-"));
    dirs.push(dir);
    const refused = await admitAskCredential("Connect WhatsApp token=placeholder_credential_value_123", { dir });
    expect(refused).toMatchObject({ ok: false, code: "CREDENTIAL_IN_ASK" });
  });
});
