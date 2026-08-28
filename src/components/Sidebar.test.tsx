import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InitialsAvatar } from "./Avatar";
import { YOU_NAV_LABEL, profileInitials } from "./Sidebar";

describe("You nav", () => {
  it("keeps initials decorative so the nav name stays You", () => {
    expect(YOU_NAV_LABEL).toBe("You");
    expect(profileInitials({ name: "Ava Chen" })).toBe("AC");
    expect(profileInitials({ name: "Ava QA" })).toBe("AQ");
    const avatar = renderToStaticMarkup(<InitialsAvatar initials="AC" size={20} />);
    expect(avatar).toContain('aria-hidden="true"');
    expect(avatar).toContain("AC");
    expect(avatar).not.toContain("You");
  });
});
