import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GoLiveChecklist } from "./GoLiveChecklist";

describe("Go-live setup guide", () => {
  it("puts every setup area on the first Desk card without a fake connect action", () => {
    const html = renderToStaticMarkup(
      <GoLiveChecklist
        mode="demo"
        recoveryActive={false}
        worker={null}
        agencyName="RealBud Demo Book"
        onOpenDesk={() => undefined}
        onOpenWorker={() => undefined}
        onOpenAgency={() => undefined}
        onOpenComputerUse={() => undefined}
        onOpenRecovery={() => undefined}
        onOpenReminders={() => undefined}
        onOpenConnections={() => undefined}
        remindersAvailable={false}
        remindersOn={false}
        pocket={{ pilotReady: false, connectedCount: 0, state: "pilot-gated" }}
      />,
    );

    expect(html).toContain("Set up RealBud around your work");
    expect(html).toContain("Prepare Bud");
    expect(html).toContain("Verify the live book");
    expect(html.indexOf("Prepare Bud")).toBeLessThan(html.indexOf("Verify the live book"));
    expect(html).toContain("connect a model securely");
    expect(html).toContain("Agency");
    expect(html).toContain("Computer use");
    expect(html).toContain("Recovery");
    expect(html).toContain("Reminders");
    expect(html).toContain("Inbox/Pocket");
    expect(html).toContain("Pilot-gated");
    expect(html).toContain("permissions are requested only after you choose Set up");
    expect(html).not.toContain(">Connect<");
    expect(html).not.toContain("Install worker");
    expect(html).not.toContain("Property pack");
    expect(html).not.toContain("Hermes");
  });

  it("collapses the compact Desk guide to one chip that opens the journey", () => {
    const html = renderToStaticMarkup(
      <GoLiveChecklist
        mode="demo"
        recoveryActive={false}
        worker={null}
        compact
        onOpenDesk={() => undefined}
        onOpenWorker={() => undefined}
        onOpenAgency={() => undefined}
        onOpenComputerUse={() => undefined}
        onOpenRecovery={() => undefined}
        onOpenReminders={() => undefined}
        onOpenConnections={() => undefined}
        remindersAvailable={false}
        remindersOn={false}
        pocket={{ pilotReady: false, connectedCount: 0, state: "pilot-gated" }}
      />,
    );

    expect(html).toContain("Checking Bud");
    expect(html).toContain("left. Opens the setup guide");
    expect(html).not.toContain("Finish setting up RealBud");
    expect(html).not.toContain("Agency");
    expect(html).not.toContain("Computer use");
    expect(html).not.toContain("Reminders");
    expect(html).not.toContain("Inbox/Pocket");
    expect(html).not.toContain(">Connect<");
    expect(html).not.toContain("Install worker");
    expect(html).not.toContain("Property pack");
    expect(html).not.toContain("Hermes");
  });
});
