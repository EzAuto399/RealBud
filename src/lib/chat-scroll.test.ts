import { describe, expect, it, vi } from "vitest";

import { CHAT_END_SENTINEL, chatJumpBehavior, distanceFromChatEnd, scrollChatToEnd } from "./chat-scroll";

describe("chat scrolling", () => {
  it("measures the remaining distance without returning negatives", () => {
    expect(distanceFromChatEnd({ scrollHeight: 2_000, scrollTop: 1_200, clientHeight: 600 })).toBe(200);
    expect(distanceFromChatEnd({ scrollHeight: 500, scrollTop: 10, clientHeight: 600 })).toBe(0);
  });

  it("animates only short explicit jumps", () => {
    expect(chatJumpBehavior({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 600 }, { animate: true })).toBe("smooth");
    expect(chatJumpBehavior({ scrollHeight: 8_000, scrollTop: 0, clientHeight: 600 }, { animate: true })).toBe("auto");
    expect(
      chatJumpBehavior(
        { scrollHeight: 1_000, scrollTop: 300, clientHeight: 600 },
        { animate: true, reducedMotion: true },
      ),
    ).toBe("auto");
  });

  it("uses a stable end sentinel so streamed follow does not read layout height", () => {
    const scrollTo = vi.fn();
    scrollChatToEnd({ scrollHeight: 9_000, scrollTop: 0, clientHeight: 600, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: CHAT_END_SENTINEL, behavior: "auto" });
  });
});
