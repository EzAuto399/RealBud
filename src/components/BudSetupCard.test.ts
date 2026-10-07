import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import { BudSetupCard, ManagedModelChoices } from "./BudSetupCard";
import { ManagedBudStatus } from "./ManagedBudStatus";
import { budAvailability, parseBudStatus, parseManagedModelStatus } from "@/lib/bud-setup";

const store = vi.hoisted(() => ({
  state: { hermes: null as HermesStatus | null, connected: true, bots: [], config: null, serviceAdmin: null as unknown, desk: null, workerIssues: [] },
  dispatch: vi.fn(),
  refreshHermes: vi.fn(),
  api: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: store.state, dispatch: store.dispatch, refreshHermes: store.refreshHermes }),
  api: store.api,
}));

/** An installation whose setup is finished apart from the model step. */
function hermes(modelAccess: HermesStatus["modelAccess"], model: HermesStatus["model"]): HermesStatus {
  return {
    pin: { product: "0.21.3", tag: "v2026.9.14", commit: "fixture", profile: "property" },
    cli: { installed: true, versionText: "Hermes Agent v0.21.3 (2026.9.14)", matchesPin: true, compatible: true, probeState: "ok" },
    pack: { installed: true, approvalsManual: true, workroomReady: true },
    homeDir: "/synthetic/home", profileDir: "/synthetic/home/profiles/property",
    installCommand: null, signInCommand: "hermes -p property model",
    detail: modelAccess?.detail || "Worker 0.21.3 and Bud's hands are installed.",
    ready: false, model, modelAccess,
  };
}

const managed = (attached: boolean, model: string | null) => hermes(
  { managed: true, withdrawn: false, attached,
    detail: attached
      ? "Model access: managed by RealBud service (Modelvia). No provider key is stored on this computer."
      : "Model access: managed by RealBud service (Modelvia). Choose which model Bud should use to finish setup." },
  { attached, provider: "custom:realbud", model, choice: attached ? "sonnet-high" : null },
);

const withdrawn = () => hermes(
  { managed: false, withdrawn: true, attached: false,
    detail: "This computer's office access ended, so Bud can't answer here. Everything saved stays on this computer. Reconnect it in Workspace → Website account." },
  { attached: false, provider: "custom:realbud", model: "deepseek-v4.1-flash", choice: "flash-high" },
);

/** The administrator surface, which is the only one carrying key controls. */
function administration(): string {
  store.state.serviceAdmin = { managed: false };
  return renderToStaticMarkup(createElement(BudSetupCard, { administration: true }));
}

beforeEach(() => {
  store.api.mockReset().mockResolvedValue({});
  store.dispatch.mockReset();
  store.state.hermes = null;
  store.state.connected = true;
  store.state.serviceAdmin = null;
});

describe("provisioned installations never ask for a provider key", () => {
  it("shows managed model access instead of a provider or key control", () => {
    store.state.hermes = managed(false, null);
    const html = administration();
    expect(html).toContain("Model access: managed by RealBud service (Modelvia)");
    expect(html).not.toMatch(/Provider API key|Paste the provider key|Connect one provider key/);
    // The protocol name is an Advanced-diagnostics word, never customer copy.
    expect(html).not.toMatch(/OpenAI|Anthropic|OpenRouter/);
  });

  it("offers exactly the four managed choices as an accessible radio group", () => {
    const html = renderToStaticMarkup(createElement(ManagedModelChoices, { value: "sonnet-high", onChange: () => {} }));
    // One accessible group name: the fieldset's legend, not a second radiogroup label.
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Bud&#x27;s model<\/legend>/);
    expect(html).not.toContain('role="radiogroup"');
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    for (const label of ["DeepSeek V4.1 Flash · High", "Claude Sonnet 5.5 · Medium", "Claude Sonnet 5.5 · High", "Claude Sonnet 5.5 · Extra high"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // 44 px decision targets, and only the saved choice is checked.
    expect(html.match(/pm-decision/g)).toHaveLength(4);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.match(/<input[^>]*checked=""[^>]*>/)?.[0]).toContain('value="sonnet-high"');
    expect(html).not.toMatch(/Provider API key|password|Custom model|Base URL|Sign in with|#[0-9a-f]{6}/i);
    expect(html).not.toMatch(/Hermes|MCP|OpenAI|Modelvia/);
  });

  it("connects an unpaired computer inline from realbud.app, never with a provider key", () => {
    store.state.hermes = hermes(
      { managed: false, withdrawn: false, attached: false, detail: "" },
      { attached: false, provider: null, model: null },
    );
    const html = administration();
    // The model step is read after mount, so a static render shows its detail;
    // the inline connect action is covered by ManagedBudStatus and ConnectOffice tests.
    expect(html).toContain("Bud&#x27;s AI access comes from your office on realbud.app");
    expect(html).not.toContain(">Pair this computer</button>");
    expect(html).not.toMatch(/Connect one provider key|Provider API key|Custom provider URL|Connect model/);
    expect(html).not.toContain("managed by RealBud service");
  });

  it("parses the managed choice from status and model replies, rejecting anything else", () => {
    const status = managed(true, "claude-sonnet-5.5");
    expect(parseBudStatus(status).model?.choice).toBe("sonnet-high");
    expect(() => parseBudStatus({ ...status, model: { ...status.model!, choice: "flash-xhigh" as never } })).toThrow();
    const reply = { provider: "custom:realbud", model: "claude-sonnet-5.5", choice: "sonnet-xhigh", keyPresent: true, keyHint: "Model access: managed by RealBud service (Modelvia)", managed: true };
    expect(parseManagedModelStatus(reply).choice).toBe("sonnet-xhigh");
    expect(() => parseManagedModelStatus({ ...reply, choice: "auto" })).toThrow();
    expect(() => parseManagedModelStatus({ ...reply, managed: "yes" })).toThrow();
  });

  it("names a withdrawn grant as a hold everywhere it is reported", () => {
    store.state.hermes = withdrawn();
    const html = administration();
    expect(html).toMatch(/office access ended/i);
    expect(html).toMatch(/Everything saved stays/i);
    expect(html).not.toMatch(/Connect a model|Provider API key/);

    const managedSurface = renderToStaticMarkup(createElement(ManagedBudStatus, {
      id: "you-worker", status: store.state.hermes, connected: true, onRefresh: async () => {},
    }));
    expect(managedSurface).toMatch(/Disconnected from your office/);
    expect(managedSurface).toMatch(/Everything saved stays/i);
  });
});

describe("ready capabilities copy", () => {
  it("names only the research and file work Bud can do today", () => {
    store.state.hermes = { ...managed(true, "claude-sonnet-5.5"), ready: true };
    const html = administration();
    expect(html).toContain('aria-label="Bud capabilities"');
    expect(html).toContain("Research from your sources");
    expect(html).toContain("pages you open in the work browser");
    expect(html).toContain("Private workroom ready for your files, calculations and code.");
    // No web search or Office-format files until the runtime ships them.
    expect(html).not.toMatch(/public (information|sources)|web search|search the web|Word|Excel|PDF|files, research/i);
    expect(html).not.toMatch(/Hermes|MCP|broker/);
  });
});

describe("budAvailability for managed access", () => {
  it("shows the last failed readiness reason on the managed surface and clears it when ready", () => {
    const status = managed(true, "fictional-model");
    status.lastPing = { kind: "ping", at: 1, ok: false, detail: "This computer's AI access has expired; RealBud support needs to renew it before Bud can answer." };
    const render = () => renderToStaticMarkup(createElement(ManagedBudStatus, {
      id: "you-worker", status, connected: true, onRefresh: async () => {},
    }));
    expect(render()).toContain("Last readiness check:");
    expect(render()).toContain("access has expired");
    status.ready = true;
    expect(render()).not.toContain("Last readiness check:");
  });
  it("offers the website account path only when model access still needs connecting", () => {
    const render = (status: HermesStatus) => renderToStaticMarkup(createElement(ManagedBudStatus, {
      id: "you-worker", status, connected: true, onRefresh: async () => {},
    }));
    const missing = hermes({ managed: false, withdrawn: false, attached: false, detail: "" }, { attached: false, provider: null, model: null });
    const connect = />Connect with this code<\/button>/;
    expect(render(missing)).toMatch(connect);
    expect(render(missing)).not.toContain("Open website account");
    expect(render(missing)).toContain("Paste the link code your office owner sent you.");
    expect(render(managed(false, null))).not.toMatch(connect);
    expect(render(withdrawn())).not.toMatch(connect);
    expect(render({ ...missing, ready: true, model: { attached: true, provider: "fictional", model: "fictional" } })).not.toMatch(connect);
  });
  it("holds on a withdrawn grant and sends the person to reconnect", () => {
    const view = budAvailability(withdrawn(), true);
    expect(view).toMatchObject({ ready: false, label: "Disconnected from your office", action: "Reconnect", target: "you-website" });
    expect(view.detail).toMatch(/Everything saved stays/i);
  });

  it("asks for a model choice, not a key, while a managed grant has none", () => {
    const view = budAvailability(managed(false, null), true);
    expect(view).toMatchObject({ ready: false, label: "Model choice needed", target: "attach-model" });
    expect(view.detail).toContain("managed by RealBud service (Modelvia)");
    expect(view.detail).not.toMatch(/key/i);
  });

  it("reads as a finished model step once the managed grant names a model", () => {
    expect(budAvailability(managed(true, "claude-sonnet-5.5"), true).label).toBe("Check needed");
  });
});

describe("document tools readiness", () => {
  it("keeps Repair available and explains why no Reset action is offered", () => {
    store.state.hermes = { ...managed(true, "claude-sonnet-5.5"), documentTools: "needs_repair" } as HermesStatus;
    const html = administration();
    expect(html).toMatch(/<button\b[^>]*>\s*Repair Bud\s*<\/button>/);
    expect(html).not.toMatch(/<button\b[^>]*>[^<]*(?:Reset|Remove)[^<]*<\/button>/);
    expect(html).toContain("Reset is unavailable because RealBud cannot yet verify that every worker has stopped.");
    expect(html).toContain("Your setup is kept. Repair Bud remains available.");
    expect(store.api).not.toHaveBeenCalled();
  });

  it("names Word, Excel and PDF Repair only when the runtime reports needs_repair", () => {
    const base = managed(true, "claude-sonnet-5.5");
    for (const [documentTools, shown] of [["needs_repair", true], ["ready", false], ["unknown", false], ["unavailable_here", false]] as const) {
      store.state.hermes = { ...base, documentTools } as HermesStatus;
      const html = administration();
      expect(html.includes("Word, Excel and PDF tools need Repair")).toBe(shown);
    }
  });
  it("accepts only known document tool states from the server", () => {
    const base = managed(true, "claude-sonnet-5.5");
    expect(() => parseBudStatus({ ...base, documentTools: "needs_repair" })).not.toThrow();
    expect(() => parseBudStatus({ ...base, documentTools: "installed!" })).toThrow();
  });
});
