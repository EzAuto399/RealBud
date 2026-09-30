/** Modelvia admission uses gross spend plus outstanding reservations, before
 * credits. Net invoiced cost is a different number and must not drive this bar.
 * Keep money in BigInt; convert only the bounded display percentage to Number. */
export type UsageBudget =
  | { state: 'unavailable' }
  | { state: 'disabled' }
  | { state: 'ready'; percent: number; label: string; committedNanoAud: string };

export function usageBudget(cap: string | null | undefined, remaining: string | null | undefined): UsageBudget {
  if (typeof cap !== 'string' || !/^\d{1,60}$/.test(cap)) return { state: 'unavailable' };
  const ceiling = BigInt(cap);
  if (ceiling === BigInt(0)) return { state: 'disabled' };
  if (typeof remaining !== 'string' || !/^\d{1,60}$/.test(remaining)) return { state: 'unavailable' };
  const available = BigInt(remaining);
  if (available > ceiling) return { state: 'unavailable' };
  const committed = ceiling - available;
  // Round down so 99.99% never claims that the budget is exhausted.
  const percent = Number(committed * BigInt(1000) / ceiling) / 10;
  const label = committed > BigInt(0) && percent === 0 ? '<0.1%' : `${percent}%`;
  return { state: 'ready', percent, label, committedNanoAud: committed.toString() };
}

export const USAGE_BUDGET_NOTE = 'Budget used includes reserved amounts for unfinished requests, before credits. Cost so far is after credits, so the figures can differ.';
