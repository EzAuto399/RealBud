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
    expect(parseAskControlIntent("how do I connect Xero?")).toBe("connections");
    expect(parseAskControlIntent("where can I link our Slack workspace")).toBe("connections");
    expect(parseAskControlIntent("help me connect a new app")).toBe("connections");
    expect(parseAskControlIntent("How do I set up Bud?")).toBe("setup");
    expect(parseAskControlIntent("how do I connect Bud")).toBe("setup");
    for (const text of ["how do i link the lease to the property", "how do I connect the tenant with the plumber", "how do i set up a rent increase for 14 Sample Street"]) expect(parseAskControlIntent(text)).toBeNull();
    expect(parseAskControlIntent("Set up Bud")).toBe("setup");
    // Naming a cadence reaches Bud, who proposes the repeat on an approval card.
    for (const text of ["Schedule the arrears check every Wednesday", "remind me every 2 minutes about my inbox", "schedule my inbox summary hourly", "set up a reminder when new mail arrives"]) expect(parseAskControlIntent(text)).toBeNull();
    expect(parseAskControlIntent("Schedule something for me")).toBe("schedule-edit");
    expect(parseAskControlIntent("Pause the schedule")).toBe("schedule-edit");
    // Changing an existing workflow's time reaches Bud, which offers a before → after card.
    expect(parseAskControlIntent("Change the schedule for weekly bills to Thursdays")).toBeNull();
    expect(parseAskControlIntent("Reschedule the owner letters")).toBeNull();
    expect(parseAskControlIntent("what is scheduled?")).toBe("schedule-status");
    const text = askControlReply("schedule-status", [{ name: "Morning money", enabled: true, schedule: { weekdays: [3], time: "09:00" } }]);
    expect(text).toContain("Wed at 09:00");
  });
  it("answers the bank feed before connected apps, with an inline Connect action", () => {
    for (const text of ["connect to redbark", "Connect Redbark.", "redbark", "connect my bank", "How do I connect my bank?", "set up the bank feed", "bank feed", "link our bank account"]) {
      expect(parseAskControlIntent(text)).toBe("bank-feed");
    }
    for (const text of ["bank", "my bank account", "check the bank for rent from 4 Sample St", "connect the tenant's bank details to the ledger", "how do I connect Xero?"]) {
      expect(parseAskControlIntent(text)).not.toBe("bank-feed");
    }
    const reply = askControlReply("bank-feed");
    expect(reply).toBe("Redbark is RealBud's bank feed. Once connected, Bud can read accounts and transactions, never move money.\n\n[Connect bank feed](#connect-bank-feed)");
    expect(reply).not.toMatch(/\bAPI\b|\bkey\b|sign-in did not start/i);
  });
  it("keeps deterministic replies free of settings redirects and engineering language", () => {
    const replies = [askControlReply("bank-feed"), askControlReply("setup"), askControlReply("connections"), askControlReply("schedule-edit"), askControlReply("schedule-status"),
      scheduleIntentReply("Schedule a payment check every Wednesday"), productAskFailure("unexpected worker failure"),
      formatConnectedAppsReply({ configured: false, services: {}, tools: { available: false, names: [] } }),
      formatConnectedAppsReply({ configured: true, error: "private diagnostic", services: {}, tools: { available: false, names: [] } })];
    for (const reply of replies) expect(reply).not.toMatch(/You\s*→|\b(?:MCP|API|Hermes|broker|clock|projection|training sample)\b/i);
  });
});
