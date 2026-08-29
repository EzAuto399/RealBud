import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { routineNextCaption, RoutinesPage } from "./RoutinesPage";

describe("Schedule first paint", () => {
  it("keeps the month grid unmounted until Month preview is opened", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <RoutinesPage />
      </StoreProvider>,
    );
    expect(html).toContain("Preview month");
    expect(html).toContain("Routines");
    expect(html).not.toContain("Month preview");
    expect(html).not.toContain("Previous month");
    expect(html).not.toContain("Next month");
    expect(html).not.toContain("Select a routine on the calendar");
  });

  it("does not present a stale Next while the clock chips are unsaved", () => {
    expect(routineNextCaption(false, "Mon, 31 Aug at 8:00 am")).toBe("Next: Mon, 31 Aug at 8:00 am");
    expect(routineNextCaption(true, "Mon, 31 Aug at 8:00 am")).toBe("Save to set the next run");
    expect(routineNextCaption(false, null)).toBeNull();
  });
});
