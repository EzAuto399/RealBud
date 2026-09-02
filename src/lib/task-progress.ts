export interface TaskProgress {
  label: string;
  reassurance: string;
}

/** Honest stage copy for work whose provider does not expose a percentage.
 * Time selects a useful explanation; it never pretends to measure completion. */
export function recheckProgress(elapsedSeconds: number): TaskProgress {
  if (elapsedSeconds < 4) return { label: "Reading the current book", reassurance: "Nothing is sent or changed." };
  if (elapsedSeconds < 10) return { label: "Checking the connected source", reassurance: "A missing fact stays held." };
  return { label: "Applying safeguards and holding any misses", reassurance: "Nothing is sent or changed." };
}

export function jobBuildProgress(elapsedSeconds: number): TaskProgress {
  if (elapsedSeconds < 4) return { label: "Understanding the outcome and timing", reassurance: "No job is on the clock yet." };
  if (elapsedSeconds < 10) return { label: "Building safe steps and source boundaries", reassurance: "Consequential actions stay excluded." };
  return { label: "Checking the review plan", reassurance: "You will see the exact plan before it joins the clock." };
}

export function jobRunProgress(elapsedSeconds: number, rehearsal: boolean): TaskProgress {
  if (elapsedSeconds < 4) return { label: rehearsal ? "Starting the rehearsal" : "Starting the job", reassurance: "Nothing is sent or submitted." };
  if (elapsedSeconds < 15) return { label: "Reading approved sources and preparing evidence", reassurance: "A source miss stays visible." };
  return { label: "Bud is still working within the saved limits", reassurance: "You can leave Schedule; the receipt will remain." };
}
