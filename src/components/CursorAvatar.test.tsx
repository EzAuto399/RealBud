import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CursorAvatar, SHAPE } from "./CursorAvatar";

describe("RealBud mascot shape", () => {
  it("uses the RealBud property-agent silhouette as the shared avatar body", () => {
    expect(SHAPE.name).toBe("RealBud");
    expect(SHAPE.body).toContain('{{GRADIENT}}');
    expect(SHAPE.body).toContain("M693 122");
    expect(SHAPE.clip).toContain("fill-rule=\"evenodd\"");
    expect(SHAPE.body).not.toContain("translate(210,80)");
    expect(SHAPE.body).not.toContain("#000000");
  });

  it("renders the new brand name and keeps the animated face clipped to the mark", () => {
    const html = renderToStaticMarkup(
      <CursorAvatar paused effects={false} glyphs={false} size={64} />,
    );

    expect(html).toContain('aria-label="RealBud mascot"');
    expect(html).toContain("clip-path");
    expect(html).toContain("M693 122");
    expect(html).not.toContain("cursor mascot");
  });
});
