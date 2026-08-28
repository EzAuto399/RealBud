import { describe, expect, it } from "vitest";

import {
  ASK_CONNECT_METHOD_ORDER,
  COMPOSIO_SIGN_IN_URL,
  askConnectBookSubtitle,
  askConnectComposioStatus,
  askConnectComposioUnavailableDetail,
  askConnectFromSpentAction,
  askConnectGatedDetail,
  askConnectHeading,
  askConnectMailSubtitle,
  askConnectMethodBadge,
  askConnectMethodFill,
  askConnectMethodTitle,
  askConnectPanel,
  askConnectUseStandardLabel,
  defaultAskConnectMethod,
  isLiveAskConnectMethod,
  popAskConnectState,
  pushAskConnectState,
  replaceAskConnectState,
  suggestedOfficeName,
} from "./ask-connect";

describe("Ask connect sheet", () => {
  it("names the office tool the PM asked for", () => {
    expect(askConnectHeading({ target: "connections", service: "Gmail" })).toBe("Connect Gmail");
    expect(askConnectHeading({ target: "connections", service: "google-calendar" })).toBe("Connect Google Calendar");
    expect(askConnectPanel({ target: "connections", service: "google-calendar" })).toBe("mail");
    expect(askConnectHeading({ target: "connections" })).toBe("Connect a source");
    expect(askConnectPanel({ target: "connections", service: "Gmail" })).toBe("mail");
    expect(askConnectPanel({ target: "connections", service: "Property Tree" })).toBe("book");
    expect(askConnectPanel({ target: "connections", service: "WhatsApp Business" })).toBe("pocket-whatsapp");
    expect(askConnectPanel({ target: "computer-use" })).toBe("computer-use");
  });

  it("lets a missing Composio account be signed in on the named-tool card", () => {
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).toBe("restricted-composio");
    expect(defaultAskConnectMethod({ composioLinked: true, hasNamedToolkit: false })).toBe("isolated-cli");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: false })).toBe("isolated-cli");
    expect(askConnectMethodTitle("isolated-cli")).toBe("Attach an export");
    expect(askConnectMethodTitle("isolated-cli")).not.toMatch(/CLI/i);
    expect(askConnectComposioStatus({
      composioLinked: false,
      toolConnected: null,
      hasNamedToolkit: true,
    })).toBe("Sign in");
    expect(askConnectMailSubtitle(false)).toMatch(/Sign in to Composio/i);
    expect(askConnectMailSubtitle(true)).toMatch(/Sign in this account/i);
    expect(askConnectMailSubtitle(true, false)).toMatch(/Attach an export this office already has/i);
    expect(askConnectMailSubtitle(true, false)).not.toMatch(/Sign in this account/i);
    expect(COMPOSIO_SIGN_IN_URL).toBe("https://platform.composio.dev");
    expect(askConnectHeading({ target: "composio-account" })).toBe("Sign in to Composio");
  });

  it("ranks methods professionally and fills only the live standard", () => {
    expect([...ASK_CONNECT_METHOD_ORDER]).toEqual([
      "direct-api",
      "restricted-composio",
      "approved-mcp",
      "isolated-cli",
    ]);
    expect(isLiveAskConnectMethod("direct-api")).toBe(false);
    expect(isLiveAskConnectMethod("approved-mcp")).toBe(false);
    expect(isLiveAskConnectMethod("restricted-composio")).toBe(true);
    expect(isLiveAskConnectMethod("isolated-cli")).toBe(true);
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).not.toBe("direct-api");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).not.toBe("approved-mcp");
    expect(askConnectMethodBadge({
      method: "restricted-composio",
      currentStandard: "restricted-composio",
    })).toEqual({ label: "Current standard", tone: "standard" });
    expect(askConnectMethodBadge({
      method: "direct-api",
      currentStandard: "restricted-composio",
    })).toEqual({ label: "Not in this build", tone: "gated" });
    expect(askConnectMethodBadge({
      method: "isolated-cli",
      currentStandard: "restricted-composio",
    })).toEqual({ label: "Available", tone: "live" });
    expect(askConnectMethodBadge({
      method: "isolated-cli",
      currentStandard: "isolated-cli",
    })).toEqual({ label: "Current standard", tone: "standard" });
    expect(askConnectMethodFill({ method: "restricted-composio", hasNamedToolkit: true })).toBe("composio");
    expect(askConnectMethodFill({ method: "restricted-composio", hasNamedToolkit: false })).toBe("composio-unavailable");
    expect(askConnectMethodFill({ method: "direct-api", hasNamedToolkit: true })).toBe("gated");
    expect(askConnectMethodFill({ method: "approved-mcp", hasNamedToolkit: true })).toBe("gated");
    expect(askConnectMethodFill({ method: "isolated-cli", hasNamedToolkit: true })).toBe("export");
    expect(askConnectGatedDetail("direct-api", {
      toolLabel: "Gmail",
      currentStandard: "restricted-composio",
    })).toMatch(/Restricted Composio is the current standard/);
    expect(askConnectGatedDetail("approved-mcp", {
      toolLabel: "Gmail",
      currentStandard: "isolated-cli",
    })).toMatch(/Attach an export is the current standard/);
    expect(askConnectUseStandardLabel("restricted-composio")).toBe("Use Restricted Composio");
    expect(askConnectComposioUnavailableDetail("Incoming mail")).toMatch(/Attach an export is the current standard/);
  });

  it("prefills only a spoken office name, not a catalog slot", () => {
    expect(suggestedOfficeName("Gmail")).toBe("Gmail");
    expect(suggestedOfficeName("google-calendar")).toBe("Google Calendar");
    expect(suggestedOfficeName("Incoming mail")).toBeNull();
    expect(suggestedOfficeName("Property book")).toBeNull();
    expect(suggestedOfficeName("instagram")).toBeNull();
  });

  it("does not treat a social name as a PMS or inbox card", () => {
    expect(askConnectPanel({ target: "connections", service: "instagram" })).toBe("unsupported");
    expect(askConnectHeading({ target: "connections", service: "instagram" })).toBe(
      "Instagram isn't a named office source",
    );
  });

  it("keeps the book card to a name and an export", () => {
    expect(askConnectBookSubtitle()).toMatch(/Name the book/i);
    expect(askConnectBookSubtitle()).toMatch(/attach an export/i);
    expect(askConnectBookSubtitle()).not.toMatch(/Open Desk|Advanced|capabilities/i);
  });

  it("stacks an in-card pick and replaces on a new Ask turn", () => {
    const instagram = { target: "connections" as const, service: "Instagram" };
    const inbox = { target: "connections" as const, service: "Incoming mail" };
    const pushed = pushAskConnectState(instagram, [], inbox);
    expect(pushed.askConnect).toEqual(inbox);
    expect(pushed.askConnectStack).toEqual([instagram]);
    expect(popAskConnectState(pushed.askConnectStack)).toEqual({
      askConnect: instagram,
      askConnectStack: [],
    });
    expect(replaceAskConnectState(inbox)).toEqual({ askConnect: inbox, askConnectStack: [] });
    expect(pushAskConnectState(inbox, [instagram], inbox).askConnectStack).toEqual([instagram]);
  });

  it("reopens a spent receipt without a time window", () => {
    expect(askConnectFromSpentAction({
      schemaVersion: 1,
      id: "setup-gmail",
      status: "allowed",
      title: "Connect Gmail",
      detail: "Connect Gmail here in Ask.",
      createdAt: 1,
      decidedAt: 1,
      kind: "open-setup",
      target: "connections",
      service: "Gmail",
    })).toEqual({ target: "connections", service: "Gmail" });
    expect(askConnectFromSpentAction({
      schemaVersion: 1,
      id: "setup-denied",
      status: "denied",
      title: "Connect Gmail",
      detail: "Connect Gmail here in Ask.",
      createdAt: 1,
      kind: "open-setup",
      target: "connections",
      service: "Gmail",
    })).toBeNull();
  });
});
