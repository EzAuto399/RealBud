import { describe, expect, it } from "vitest";

import { verifyToolKey } from "./tool-verify.ts";

describe("verifyToolKey", () => {
  it("accepts a Notion bot and returns the workspace name", async () => {
    const result = await verifyToolKey("notion", "ntn_testkeyvalue99", {
      fetch: async () => new Response(JSON.stringify({
        name: "RealBud QA",
        bot: { workspace_name: "Northside" },
      }), { status: 200 }),
    });
    expect(result).toEqual({ ok: true, account: "Northside" });
  });

  it("refuses a rejected Notion key", async () => {
    const result = await verifyToolKey("notion", "ntn_badkeyvalue99", {
      fetch: async () => new Response("{}", { status: 401 }),
    });
    expect(result).toEqual({ ok: false, error: "Notion did not accept this API key." });
  });
});
