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
  isAskServiceLinked,
  askConnectMailSubtitle,
  mapOfficeSourceError,
  askConnectMethodBadge,
  askConnectMethodFill,
  askConnectMethodTitle,
  askConnectPanel,
  askConnectUseStandardLabel,
  askConnectWizardBarFill,
  askConnectWizardDetail,
  askConnectWizardProgress,
  askConnectWizardStep,
  isRejectedOfficeKey,
  defaultAskConnectMethod,
  isLiveAskConnectMethod,
  localAskConnectFromSpeech,
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
    expect(askConnectHeading({ target: "connections", service: "Google Claendar" })).toBe("Connect Google Calendar");
    expect(askConnectPanel({ target: "connections", service: "Google Claendar" })).toBe("mail");
    expect(askConnectPanel({ target: "connections", service: "Property Tree" })).toBe("book");
    expect(askConnectPanel({ target: "connections", service: "WhatsApp Business" })).toBe("pocket-whatsapp");
    expect(askConnectPanel({ target: "computer-use" })).toBe("computer-use");
  });

  it("opens the Notion card from speech even when the harness is down", () => {
    expect(localAskConnectFromSpeech("connect me to notion")).toEqual({
      target: "connections",
      service: "Notion",
    });
    expect(localAskConnectFromSpeech("what is on Desk")).toBeNull();
  });

  it("lets a missing Composio account be signed in on the named-tool card", () => {
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true, officeMail: true })).toBe("restricted-composio");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).toBe("direct-api");
    expect(defaultAskConnectMethod({ composioLinked: true, hasNamedToolkit: false })).toBe("isolated-cli");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: false })).toBe("isolated-cli");
    expect(askConnectMethodTitle("isolated-cli")).toBe("Attach an export");
    expect(askConnectMethodTitle("isolated-cli")).not.toMatch(/CLI/i);
    expect(askConnectComposioStatus({
      composioLinked: false,
      toolConnected: null,
      hasNamedToolkit: true,
    })).toBe("Sign in");
    expect(askConnectMailSubtitle(false)).toMatch(/Named read only/i);
    expect(askConnectMailSubtitle(true)).toMatch(/Named read only/i);
    expect(askConnectMailSubtitle(false)).toMatch(/Nothing sends/i);
    expect(askConnectWizardStep({ hasNamedToolkit: true, composioLinked: false })).toBe("link-composio");
    expect(askConnectWizardStep({ hasNamedToolkit: true, composioLinked: true })).toBe("link-composio");
    expect(askConnectWizardStep({ hasNamedToolkit: true, composioLinked: true, keyVerified: true })).toBe("sign-in-source");
    expect(askConnectWizardStep({
      hasNamedToolkit: true, composioLinked: true, keyVerified: true, toolConnected: true,
    })).toBe("ready");
    expect(askConnectWizardStep({
      hasNamedToolkit: true, composioLinked: true, keyVerified: true, keyRejected: true,
    })).toBe("link-composio");
    expect(askConnectWizardStep({ hasNamedToolkit: false, composioLinked: true })).toBe("attach-export");
    expect(askConnectWizardProgress("link-composio")).toEqual({
      current: 1, total: 2, label: "Link Composio", complete: false,
    });
    expect(askConnectWizardProgress("link-composio", { keyRejected: true }).label).toBe("This key was refused");
    expect(askConnectWizardProgress("sign-in-source")).toEqual({
      current: 2, total: 2, label: "Sign in this account", complete: false,
    });
    expect(askConnectWizardBarFill(1, 1, false)).toBe("current");
    expect(askConnectWizardBarFill(1, 2, false)).toBe("full");
    expect(askConnectWizardBarFill(2, 2, false)).toBe("current");
    expect(askConnectWizardBarFill(2, 2, true)).toBe("full");
    expect(askConnectWizardBarFill(2, 1, false)).toBe("empty");
    expect(askConnectWizardDetail("sign-in-source", "Gmail")).toMatch(/Sign in Gmail/i);
    expect(askConnectWizardDetail("sign-in-source", "Gmail")).not.toMatch(/Nothing sends/i);
    expect(askConnectWizardDetail("link-composio", "Gmail")).not.toMatch(/Nothing sends/i);
    expect(askConnectWizardDetail("link-composio", "Gmail", { keyRejected: true })).toMatch(/refused/i);
    expect(askConnectMailSubtitle(true, false)).toMatch(/Attach an export this office already has/i);
    expect(askConnectMailSubtitle(true, false)).not.toMatch(/Sign in this account/i);
    expect(COMPOSIO_SIGN_IN_URL).toBe("https://platform.composio.dev");
    expect(askConnectHeading({ target: "composio-account" })).toBe("Sign in to Composio");
    expect(mapOfficeSourceError("Connectors are not part of RealBud.")).toMatch(/office login/i);
    expect(mapOfficeSourceError("Connectors are not part of RealBud.")).not.toMatch(/Connectors are not part/i);
    expect(mapOfficeSourceError("Composio MCP: HTTP 401")).toMatch(/did not accept this Connect key/i);
    expect(isRejectedOfficeKey("Composio MCP: HTTP 401")).toBe(true);
    expect(isRejectedOfficeKey("Composio did not accept this Connect key.")).toBe(true);
    expect(isRejectedOfficeKey("Could not open a login page for Gmail.")).toBe(false);
  });

  it("ranks methods professionally and fills only the live standard", () => {
    expect([...ASK_CONNECT_METHOD_ORDER]).toEqual([
      "direct-api",
      "restricted-composio",
      "approved-mcp",
      "isolated-cli",
    ]);
    expect(isLiveAskConnectMethod("direct-api")).toBe(true);
    expect(isLiveAskConnectMethod("approved-mcp")).toBe(false);
    expect(isLiveAskConnectMethod("restricted-composio")).toBe(true);
    expect(isLiveAskConnectMethod("isolated-cli")).toBe(true);
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true, officeMail: true })).toBe("restricted-composio");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).toBe("direct-api");
    expect(defaultAskConnectMethod({ composioLinked: false, hasNamedToolkit: true })).not.toBe("approved-mcp");
    expect(askConnectMethodBadge({
      method: "restricted-composio",
      currentStandard: "restricted-composio",
    })).toEqual({ label: "Current standard", tone: "standard" });
    expect(askConnectMethodBadge({
      method: "direct-api",
      currentStandard: "restricted-composio",
    })).toEqual({ label: "Available", tone: "live" });
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
    expect(askConnectMethodFill({ method: "direct-api", hasNamedToolkit: true })).toBe("direct");
    expect(askConnectMethodFill({ method: "direct-api", hasNamedToolkit: false })).toBe("gated");
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

  it("opens a named-app card for a spoken tool", () => {
    expect(askConnectPanel({ target: "connections", service: "instagram" })).toBe("mail");
    expect(askConnectHeading({ target: "connections", service: "instagram" })).toBe("Connect Instagram");
    expect(askConnectHeading({ target: "connections", service: "Notion" })).toBe("Connect Notion");
    expect(askConnectHeading({ target: "connections", service: "Notion" }, true)).toBe("Notion on this device");
    expect(isAskServiceLinked("Notion", [{ slug: "notion", label: "Notion", connected: true }])).toBe(true);
    expect(isAskServiceLinked("Notion", [])).toBe(false);
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
