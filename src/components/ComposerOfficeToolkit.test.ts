import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAppsStatus } from "@shared/office-sources";
import { ComposerOfficeToolkit } from "./ComposerOfficeToolkit";

const view = vi.hoisted(() => ({ snapshot: null as ConnectedAppsStatus | null, loading: false, error: "", pendingService: null as string | null }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("@/lib/connected-apps-refresh", () => ({ useOfficeSources: () => view, officeSources: { refresh: vi.fn(), accept: vi.fn(), invalidate: vi.fn() } }));
const render = () => renderToStaticMarkup(createElement(ComposerOfficeToolkit, { productAsk: true, onAttachFiles: vi.fn() }));
beforeEach(() => Object.assign(view, { snapshot: null, loading: false, error: "", pendingService: null }));

describe("composer app details stay on demand", () => {
  it.each(["ready", "loading", "error", "signing-in"])("does not show persistent app labels for %s", state => {
    view.snapshot = { configured: true, checkedAt: new Date().toISOString(), services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "office", label: "office@example.invalid", status: "ACTIVE" }], accountSelectionRequired: false } }, tools: { available: true, names: ["mail_search"] } };
    view.loading = state === "loading";
    view.error = state === "error" ? "Connection check failed" : "";
    view.pendingService = state === "signing-in" ? "gmail" : null;
    const html = render();
    expect(html).not.toContain("Gmail");
    expect(html).not.toContain("office@example.invalid");
    expect(html).not.toContain("Connection check failed");
    expect(html).not.toContain("Checking connected apps");
    expect(html).not.toContain("Connected app status");
  });

  it("keeps the accessible Add entry point", () => {
    const html = render();
    expect(html).toContain('aria-label="Add files or apps"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });
});
