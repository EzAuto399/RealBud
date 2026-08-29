import { describe, expect, it } from "vitest";

import { ASK_CONNECTION_OPTIONS, matchAskConnectionSpeech, matchAskToolPeekSpeech, namedOfficeService, resolveAskOfficeTool, resolveConnectableTool } from "./ask-connections.ts";

describe("Ask connection speech", () => {
  it("opens the closed picker for generic tool or connection talk", () => {
    expect(matchAskConnectionSpeech("Set up connections")).toEqual({ kind: "chooser" });
    expect(matchAskConnectionSpeech("Connect a tool")).toEqual({ kind: "chooser" });
    expect(matchAskConnectionSpeech("Link my account")).toEqual({ kind: "chooser" });
  });

  it("routes named services without a marketplace", () => {
    expect(matchAskConnectionSpeech("Connect Composio to Bud")).toMatchObject({
      kind: "option",
      option: { id: "composio-account", target: "composio-account" },
    });
    expect(matchAskConnectionSpeech("We use Property Tree")).toMatchObject({
      kind: "option",
      option: { id: "property-book", service: "Property book" },
    });
    expect(matchAskConnectionSpeech("Connect our PMS")).toMatchObject({
      kind: "option",
      option: { id: "property-book" },
    });
    expect(matchAskConnectionSpeech("Connect Gmail")).toMatchObject({
      kind: "option",
      option: { id: "incoming-mail", service: "Incoming mail" },
    });
    expect(namedOfficeService(ASK_CONNECTION_OPTIONS[1]!, "connect me to gmail")).toBe("Gmail");
    expect(resolveAskOfficeTool("google-calendar")).toMatchObject({
      label: "Google Calendar",
      composioSlug: "googlecalendar",
      kind: "calendar",
    });
    expect(namedOfficeService(ASK_CONNECTION_OPTIONS[1]!, "connect me to google clandar")).toBe("Google Calendar");
    expect(namedOfficeService(ASK_CONNECTION_OPTIONS[1]!, "connect me to google claendar")).toBe("Google Calendar");
    expect(resolveAskOfficeTool("google claendar")).toMatchObject({ label: "Google Calendar", composioSlug: "googlecalendar" });
    expect(resolveAskOfficeTool("gmial")).toMatchObject({ label: "Gmail", composioSlug: "gmail" });
    expect(resolveAskOfficeTool("email")).toMatchObject({ label: "Incoming mail", composioSlug: null });
    expect(namedOfficeService(ASK_CONNECTION_OPTIONS[0]!, "We use Property Tree")).toBe("Property Tree");
    expect(matchAskConnectionSpeech("connect me to google clandar")).toMatchObject({
      kind: "option",
      option: { id: "incoming-mail" },
    });
    expect(matchAskConnectionSpeech("connect me to google claendar")).toMatchObject({
      kind: "option",
      option: { id: "incoming-mail" },
    });
    expect(matchAskConnectionSpeech("connect me to gmial")).toMatchObject({
      kind: "option",
      option: { id: "incoming-mail" },
    });
    expect(matchAskConnectionSpeech("Connect the PMS and inbox")).toEqual({ kind: "chooser" });
    expect(matchAskConnectionSpeech("Open connections")).toEqual({ kind: "chooser" });
    expect(matchAskConnectionSpeech("Set up desktop reminders")).toMatchObject({
      kind: "option",
      option: { id: "desktop-reminders", target: "desktop-reminders" },
    });
    expect(matchAskConnectionSpeech("Prepare Bud")).toMatchObject({
      kind: "option",
      option: { id: "worker", target: "worker" },
    });
    expect(matchAskConnectionSpeech("Add an approved MCP server")).toMatchObject({
      kind: "option",
      option: { id: "api-mcp" },
    });
    expect(matchAskConnectionSpeech("Connect WhatsApp to Bud")).toMatchObject({
      kind: "option",
      option: { id: "whatsapp-business", service: "WhatsApp Business" },
    });
  });

  it("opens a named app card for any spoken tool, including social names", () => {
    expect(matchAskConnectionSpeech("connect me to instagram")).toMatchObject({
      kind: "tool",
      tool: { label: "Instagram", composioSlug: "instagram", kind: "app" },
    });
    expect(matchAskConnectionSpeech("connecgt me to instagram")).toMatchObject({
      kind: "tool",
      tool: { label: "Instagram", composioSlug: "instagram" },
    });
    expect(matchAskConnectionSpeech("connect me to slack")).toMatchObject({
      kind: "tool",
      tool: { label: "Slack", composioSlug: "slack" },
    });
    expect(matchAskConnectionSpeech("connect me to notion")).toMatchObject({
      kind: "tool",
      tool: { label: "Notion", composioSlug: "notion" },
    });
    expect(matchAskConnectionSpeech("connect me to google photos")).toMatchObject({
      kind: "tool",
      tool: { label: "Google Photos", composioSlug: "googlephotos" },
    });
    expect(resolveAskOfficeTool("instagram")).toBeNull();
    expect(resolveAskOfficeTool("google photos")).toBeNull();
    expect(resolveConnectableTool("notion")).toMatchObject({ label: "Notion", composioSlug: "notion" });
    expect(resolveConnectableTool("Linear")).toMatchObject({ label: "Linear", composioSlug: "linear" });
  });

  it("refuses send, pay and unprompted curiosity", () => {
    expect(matchAskConnectionSpeech("Connect WhatsApp so Bud can send a tenant a notice")).toEqual({ kind: "none" });
    expect(matchAskConnectionSpeech("What is Composio?")).toEqual({ kind: "none" });
    expect(matchAskToolPeekSpeech("ok so what can you see inside of notion")).toMatchObject({
      label: "Notion",
      composioSlug: "notion",
    });
    expect(matchAskToolPeekSpeech("connect me to notion")).toBeNull();
    expect(matchAskToolPeekSpeech("What is Composio?")).toBeNull();
    expect(ASK_CONNECTION_OPTIONS.map((item) => item.id)).toEqual([
      "property-book",
      "incoming-mail",
      "computer-use",
      "whatsapp-business",
      "telegram",
      "api-mcp",
      "composio-account",
    ]);
  });
});
