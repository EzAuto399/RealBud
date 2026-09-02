import { describe, expect, it } from "vitest";

import { parseConnectionIntent } from "./connection-intent.ts";

describe("parseConnectionIntent", () => {
  it("recognises direct connection instructions and normalises common app names", () => {
    expect(parseConnectionIntent("connect me to notion")).toEqual({ slug: "notion", label: "Notion" });
    expect(parseConnectionIntent("Please link our Google Calendar account.")).toEqual({
      slug: "googlecalendar",
      label: "Google Calendar",
    });
    expect(parseConnectionIntent("authorize Airtable workspace")).toEqual({ slug: "airtable", label: "Airtable" });
  });

  it("does not turn advice or compound consequential work into an automatic connection", () => {
    expect(parseConnectionIntent("how do I connect Notion?")).toBeNull();
    expect(parseConnectionIntent("connect Notion and delete a page")).toBeNull();
    expect(parseConnectionIntent("disconnect Notion")).toBeNull();
    expect(parseConnectionIntent("write an owner update")).toBeNull();
  });
});
