import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SupportCard, SupportCardView, supportSaveOutcome, SUPPORT_DESKTOP_ONLY, SUPPORT_FAILED, SUPPORT_SAVED, type SupportSaveState } from "./SupportCard";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), api: vi.fn() }));

const view = (state: SupportSaveState, available = true) =>
  renderToStaticMarkup(createElement(SupportCardView, { available, state, onSave: () => {} }));

describe("help and support card", () => {
  it("says exactly what the file holds and never holds, with one save action", () => {
    const html = view({ kind: "idle" });
    expect(html).toContain("Help and support");
    expect(html).toContain("RealBud’s version, this computer’s system type, how long the office service has run and its recent logs with keys and passwords masked; it never contains your documents, mail or saved credentials.");
    expect(html).toContain(">Save support file</button>");
    expect(html).not.toContain(SUPPORT_SAVED);
    expect(html).not.toContain('role="alert"');
  });

  it("shows the saving, saved and failed states", () => {
    const saving = view({ kind: "saving" });
    expect(saving).toContain("Saving…");
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/);

    const saved = view({ kind: "saved", officeReport: true });
    expect(saved).toContain("Saved. Attach it to your message to RealBud support.");
    expect(saved).not.toContain(SUPPORT_DESKTOP_ONLY);
    expect(view({ kind: "saved", officeReport: false })).toContain(SUPPORT_DESKTOP_ONLY);

    const failed = view({ kind: "failed", message: "This computer is out of disk space. Free some space, then try again." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("This computer is out of disk space. Free some space, then try again.");
  });

  it("offers no save button outside the desktop app", () => {
    expect(view({ kind: "idle" }, false)).toContain("Open the RealBud desktop app to save a support file.");
    expect(view({ kind: "idle" }, false)).not.toContain("<button");
    // Rendered without a window at all, the live card takes the same path.
    expect(renderToStaticMarkup(createElement(SupportCard))).not.toContain("<button");
  });
});

describe("desktop save outcome", () => {
  it("maps each outcome and treats anything malformed as a failure", () => {
    expect(supportSaveOutcome({ ok: true, officeReport: true })).toEqual({ kind: "saved", officeReport: true });
    expect(supportSaveOutcome({ ok: true, officeReport: false })).toEqual({ kind: "saved", officeReport: false });
    // Cancelling the save dialog is not an error and shows no message.
    expect(supportSaveOutcome({ ok: false, canceled: true })).toEqual({ kind: "idle" });
    expect(supportSaveOutcome({ ok: false, error: "A support file is already being saved." })).toEqual({ kind: "failed", message: "A support file is already being saved." });
    for (const value of [undefined, null, "saved", { ok: true }, { ok: false }, { ok: false, error: "" }, { ok: false, error: "x".repeat(301) }]) {
      expect(supportSaveOutcome(value)).toEqual({ kind: "failed", message: SUPPORT_FAILED });
    }
  });
});
