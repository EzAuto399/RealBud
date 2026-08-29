import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { RecoveryUnlockPanel } from "./RecoveryUnlockPanel";
import { resolveSetupJourneyStage, SetupJourney } from "./SetupJourney";

describe("focused first-run setup journey", () => {
  it("shows only the current setup decision while readiness is loading", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <SetupJourney onClose={() => undefined} />
      </StoreProvider>,
    );

    expect(html).toContain("Prepare Bud");
    expect(html).toContain("1 of 3");
    expect(html).toContain("Checking this computer");
    expect(html).toContain("Nothing is sent or paid during setup");
    expect(html).toContain("Open Desk");
    expect(html).not.toContain("Use practice desk");
    expect(html).not.toContain("Approved capabilities");
    expect(html).not.toContain("Technical details and repair");
    expect(html).not.toContain("Connections");
    expect(html).not.toContain("Recovery key");
    expect(html).not.toContain("Hermes");
  });

  it("keeps the PM in one ordered setup decision across resume states", () => {
    const stage = (workerOperation: Parameters<typeof resolveSetupJourneyStage>[0]["workerOperation"], portfolioReady = false) =>
      resolveSetupJourneyStage({ hydrated: true, recoveryActive: false, workerOperation, portfolioReady });

    expect(stage("install")).toEqual({ kind: "worker", step: 1, label: "Prepare Bud", complete: false });
    expect(stage("pack")).toEqual({ kind: "worker", step: 1, label: "Prepare Bud", complete: false });
    expect(stage("model")).toEqual({ kind: "worker", step: 2, label: "Connect model", complete: false });
    expect(stage("test")).toEqual({ kind: "worker", step: 2, label: "Check Bud", complete: false });
    expect(stage("done")).toEqual({ kind: "portfolio", step: 3, label: "Add portfolio", complete: false });
    expect(stage("done", true)).toEqual({ kind: "ready", step: 3, label: "Ready", complete: true });
  });

  it("lets recovery replace setup instead of appearing beside operational settings", () => {
    expect(resolveSetupJourneyStage({
      hydrated: true,
      recoveryActive: true,
      workerOperation: "done",
      portfolioReady: true,
    })).toEqual({ kind: "recovery", step: null, label: "Recovery", complete: false });

    const html = renderToStaticMarkup(<RecoveryUnlockPanel />);
    expect(html).toContain("Restore the protected book");
    expect(html).toContain('type="password"');
    expect(html).toContain("Restore book");
    expect(html).not.toContain("Reveal recovery key");
    expect(html).not.toContain("Open Recovery");
  });

  it("does not advance from loading until every authoritative owner has hydrated", () => {
    expect(resolveSetupJourneyStage({
      hydrated: false,
      recoveryActive: false,
      workerOperation: "done",
      portfolioReady: true,
    })).toEqual({ kind: "loading", step: 1, label: "Prepare Bud", complete: false });
  });
});
