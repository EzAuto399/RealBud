import { describe, expect, it } from "vitest";

import { peekComposioOffice } from "./composio.ts";

describe("peekComposioOffice", () => {
  it("lists Gmail subjects without echoing the Connect key", async () => {
    const result = await peekComposioOffice(
      { composio: { key: "ck_qaonlydeadbeef88" } },
      "gmail",
      async () => new Response(JSON.stringify({
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ data: { messages: [{ subject: "Arrears at Oak" }, { subject: "Owner letter" }] } }),
          }],
        },
      }), { status: 200 }),
    );
    expect(result).toEqual({ ok: true, titles: ["Arrears at Oak", "Owner letter"] });
    expect(JSON.stringify(result)).not.toMatch(/ck_/);
  });
});
