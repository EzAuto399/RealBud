import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import { BudSetupCard, showsProviderCredentialFields } from "./BudSetupCard";
import { ManagedBudStatus } from "./ManagedBudStatus";
import { budAvailability } from "@/lib/bud-setup";

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
  { attached, provider: "openai-api", model },
);

const withdrawn = () => hermes(
  { managed: false, withdrawn: true, attached: false,
    detail: "Model access was withdrawn for this computer. Your records are kept. Ask service support to restore access." },
  { attached: false, provider: "openai-api", model: "gpt-5.6-sol" },
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

  it("never offers a credential field on a provisioned installation", () => {
    for (const usesProfileLogin of [false, true]) {
      for (const hasOauthOffer of [false, true]) {
        for (const useApiKey of [false, true]) {
          for (const oauthFailed of [false, true]) {
            const input = { usesProfileLogin, hasOauthOffer, useApiKey, oauthFailed };
            expect(showsProviderCredentialFields({ ...input, managed: true })).toBe(false);
          }
        }
      }
    }
    // The manual path is untouched for a development installation.
    expect(showsProviderCredentialFields({ managed: false, usesProfileLogin: false, hasOauthOffer: false, useApiKey: false, oauthFailed: false })).toBe(true);
    expect(showsProviderCredentialFields({ managed: false, usesProfileLogin: false, hasOauthOffer: true, useApiKey: false, oauthFailed: false })).toBe(false);
    expect(showsProviderCredentialFields({ managed: false, usesProfileLogin: false, hasOauthOffer: true, useApiKey: true, oauthFailed: false })).toBe(true);
  });

  it("keeps the manual provider path on an installation with no service grant", () => {
    store.state.hermes = hermes(
      { managed: false, withdrawn: false, attached: false, detail: "" },
      { attached: false, provider: null, model: null },
    );
    const html = administration();
    expect(html).toContain("Connect one provider key");
    expect(html).not.toContain("managed by RealBud service");
  });

  it("names a withdrawn grant as a hold everywhere it is reported", () => {
    store.state.hermes = withdrawn();
    const html = administration();
    expect(html).toMatch(/withdrawn/i);
    expect(html).toMatch(/records are kept/i);
    expect(html).not.toMatch(/Connect a model|Provider API key/);

    const managedSurface = renderToStaticMarkup(createElement(ManagedBudStatus, {
      id: "you-worker", status: store.state.hermes, connected: true, onRefresh: async () => {},
    }));
    expect(managedSurface).toMatch(/Model access withdrawn/);
    expect(managedSurface).toMatch(/records are kept/i);
  });
});

describe("budAvailability for managed access", () => {
  it("holds on a withdrawn grant with no action that could fix it", () => {
    const view = budAvailability(withdrawn(), true);
    expect(view).toMatchObject({ ready: false, label: "Model access withdrawn", action: null });
    expect(view.detail).toMatch(/records are kept/i);
  });

  it("asks for a model choice, not a key, while a managed grant has none", () => {
    const view = budAvailability(managed(false, null), true);
    expect(view).toMatchObject({ ready: false, label: "Model choice needed", target: "attach-model" });
    expect(view.detail).toContain("managed by RealBud service (Modelvia)");
    expect(view.detail).not.toMatch(/key/i);
  });

  it("reads as a finished model step once the managed grant names a model", () => {
    expect(budAvailability(managed(true, "gpt-5.6-sol"), true).label).toBe("Check needed");
  });
});
