import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfficeBookEmpty, StartOfficeBook, isEmptyOfficeBook, offersOfficeBookStart } from "./OfficeBookNotice";

const idle = { active: false } as never;

describe("office book notices", () => {
  it("renders the empty office book without sample copy", () => {
    const html = renderToStaticMarkup(createElement(OfficeBookEmpty, { onOpenBook: () => {}, onAsk: () => {} }));
    expect(html).toContain("Your office book is empty — add properties or ask Bud to import them.");
    expect(html).toContain("Add properties");
    expect(html).toContain("Ask Bud to import");
    expect(html).not.toMatch(/sample/i);
  });

  it("names the empty live book and never treats the sample or recovery as empty", () => {
    expect(isEmptyOfficeBook({ mode: "live", demo: false, properties: [], recovery: idle })).toBe(true);
    expect(isEmptyOfficeBook({ mode: "demo", demo: true, properties: [], recovery: idle })).toBe(false);
    expect(isEmptyOfficeBook({ mode: "live", demo: false, properties: [], recovery: { active: true } as never })).toBe(false);
  });

  it("offers to start the office book only on a linked computer that still shows the sample", () => {
    expect(offersOfficeBookStart({ mode: "demo", demo: true, recovery: idle }, true)).toBe(true);
    expect(offersOfficeBookStart({ mode: "demo", demo: true, recovery: idle }, false)).toBe(false);
    expect(offersOfficeBookStart({ mode: "live", demo: false, recovery: idle }, true)).toBe(false);
    const html = renderToStaticMarkup(createElement(StartOfficeBook, { busy: false, onStart: () => {} }));
    expect(html).toContain("Start your office book");
  });
});
