import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkRoutingPlan } from "@shared/contracts";
import type { AskActionProposal } from "@shared/ask-actions";
import { AskActionApprovalContext, AskActionExecutionPlan, SpentConnectReceipt, SpentConnectReceiptGroup } from "./AskActionCard";

const structuredPlan: WorkRoutingPlan = {
  kind: "realbud.work-routing.v1",
  schemaVersion: 1,
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
    detail: "100 portfolio records will be validated and evaluated as one local batch.",
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

const routineRequest: AskActionProposal = {
  schemaVersion: 1,
  id: "request-12345678",
  status: "pending",
  title: "Run Morning money check",
  detail: "Run it once now. Its results will land on Desk; nothing will be sent.",
  createdAt: 1_787_780_400_000,
  kind: "run-routine",
  loopId: "morning-arrears",
  loopName: "Morning money check",
  expectedLoopRevision: 4,
};

describe("Ask bulk execution route", () => {
  it("shows the admitted route, workload shape and honest timing before execution", () => {
    const html = renderToStaticMarkup(<AskActionExecutionPlan plan={structuredPlan} />);
    expect(html).toContain("Execution route");
    expect(html).toContain("local standard");
    expect(html).toContain("Structured local batch");
    expect(html).toContain("100 records · 1 batch · 1 lane");
    expect(html).toContain("Timing not measured");
    expect(html).toContain("On this device · no work is routed to cloud");
  });

  it("renders no placeholder for a gated or unknown route plan", () => {
    const gated = {
      ...structuredPlan,
      lanes: [{ ...structuredPlan.lanes[0]!, state: "gated", concurrency: 0 }],
    };
    expect(renderToStaticMarkup(<AskActionExecutionPlan plan={gated} />)).toBe("");
    expect(renderToStaticMarkup(<AskActionExecutionPlan plan={{ ...structuredPlan, schemaVersion: 2 }} />)).toBe("");
    expect(renderToStaticMarkup(<AskActionExecutionPlan plan={null} />)).toBe("");
  });

  it("names a real fallback without suggesting that cloud is required", () => {
    const html = renderToStaticMarkup(<AskActionExecutionPlan plan={{
      ...structuredPlan,
      requestedMode: "cloud-accelerated",
      fallbackReasons: ["Cloud acceleration is not connected and ready; all work remains local."],
    }} />);
    expect(html).toContain("Cloud acceleration is not connected and ready; all work remains local.");
    expect(html).toContain("On this device · no work is routed to cloud");
  });

  it("distinguishes an admitted cloud lane from local execution", () => {
    const remote = {
      ...structuredPlan,
      requestedMode: "cloud-accelerated" as const,
      selectedMode: "cloud-accelerated" as const,
      lanes: [{
        ...structuredPlan.lanes[0]!,
        kind: "remote-analysis" as const,
        isolation: "remote-isolated" as const,
      }],
    };
    const html = renderToStaticMarkup(<AskActionExecutionPlan plan={remote} />);
    expect(html).toContain("Connected cloud lane");
    expect(html).toContain("fresh connection and one-time job approval required");
    expect(html).not.toContain("no work is routed to cloud");
  });
});

describe("Ask approval experience", () => {
  it("explains why, exact permission and stopping boundary before one-time Allow", () => {
    const html = renderToStaticMarkup(<AskActionApprovalContext action={routineRequest} />);
    expect(html).toContain("Before Bud starts");
    expect(html).toContain("One-time approval");
    expect(html).toContain("Why");
    expect(html).toContain("Permission");
    expect(html).toContain("Stops at");
    expect(html).toContain("Routine revision 4 is checked again before work starts");
    expect(html).toContain("never turns it into automatic approval");
    expect(html).not.toContain("Always approve");
    expect(html).not.toContain("Allow automatically");
  });

  it("shows a completion receipt while keeping future authority manual", () => {
    const html = renderToStaticMarkup(<AskActionApprovalContext action={{
      ...routineRequest,
      status: "allowed",
      decidedAt: routineRequest.createdAt + 1_000,
    }} />);
    expect(html).toContain("Bud completed the allowed step");
    expect(html).toContain("This Allow was used once");
    expect(html).toContain("it will still need Allow");
    expect(html).not.toContain("Always approve");
  });

  it("collapses a spent connect receipt to a one-line card", () => {
    const html = renderToStaticMarkup(
      <SpentConnectReceipt
        action={{
          schemaVersion: 1,
          id: "setup-gmail",
          status: "allowed",
          title: "Connect Gmail",
          detail: "Connect Gmail here in Ask.",
          createdAt: 1_787_780_400_000,
          decidedAt: 1_787_780_401_000,
          kind: "open-setup",
          target: "connections",
          service: "Gmail",
        }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Connect Gmail");
    expect(html).toContain("Card ready");
    expect(html).toContain("Open card");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("Exact action");
    expect(html).not.toContain("Ask again any time");
    expect(html).not.toContain("Open You");
  });

  it("does not call a refused social name Ready or Completed", () => {
    const html = renderToStaticMarkup(
      <SpentConnectReceipt
        action={{
          schemaVersion: 1,
          id: "setup-ig",
          status: "allowed",
          title: "Instagram isn't a named office source",
          detail: "Social accounts stay out.",
          createdAt: 1,
          decidedAt: 2,
          kind: "open-setup",
          target: "connections",
          service: "Instagram",
        }}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Instagram isn&#x27;t a named office source");
    expect(html).toContain("Not a source");
    expect(html).toContain("Pick a source");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain("Open card");
  });

  it("groups older spent connect receipts so the thread is not a setup log", () => {
    const gmail = {
      schemaVersion: 1 as const,
      id: "setup-gmail",
      status: "allowed" as const,
      title: "Connect Gmail",
      detail: "Connect Gmail here in Ask.",
      createdAt: 1,
      decidedAt: 2,
      kind: "open-setup" as const,
      target: "connections" as const,
      service: "Gmail",
    };
    const calendar = { ...gmail, id: "setup-cal", title: "Connect Google Calendar", service: "Google Calendar" };
    const html = renderToStaticMarkup(
      <SpentConnectReceiptGroup actions={[gmail, calendar]} onOpen={() => {}} />,
    );
    expect(html).toContain("2 earlier connection cards");
    expect(html).toContain("Connect Google Calendar");
    expect(html).toContain("Open latest");
    expect(html).toContain("Show");
    expect(html).not.toContain("Exact action");
    expect(html).not.toContain("Open You");
  });

  it("keeps a named connection on Ask instead of sending the PM to You", () => {
    const html = renderToStaticMarkup(<AskActionApprovalContext action={{
      schemaVersion: 1,
      id: "setup-gmail",
      status: "allowed",
      title: "Connect Gmail",
      detail: "Connect Gmail here in Ask.",
      createdAt: 1_787_780_400_000,
      decidedAt: 1_787_780_401_000,
      kind: "open-setup",
      target: "connections",
      service: "Gmail",
    }} />);
    expect(html).toContain("Connect Gmail here");
    expect(html).toContain("The connection card is ready in Ask");
    expect(html).not.toContain("Opened the setup you asked for");
    expect(html).not.toContain("Open You");
    expect(html).not.toContain("Keys still stay in You");
  });

  it("makes denial and stale recovery explicit without implying an effect", () => {
    const denied = renderToStaticMarkup(<AskActionApprovalContext action={{ ...routineRequest, status: "denied" }} />);
    expect(denied).toContain("Nothing ran");
    const stale = renderToStaticMarkup(<AskActionApprovalContext action={{
      ...routineRequest,
      status: "stale",
      failure: "The routine changed after this request was prepared.",
    }} />);
    expect(stale).toContain("Bud stopped safely");
    expect(stale).toContain("The routine changed after this request was prepared");
  });
});
