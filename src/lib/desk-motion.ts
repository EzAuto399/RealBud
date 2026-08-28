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
