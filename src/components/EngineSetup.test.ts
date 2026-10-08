import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";

const open = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-setup", () => ({ openWorkspaceSetup: open }));
import { EngineSetup, needsSignIn } from "./EngineSetup";

// The real worker descriptor still carries an install line, a sign-in command
// and an upstream docs link; none of it may reach the person.
const worker: InstanceInfo = {
  instanceId: "hermes", driverKind: "hermesAgent", displayName: "Hermes Agent",
  snapshot: { state: "unavailable", reason: "`/synthetic/bin/hermes` isn't installed, or isn't on this app's PATH" },
  models: { default: "fictional", options: [] },
  install: { command: { darwin: "curl -fsSL https://fictional.example/install.sh | bash", win32: "fictional-install.ps1", linux: "fictional-install.sh" }, docsUrl: "https://fictional.example/docs/", signInCommand: "hermes -p property model", needsNode: true },
};

describe("EngineSetup routes to Bud's own setup", () => {
  it("shows one Set up Bud action and no terminal, command, engine name or docs link", () => {
    for (const instance of [worker, { ...worker, snapshot: { state: "available" as const, authenticated: false } }]) {
      const html = renderToStaticMarkup(createElement(EngineSetup, { instance }));
      expect(html).toContain("Set up Bud");
      expect(html).not.toMatch(/Terminal|curl|install\.sh|hermes|Hermes|-p property|docs|href=|Node\.js|npm|Copy|Allow|synthetic|PATH/);
    }
  });

  it("opens Bud setup in Workspace when pressed", () => {
    const tree = EngineSetup({ instance: worker }) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    const button = tree.props.children.find(child => typeof child?.props?.onClick === "function");
    button!.props.onClick();
    expect(open).toHaveBeenCalledWith("bud");
  });

  it("still tells an installed but signed-out worker apart", () => {
    expect(needsSignIn({ ...worker, snapshot: { state: "available", authenticated: false } })).toBe(true);
    expect(needsSignIn({ ...worker, snapshot: { state: "available", authenticated: true } })).toBe(false);
    expect(needsSignIn(worker)).toBe(false);
  });
});
