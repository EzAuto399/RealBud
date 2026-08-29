/** Copy announces through the live region; the button pulse must follow that string. */
export function deskCopyPulse(announce: string): boolean {
  return announce === "Wording copied";
}

export function recheckButtonLabel(checking: boolean): string {
  return checking ? "Checking…" : "Recheck";
}

/** Keep the Recheck graph visible after fill so a finished check is readable. */
export const RECHECK_GRAPH_LINGER_MS = 720;

/** Queue land/exit and count ticks: long enough to read as work moving. */
export const DESK_ROW_MOTION_MS = 220;

/** Recheck beat: long enough for known addresses to land, capped so it never feels like a loader. */
export function recheckBeatMs(propertyCount: number): number {
  return Math.min(700, Math.max(360, propertyCount * 80));
}

export function recheckLandRevealed(input: {
  count: number;
  elapsedMs: number;
  durationMs: number;
  done: boolean;
  reduceMotion?: boolean;
}): number {
  if (input.count <= 0) return 0;
  if (input.done || input.reduceMotion) return input.count;
  if (input.elapsedMs <= 0) return 0;
  const step = input.durationMs / input.count;
  return Math.min(input.count, Math.max(1, Math.ceil(input.elapsedMs / step)));
}

export function recheckLandCaption(
  address: string | undefined,
  revealed: number,
  total: number,
  done: boolean,
): string {
  if (done) return `${total} checked`;
  if (address) return `Checking ${address}`;
  if (revealed > 0) return `Checking ${revealed} of ${total}`;
  return "Checking the book";
}
