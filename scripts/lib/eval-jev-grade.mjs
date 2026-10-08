// Grading and threshold sweep for scripts/eval-jev.mjs. Pure: no I/O.
//
// A record is one labelled case and what Jev answered for it:
//   choice:  { kind: 'choice', gold, answered, value (null = "none"), confidence, lead, allowed }
//   mapping: { kind: 'mapping', gold (mapping | null), answered, roles: { [role]: { value, confidence, lead } } }
//   noul:    { kind: 'noul', gold (boolean), answered, noul }
//   label:   { kind: 'label', gold (boolean: same), answered, noul } — "same" at noul >= t.same, "different" at noul <= t.different
// `accept` replays the module's own acceptance rule at given thresholds, so the
// harness can check it against what the module did and then sweep offline.

export const ROLES = ['identity', 'daysSinceDue', 'rentLanded', 'levyPaid'];
export const CHOICE_GRID = [0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99].flatMap(conf => [0.1, 0.2, 0.3, 0.4, 0.5].map(margin => ({ conf, margin })));
export const NOUL_GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99].map(noul => ({ noul }));
export const LABEL_GRID = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99].flatMap(same => [0.4, 0.3, 0.2, 0.15, 0.1, 0.05, 0.03, 0.01].map(different => ({ same, different })));

/** The chosen option's probability minus the best other option's (0 when there is none); null without probabilities for it.
 * Same arithmetic as the modules: top - second when the choice is top, and below any positive margin when it is not. */
export function choiceLead(answer) {
  const p = answer?.probabilities;
  if (!p || typeof p[answer.choice] !== 'number') return null;
  return p[answer.choice] - Math.max(0, ...Object.entries(p).filter(([key]) => key !== answer.choice).map(([, value]) => value));
}

const passes = (role, t) => role.value !== null && (role.confidence ?? 0) >= t.conf && role.lead !== null && role.lead >= t.margin;

/** What the module would accept at thresholds `t`, or null (fallback: no hint, Bud asked, thread kept). */
export function accept(record, t) {
  if (!record.answered) return null;
  if (record.kind === 'noul') return record.noul >= t.noul ? true : null;
  if (record.kind === 'label') return record.noul >= t.same ? 'same' : record.noul <= t.different ? 'different' : null;
  if (record.kind === 'choice') return record.allowed !== false && passes(record, t) ? record.value : null;
  const values = ROLES.map(role => record.roles[role]);
  if (!values.every(role => role && passes(role, t)) || new Set(values.map(role => role.value)).size !== ROLES.length) return null;
  return Object.fromEntries(ROLES.map((role, n) => [role, values[n].value]));
}

/** The model's own answer, thresholds aside (noul: >= 0.5 reads as noise). */
export function rawAnswer(record) {
  if (record.kind === 'noul') return record.noul >= 0.5;
  if (record.kind === 'label') return record.noul >= 0.5 ? 'same' : 'different';
  if (record.kind === 'choice') return record.value;
  const values = ROLES.map(role => record.roles[role]?.value ?? null);
  return values.every(value => value !== null) ? Object.fromEntries(ROLES.map((role, n) => [role, values[n]])) : null;
}

/** Equal answers: scalars, or role mappings with the same headers. */
export function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}
/** Noise gold is a boolean; only `true` can be accepted, so a not-noise case accepted is wrong. */
const goldValue = record => record.kind === 'noul' ? !!record.gold : record.kind === 'label' ? (record.gold ? 'same' : 'different') : record.gold;

export function summarize(records, t) {
  const n = records.length, answered = records.filter(r => r.answered);
  let accepted = 0, wrongAccepts = 0;
  const wrong = [];
  for (const record of records) {
    const value = accept(record, t);
    if (value === null) continue;
    accepted++;
    if (!same(value, goldValue(record))) { wrongAccepts++; wrong.push(record.id); }
  }
  const rawRight = answered.filter(r => same(rawAnswer(r), goldValue(r))).length;
  return { cases: n, answered: answered.length, errors: n - answered.length, accuracy: answered.length ? rawRight / answered.length : null,
    accepted, correctAccepts: accepted - wrongAccepts, wrongAccepts, wrong, coverage: n ? accepted / n : 0, fallbackRate: n ? (n - accepted) / n : 0 };
}

/** Lexicographically stricter thresholds (first key, then the next); higher is stricter except `different` (a noul ceiling). */
const stricter = (a, b) => { for (const key of Object.keys(a)) if (a[key] !== b[key]) return key === 'different' ? a[key] < b[key] : a[key] > b[key]; return false; };

/** Over the grid: the setting with the most coverage whose wrong-accepts stay within `cap(cases)`; ties go to the stricter setting. */
export function best(records, grid, cap) {
  let top = null;
  for (const t of grid) {
    const s = summarize(records, t);
    if (s.wrongAccepts > cap(s.cases)) continue;
    if (!top || s.coverage > top.coverage || s.coverage === top.coverage && stricter(t, top.thresholds)) top = { thresholds: t, ...s };
  }
  return top;
}

export function sweep(records, grid, current) {
  return {
    current: { thresholds: current, ...summarize(records, current) },
    zeroWrong: best(records, grid, () => 0),
    // ≤ 1% of the cases (0 below 100 cases).
    onePercent: best(records, grid, cases => Math.floor(cases * 0.01)),
  };
}

/** Nearest-rank percentile of numbers; null when empty. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}
