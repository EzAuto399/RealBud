import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { Composer } from "./Composer";

const bud = {
  id: "bud",
  threadId: "thread-ask",
  name: "Bud",
  title: "",
  description: "",
  notifications: false,
  color: "sage",
  unread: false,
  modelSelection: { instanceId: "none", model: "" },
  messages: [],
} as Bot;

describe("Ask composer attach", () => {
  it("shows a labelled Attach control on the product Ask composer", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <Composer bot={bud} productAsk />
      </StoreProvider>,
    );
    expect(html).toContain("Attach");
    expect(html).toContain("ask-attach-files");
    expect(html).toContain('accept="');
    expect(html).toContain(".pdf");
    expect(html).not.toContain("File selection is available in the RealBud desktop app");
  });
});
