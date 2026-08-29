import { describe, expect, it } from "vitest";

import { matchAskDeskSpeech } from "./ask-desk-speech.ts";

describe("matchAskDeskSpeech", () => {
  it("takes Desk questions and leaves tool peeks alone", () => {
    expect(matchAskDeskSpeech("What needs me?")).toBe(true);
    expect(matchAskDeskSpeech("Explain the 2 licensee holds on Desk")).toBe(true);
    expect(matchAskDeskSpeech("what can you see inside of notion")).toBe(false);
    expect(matchAskDeskSpeech("connect me to notion")).toBe(false);
  });
});
