import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import {
  connectedAppsMode, GmailReadOnlySetup, gmailReadOnlySetupInput,
  saveGmailReadOnlySetup, selectedConnectedAppsConfigured, switchConnectedAppsMode,
} from "./GmailReadOnlySetup";
import { ConnectedAppsCard } from "./ConnectedAppsCard";

const store = vi.hoisted(() => ({ state: { config: null as ConfigStatus | null, connected: true, bots: [] }, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: store.state, dispatch: store.dispatch }), api: store.api }));

const status = (fields: Partial<ConfigStatus["composio"]> = {}): ConfigStatus => ({
  composio: { configured: true, apiKeyConfigured: false, mode: "consumer", readOnlyConfigured: false, ...fields }, box: { configured: false },
});
const ready = () => status({ apiKeyConfigured: true, readOnlyConfigured: true, readOnlyAuthConfigId: "ac_gmail_readonly" });
const input = { apiKey: "project-key-fixture", authConfigId: "ac_gmail_readonly" };

beforeEach(() => { store.api.mockReset(); store.dispatch.mockReset(); store.state.config = status(); store.state.connected = true; });

describe("read-only setup request and response", () => {
  it("requires an auth config and a new or already-saved project key before requesting setup", async () => {
    const request = vi.fn();
    await expect(saveGmailReadOnlySetup({ ...input, authConfigId: " " }, false, request)).rejects.toThrow("auth config ID");
    await expect(saveGmailReadOnlySetup({ ...input, apiKey: " " }, false, request)).rejects.toThrow("private API key");
    await expect(saveGmailReadOnlySetup({ ...input, authConfigId: "consumer-config" }, false, request)).rejects.toThrow("ac_");
    await expect(saveGmailReadOnlySetup({ ...input, apiKey: "bad\nkey" }, false, request)).rejects.toThrow("invalid characters");
    expect(request).not.toHaveBeenCalled();
    expect(gmailReadOnlySetupInput({ apiKey: "", authConfigId: " ac_gmail_readonly " }, true)).toEqual({ apiKey: "", authConfigId: "ac_gmail_readonly" });
  });

  it("saves only the explicit config/key, without activating the mode or starting a connection", async () => {
    const request = vi.fn().mockResolvedValue(ready());
    const result = await saveGmailReadOnlySetup(input, false, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/connected-apps/gmail-readonly/setup", { method: "POST", body: JSON.stringify(input) });
    expect(result.composio.mode).toBe("consumer");
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it("does not clear the saved project key when the field is blank", async () => {
    const request = vi.fn().mockResolvedValue(ready());
    await saveGmailReadOnlySetup({ ...input, apiKey: "" }, true, request);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ apiKey: "", authConfigId: input.authConfigId });
  });

  it("rejects mismatched, incomplete and unverified responses without echoing provider errors", async () => {
    for (const response of [{}, status(), { composio: ready().composio }, status({ ...ready().composio, readOnlyAuthConfigId: "ac_other" })]) {
      await expect(saveGmailReadOnlySetup(input, false, vi.fn().mockResolvedValue(response))).rejects.toThrow("Setup could not be confirmed");
    }
    const error = new Error("private fixture key was rejected upstream");
    await expect(saveGmailReadOnlySetup(input, false, vi.fn().mockRejectedValue(error))).rejects.not.toThrow(error.message);
    expect(input).toEqual({ apiKey: "project-key-fixture", authConfigId: "ac_gmail_readonly" });
  });

  it("projects public status instead of retaining unexpected returned secrets", async () => {
    const returned = { ...ready(), privatePayload: "sensitive fixture", composio: { ...ready().composio, apiKey: "sensitive fixture", userId: "private identity fixture" } };
    const result = await saveGmailReadOnlySetup(input, false, vi.fn().mockResolvedValue(returned));
    expect(JSON.stringify(result)).not.toContain("fixture");
    expect(result.composio.readOnlyAuthConfigId).toBe(input.authConfigId);
  });
});

describe("explicit connection choice", () => {
  it("keeps legacy consumer status separate from read-only readiness", () => {
    expect(connectedAppsMode(undefined)).toBe("consumer");
    expect(selectedConnectedAppsConfigured({ configured: true })).toBe(true);
    expect(selectedConnectedAppsConfigured({ configured: true, mode: "gmail-readonly", readOnlyConfigured: false })).toBe(false);
    expect(selectedConnectedAppsConfigured({ configured: false, mode: "gmail-readonly", readOnlyConfigured: true })).toBe(true);
    expect(selectedConnectedAppsConfigured({ configured: false, mode: "consumer", readOnlyConfigured: true })).toBe(false);
  });

  it("switches only after a matching configured response, sending no credentials", async () => {
    const request = vi.fn().mockResolvedValue(status({ ...ready().composio, mode: "gmail-readonly" }));
    await switchConnectedAppsMode("gmail-readonly", request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/connected-apps/mode", { method: "POST", body: '{"mode":"gmail-readonly"}' });
    for (const response of [ready(), status({ configured: true, mode: "gmail-readonly", readOnlyConfigured: false }), {}]) {
      await expect(switchConnectedAppsMode("gmail-readonly", vi.fn().mockResolvedValue(response))).rejects.toThrow("could not be confirmed");
    }
  });

  it("does not retry or expose a lost mutation outcome", async () => {
    const request = vi.fn().mockRejectedValue(new Error("provider secret fixture"));
    await expect(switchConnectedAppsMode("consumer", request)).rejects.toThrow("Refresh settings");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("optional setup and Gmail-only layout", () => {
  const renderSetup = (config: ConfigStatus | null, connected = true) => renderToStaticMarkup(createElement(GmailReadOnlySetup, {
    config, connected, onSaved: vi.fn(), onPendingChange: vi.fn(),
  }));

  it("keeps admin setup collapsed, private, and explicit about consent", () => {
    const html = renderSetup(status());
    expect(html.split(">")[0]).not.toContain("open=");
    expect(html).toContain("Optional: Gmail read-only setup");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("separate Composio developer project");
    expect(html).toContain('href="https://dashboard.composio.dev/"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use Gmail read-only/);
    expect(html).toContain("min-h-11");
    expect(store.api).not.toHaveBeenCalled();
  });

  it("offers saved-key reuse and blocks operations offline", () => {
    const html = renderSetup(ready(), false);
    expect(html).toContain("Saved — leave blank to keep it");
    expect(html).toContain('value="ac_gmail_readonly"');
    expect(html).toContain("does not confirm Google consent or a successful mailbox read");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("Reconnect to RealBud");
  });

  it("preserves consumer defaults and app shortcuts", () => {
    store.state.config = status();
    const html = renderToStaticMarkup(createElement(ConnectedAppsCard));
    expect(html).toContain("Connect Gmail");
    expect(html).toContain("Connect Outlook");
    expect(html).toContain("Connect Notion");
    expect(html).toContain("Connect Google Calendar");
    expect(store.api).not.toHaveBeenCalled();
  });

  it("shows Gmail in read-only mode even with no consumer key and hides unsupported actions", () => {
    store.state.config = status({ ...ready().composio, configured: false, mode: "gmail-readonly" });
    const html = renderToStaticMarkup(createElement(ConnectedAppsCard));
    expect(html).toContain("Gmail read-only setup saved");
    expect(html).toContain("Connect Gmail");
    expect(html).not.toContain("Connect Outlook");
    expect(html).not.toContain("Connect Notion");
    expect(html).not.toContain("Connect Google Calendar");
    expect(html).toContain("Other connected apps key");
    expect(html).toContain("Google consent and mailbox access are checked separately");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare email follow-ups/);
  });
});
