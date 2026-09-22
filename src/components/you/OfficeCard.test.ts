import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OfficeCard } from "./OfficeCard";

// The card reads the book it is handed rather than the store; the mock keeps the
// house component-test pattern if anything in its tree ever reaches for it.
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const hostZone = "America/New_York";
let original: string | undefined;

beforeAll(() => {
  // A machine already sitting in the old fallback zone would hide the bug, so
  // pin this computer's zone somewhere that fixture never is.
  original = process.env.TZ;
  process.env.TZ = hostZone;
});

afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const render = (timezone: string | null) =>
  renderToStaticMarkup(
    createElement(OfficeCard, {
      agencyName: "Harbour PM",
      timezone,
      jurisdictions: ["NSW"],
      revision: 3,
      onSave: () => Promise.resolve(),
      onReload: () => Promise.resolve(),
    }),
  );

describe("book timezone", () => {
  it("shows a recorded zone as the book's own setting", () => {
    const html = render("Australia/Brisbane");
    expect(html).toContain("Book timezone: Australia/Brisbane");
    expect(html).not.toContain("not recorded yet");
  });

  it("never presents a fixture zone as the book's setting when none is recorded", () => {
    const html = render(null);
    expect(html).toContain("Book timezone: not recorded yet.");
    expect(html).toContain(`this computer’s timezone (${hostZone})`);
    expect(html).not.toContain("Australia/Sydney");
  });

  it("keeps the form's accessible names while the zone is unrecorded", () => {
    const html = render(null);
    expect(html).toContain('aria-label="Agency name"');
    expect(html).toContain('aria-label="Office contact for RealBud"');
  });
});
