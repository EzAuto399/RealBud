import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerUseSetupChecklist, computerUsePermissionSteps } from "./ComputerUseConnectionCard";

const localComputer = (
  overrides: Partial<DesktopCapabilities["localComputer"]> = {},
): DesktopCapabilities["localComputer"] => ({
  available: false,
  support: "limited",
  runtime: "bundled",
  reasonCode: "cua-not-enabled",
  ...overrides,
});

describe("Computer use onboarding", () => {
  it("shows the bundled runtime and only the two macOS grants RealBud needs", () => {
    const html = renderToStaticMarkup(<ComputerUseSetupChecklist computer={localComputer()} />);

    expect(html).toContain("Private computer-use runtime");
    expect(html).toContain("No separate driver download or installation is needed");
    expect(html).toContain("Accessibility");
    expect(html).toContain("Screen &amp; System Audio Recording");
    expect(html).toContain("App Management is not part of this setup");
    expect(html).toContain("separate helper or personal automation entry unchanged");
    expect(html).not.toContain("Microphone");
    expect(html).not.toContain("Notifications");
  });

  it("routes each missing grant to its fixed System Settings pane", () => {
    const opened: string[] = [];
    const computer = localComputer({ reasonCode: "cua-accessibility-and-screen-required" });
    const html = renderToStaticMarkup(
      <ComputerUseSetupChecklist computer={computer} onOpenSettings={(pane) => opened.push(pane)} />,
    );

    expect(computerUsePermissionSteps(computer)).toEqual({ accessibility: "needed", screen: "needed" });
    expect(html).toContain("Open Accessibility");
    expect(html).toContain("Open Screen Recording");
    expect(html).toContain("Check again");
    // Rendering never opens System Settings; only the PM's explicit button does.
    expect(opened).toEqual([]);
  });

  it("does not ask again for a permission the native owner already verified", () => {
    expect(
      computerUsePermissionSteps(localComputer({ reasonCode: "cua-accessibility-required" })),
    ).toEqual({ accessibility: "needed", screen: "ready" });
    expect(
      computerUsePermissionSteps(localComputer({ reasonCode: "cua-screen-recording-required" })),
    ).toEqual({ accessibility: "ready", screen: "needed" });
    expect(
      computerUsePermissionSteps(localComputer({ available: true, support: "supported", reasonCode: undefined })),
    ).toEqual({ accessibility: "ready", screen: "ready" });
  });

  it("keeps permission setup separate from a missing packaged runtime", () => {
    const html = renderToStaticMarkup(
      <ComputerUseSetupChecklist computer={localComputer({ runtime: "none", reasonCode: "cua-bundle-missing" })} />,
    );

    expect(html).toContain("must be repaired before permissions are requested");
    expect(html).not.toContain("Open Accessibility");
    expect(html).not.toContain("Open Screen Recording");
  });
});
