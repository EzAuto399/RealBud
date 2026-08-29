import { describe, expect, it } from "vitest";

import { linkedToolPeekCopy, peekLinkedTool } from "./tool-peek.ts";

describe("peekLinkedTool", () => {
  it("lists Notion page titles without echoing the key", async () => {
    const result = await peekLinkedTool("notion", {
      key: "ntn_testkeyvalue99",
      fetch: async () => new Response(JSON.stringify({
        results: [
          { object: "page", properties: { title: { type: "title", title: [{ plain_text: "Arrears board" }] } } },
          { object: "database", title: [{ plain_text: "Owner letters" }] },
        ],
      }), { status: 200 }),
    });
    expect(result).toEqual({ ok: true, titles: ["Arrears board", "Owner letters"] });
    expect(linkedToolPeekCopy({
      label: "Notion",
      account: "Yo Da's Space",
      titles: result.titles,
    })).toBe("Yo Da's Space is on this device. Visible now: Arrears board; Owner letters. Ask still cannot send.");
    expect(JSON.stringify(result)).not.toMatch(/ntn_/);
  });

  it("lists GitHub repos and Slack channels without echoing the key", async () => {
    const github = await peekLinkedTool("github", {
      key: "ghp_testkeyvalue99",
      fetch: async () => new Response(JSON.stringify([
        { full_name: "northside/arrears-board" },
        { name: "owner-letters" },
      ]), { status: 200 }),
    });
    expect(github).toEqual({ ok: true, titles: ["northside/arrears-board", "owner-letters"] });
    expect(linkedToolPeekCopy({
      label: "GitHub",
      slug: "github",
      titles: github.titles,
    })).toMatch(/Visible now: northside\/arrears-board; owner-letters/);
    expect(JSON.stringify(github)).not.toMatch(/ghp_/);

    const slack = await peekLinkedTool("slack", {
      key: "xoxp-testkeyvalue99",
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        channels: [{ name: "arrears" }, { name: "owners" }],
      }), { status: 200 }),
    });
    expect(slack).toEqual({ ok: true, titles: ["arrears", "owners"] });
    expect(JSON.stringify(slack)).not.toMatch(/xoxp-/);
  });
});
