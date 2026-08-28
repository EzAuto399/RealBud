import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ModelUsageSummary, WorkRoutingPlan } from "@shared/contracts";
import { GeneralControlPanel, UpdatesControlPanel, UsageControlPanel, WorkPreferenceControl } from "./RealBudControls";

describe("RealBud controls", () => {
  const localPlan: WorkRoutingPlan = {
    kind: "realbud.work-routing.v1",
    schemaVersion: 1,
    preferenceConfigured: false,
    preferenceRevision: 0,
    requestedMode: "auto",
    selectedMode: "local-standard",
    propertyCount: 100,
    lanes: [{
      kind: "structured-batch",
      state: "ready",
      itemCount: 100,
      batchCount: 1,
      concurrency: 1,
      isolation: "realbud-process",
      detail: "100 records in one batch.",
    }],
    estimate: {
      basis: "unavailable",
      minimumSeconds: null,
      maximumSeconds: null,
      detail: "Timing will appear after this workflow has measured runs.",
    },
    fallbackReasons: [],
    boundaries: {
      cloudRequired: false,
      maxIsolatedBrowsers: 2,
      maxDesktopCua: 1,
      workerOwnership: "external-pinned-runtime",
      browserOwnership: "realbud-only",
      personalBrowserAccess: false,
      personalHermesAccess: false,
    },
  };

  it("shows the timezone hold and immutable manual-approval boundary without permissive controls", () => {
    const html = renderToStaticMarkup(
      <GeneralControlPanel
        bookTimezone="Australia/Brisbane"
        deviceTimezone="Australia/Sydney"
        timezonePaused
        workPlan={localPlan}
        onOpenComputerUse={() => undefined}
      />,
    );
    expect(html).toContain("Schedule paused");
    expect(html).toContain("Manual Allow · locked");
    expect(html).toContain("Local standard");
    expect(html).toContain("100 property records are processed as one local batch");
    expect(html).toContain("Cloud is optional");
    expect(html).not.toContain("Always allow");
    expect(html).not.toContain("Allow automatically");
    expect(html).not.toContain('role="switch"');
  });

  it("offers plain-language remembered work methods without granting a browser or cloud route", () => {
    const html = renderToStaticMarkup(
      <WorkPreferenceControl
        plan={localPlan}
        value="auto"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("How Bud should run work");
    expect(html).toContain("Automatic default");
    expect(html).toContain("Automatic");
    expect(html).toContain("Steady on this Mac");
    expect(html).toContain("Faster on this Mac");
    expect(html).toContain("Cloud when connected");
    expect(html).toContain("never connects an account");
    expect(html).toContain("personal browser profile");
    expect(html).not.toContain("browser_exec");
    expect(html).not.toContain("Always allow");
  });

  it("keeps the choice disabled while saving and exposes a recoverable failure", () => {
    const saving = renderToStaticMarkup(
      <WorkPreferenceControl plan={localPlan} value="local-standard" saving onChange={() => undefined} />,
    );
    expect(saving).toContain("Saving");
    expect(saving).toContain("disabled");

    const failed = renderToStaticMarkup(
      <WorkPreferenceControl plan={localPlan} value="auto" error="The choice could not be saved." onChange={() => undefined} />,
    );
    expect(failed).toContain("Retry needed");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The choice could not be saved.");
  });

  it("renders provider-reported usage without inventing spend", () => {
    const usage: ModelUsageSummary = {
      period: { kind: "rolling", days: 7, startsAt: 1, endsAt: 2 },
      completedTurns: 3,
      successfulTurns: 2,
      failedTurns: 1,
      tokenReportedTurns: 2,
      inputTokens: 1_200,
      outputTokens: 300,
      costReportedTurns: 0,
      costUsd: null,
      lastUsedAt: null,
      lastProvider: "hermesAgent",
      lastModel: "model-a",
      metering: "partial",
      storage: "ok",
      detail: "Private local meter.",
    };
    const html = renderToStaticMarkup(<UsageControlPanel usage={usage} loading={false} error="" onRefresh={() => undefined} />);
    expect(html).toContain("Completed turns");
    expect(html).toContain("1,200");
    expect(html).toContain("Not reported");
    expect(html).toContain("never estimates missing spend");
    expect(html).toContain("Cost boundaries");
    expect(html).toContain("Pricing not configured");
    expect(html).toContain("records checked or portal checks completed");
    expect(html).not.toContain("$0.00");
  });

  it("distinguishes source-build app updates from the private worker updater", () => {
    const html = renderToStaticMarkup(
      <UpdatesControlPanel
        updaterAvailable={false}
        updaterState={null}
        worker={null}
        onAppUpdate={() => undefined}
        onOpenWorker={() => undefined}
      />,
    );
    expect(html).toContain("Installed app only");
    expect(html).toContain("Source builds do not contact a release feed");
    expect(html).toContain("Open Worker");
    expect(html).toContain("personal Hermes");
  });
});
