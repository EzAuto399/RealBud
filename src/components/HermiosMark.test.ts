import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HERMIOS_ICON_SRC, HermiosMark } from "./HermiosMark";

describe("Hermios mark", () => {
  it("is a decorative icon from the bundled brand asset", () => {
    const html = renderToStaticMarkup(createElement(HermiosMark, { size: 18 }));
    // Server rendering also adds an image preload hint; the browser app does not.
    expect(html).toContain(`<img src="${HERMIOS_ICON_SRC}" alt="" aria-hidden="true" width="18" height="18" draggable="false" class="shrink-0 select-none"/>`);
  });

  it("carries the name as visible text when the wordmark is shown", () => {
    const html = renderToStaticMarkup(createElement(HermiosMark, { wordmark: true }));
    expect(html).toContain('alt="" aria-hidden="true"');
    expect(html).toContain('<span class="font-semibold text-ink">Hermios</span>');
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("ships the brand icon as a static, self-contained image", () => {
    const svg = readFileSync(new URL(`../../public${HERMIOS_ICON_SRC}`, import.meta.url), "utf8");
    expect(svg).toContain("<title>Hermios</title>");
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|xlink:href|\shref=|@import/i);
    // The only URL is the SVG namespace; every fill reference is local.
    expect(svg.match(/https?:\/\/[^"]+/g)).toEqual(["http://www.w3.org/2000/svg"]);
  });
});
