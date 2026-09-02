export interface ChatScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const STREAM_COMMIT_INTERVAL_MS = 32;
export const CHAT_END_SENTINEL = 1_000_000_000;

export function distanceFromChatEnd(metrics: ChatScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/** Long native smooth-scroll animations fight a growing streamed message.
 * Animate only a short explicit jump; long jumps and reduced-motion users go
 * straight to the latest content. */
export function chatJumpBehavior(
  metrics: ChatScrollMetrics,
  options?: { reducedMotion?: boolean; animate?: boolean },
): ScrollBehavior {
  if (!options?.animate || options.reducedMotion) return "auto";
  return distanceFromChatEnd(metrics) <= Math.max(240, metrics.clientHeight * 1.25) ? "smooth" : "auto";
}

export function scrollChatToEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight" | "scrollTo">,
  options?: { reducedMotion?: boolean; animate?: boolean },
): void {
  element.scrollTo({
    // Avoid a scrollHeight layout read in the hot streaming loop. Browsers
    // clamp this stable sentinel to the real bottom.
    top: CHAT_END_SENTINEL,
    behavior: chatJumpBehavior(element, options),
  });
}
