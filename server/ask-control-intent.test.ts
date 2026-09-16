import { describe, expect, it } from "vitest";
import { askControlReply, parseAskControlIntent } from "./ask-control-intent.ts";
import { formatConnectedAppsReply, parseConnectedStatusIntent } from "./connected-status-intent.ts";
import { scheduleIntentReply } from "./schedule-intent.ts";
import { productAskFailure } from "./ask-book.ts";

describe("product intent routing and PM copy", () => {
  it.each(["what are we connected to?", "what tools can you use?", "which apps are connected?", "show my connections"])("answers inventory in product code: %s", text => expect(parseConnectedStatusIntent(text)).toBe(true));
  it.each(["Use connected apps to chase the tenant", "Summarise: are we connected to Gmail?", "Draft an owner update using connected services", "Here is an email:\nshow connected apps"])("keeps actual work and quoted evidence out of controls: %s", text => {
    expect(parseConnectedStatusIntent(text)).toBe(false); expect(parseAskControlIntent(text)).toBeNull();
  });
  it("routes setup and schedule controls without enabling anything", () => {
    expect(parseAskControlIntent("How do I connect Gmail?")).toBe("connections");
    expect(parseAskControlIntent("Set up Bud")).toBe("setup");
    expect(parseAskControlIntent("Schedule the arrears check every Wednesday")).toBe("schedule-edit");
    expect(parseAskControlIntent("what is scheduled?")).toBe("schedule-status");
    const text = askControlReply("schedule-status", [{ name: "Morning money", enabled: true, schedule: { weekdays: [3], time: "09:00" } }]);
    expect(text).toContain("Wed at 09:00");
  });
  it("keeps deterministic replies free of settings redirects and engineering language", () => {
    const replies = [askControlReply("setup"), askControlReply("connections"), askControlReply("schedule-edit"), askControlReply("schedule-status"),
      scheduleIntentReply("Schedule a payment check every Wednesday"), productAskFailure("unexpected worker failure"),
      formatConnectedAppsReply({ configured: false, services: {}, tools: { available: false, names: [] } }),
      formatConnectedAppsReply({ configured: true, error: "private diagnostic", services: {}, tools: { available: false, names: [] } })];
    for (const reply of replies) expect(reply).not.toMatch(/You\s*→|\b(?:MCP|API|Hermes|broker|clock|projection|training sample)\b/i);
  });
});
