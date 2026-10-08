import assert from 'node:assert/strict';
import test from 'node:test';
import { accept, best, choiceLead, summarize, sweep, CHOICE_GRID, LABEL_GRID, NOUL_GRID } from './eval-jev-grade.mjs';

const choice = (id, gold, value, confidence, lead, extra = {}) => ({ kind: 'choice', id, gold, answered: true, value, confidence, lead, allowed: true, ...extra });
const noul = (id, gold, p) => ({ kind: 'noul', id, gold, answered: true, noul: p });
const T = { conf: 0.9, margin: 0.3 };

test('choiceLead matches the modules: top minus the best other, null without the chosen probability', () => {
  assert.equal(choiceLead({ choice: 't2', probabilities: { t1: 0.03, t2: 0.95, none: 0.02 } }), 0.95 - 0.03);
  assert.equal(choiceLead({ choice: 'c0', probabilities: { c0: 0.9 } }), 0.9);
  assert.ok(choiceLead({ choice: 't1', probabilities: { t1: 0.4, t2: 0.6 } }) < 0);
  assert.equal(choiceLead({ choice: 't1' }), null);
  assert.equal(choiceLead({ choice: 't1', probabilities: { t2: 0.9 } }), null);
});

test('wrong-accepts: accepted but wrong, including a pick where the label is none; none and fallbacks never count', () => {
  const records = [
    choice('right', 'P-A', 'P-A', 0.95, 0.6),
    choice('wrong-tenant', 'P-A', 'P-B', 0.96, 0.5),
    choice('pick-on-none', null, 'P-C', 0.97, 0.7),
    choice('says-none', null, null, 0.99, 0.9),
    choice('unsure-wrong', 'P-A', 'P-B', 0.7, 0.1),
    choice('guarded', null, 'Notice', 0.99, 0.9, { allowed: false }),
    { kind: 'choice', id: 'failed', gold: 'P-A', answered: false, value: null, confidence: null, lead: null },
    noul('noise', true, 0.99), noul('urgent-repair', false, 0.98), noul('kept', false, 0.2),
  ];
  const s = summarize(records, { ...T, noul: 0.97 });
  assert.deepEqual(s.wrong, ['wrong-tenant', 'pick-on-none', 'urgent-repair']);
  assert.equal(s.wrongAccepts, 3);
  assert.equal(s.accepted, 5);
  assert.equal(s.correctAccepts, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.coverage, 5 / 10);
  assert.equal(s.fallbackRate, 5 / 10);
  // Raw accuracy ignores thresholds and the guard, and counts a correct none: right, says-none, noise, kept.
  assert.equal(s.accuracy, 4 / 9);
});

test('a mapping is all four roles, each sure, on four different headers', () => {
  const role = (value, confidence = 0.95, lead = 0.5) => ({ value, confidence, lead });
  const roles = { identity: role('Property'), daysSinceDue: role('Days'), rentLanded: role('Rent'), levyPaid: role('Levy') };
  const gold = { identity: 'Property', daysSinceDue: 'Days', rentLanded: 'Rent', levyPaid: 'Levy' };
  const mapping = (r, g = gold) => ({ kind: 'mapping', id: 'm', gold: g, answered: true, roles: r });
  assert.deepEqual(accept(mapping(roles), T), gold);
  assert.equal(accept(mapping({ ...roles, levyPaid: role(null) }), T), null);
  assert.equal(accept(mapping({ ...roles, levyPaid: role('Levy', 0.85) }), T), null);
  assert.equal(accept(mapping({ ...roles, levyPaid: role('Rent') }), T), null);
  // A full mapping on a file whose label is "no mapping" is a wrong-accept.
  assert.equal(summarize([mapping(roles, null)], T).wrongAccepts, 1);
});

test('the sweep picks the most coverage with zero wrong-accepts, ties to the stricter setting', () => {
  const records = [
    choice('a', 'x', 'x', 0.99, 0.6), choice('b', 'x', 'x', 0.98, 0.45), choice('c', 'x', 'x', 0.97, 0.35),
    choice('wrong', 'x', 'y', 0.96, 0.4), choice('d', 'x', 'x', 0.85, 0.2),
  ];
  const result = sweep(records, CHOICE_GRID, T);
  assert.equal(result.current.wrongAccepts, 1);
  // conf 0.97 drops the wrong pick and keeps a, b, c at margin ≤ 0.3; 0.3 is the strictest margin that keeps all three.
  assert.deepEqual(result.zeroWrong.thresholds, { conf: 0.97, margin: 0.3 });
  assert.equal(result.zeroWrong.coverage, 3 / 5);
  assert.equal(result.zeroWrong.wrongAccepts, 0);
  // Margin alone is the worse lever here: at 0.5 only a survives.
  assert.equal(summarize(records, { conf: 0.9, margin: 0.5 }).coverage, 1 / 5);
  // Nothing safe to accept: the strictest grid point, at zero coverage; a wrong pick surer than the whole grid leaves none.
  assert.deepEqual(best([choice('w', 'x', 'y', 0.95, 0.9), choice('n', null, null, 0.99, 0.9)], CHOICE_GRID, () => 0).thresholds, { conf: 0.99, margin: 0.5 });
  assert.equal(best([choice('w', 'x', 'y', 0.995, 0.9)], CHOICE_GRID, () => 0), null);
  // Noise: the lowest threshold above every confidently wrong noul.
  const mail = [noul('n1', true, 0.99), noul('n2', true, 0.975), noul('repair', false, 0.955), noul('n3', true, 0.6)];
  assert.deepEqual(best(mail, NOUL_GRID, () => 0).thresholds, { noul: 0.97 });
  // One wrong allowed: everything, at the strictest threshold that still takes n3 (0.6).
  assert.deepEqual(best(mail, NOUL_GRID, () => 1).thresholds, { noul: 0.6 });
});

test('duplicate-bill labels: "same" on a different bill and "different" on the same bill are both wrong-accepts', () => {
  const label = (id, gold, p) => ({ kind: 'label', id, gold, answered: true, noul: p });
  const records = [label('dup', true, 0.95), label('repeat-charge', false, 0.92), label('other', false, 0.04), label('missed-dup', true, 0.08), label('unsure', true, 0.5)];
  const t = { same: 0.9, different: 0.1 };
  assert.equal(accept(records[0], t), 'same'); assert.equal(accept(records[2], t), 'different'); assert.equal(accept(records[4], t), null);
  const s = summarize(records, t);
  assert.deepEqual(s.wrong, ['repeat-charge', 'missed-dup']);
  assert.equal(s.accepted, 4);
  // Zero wrong: "same" above 0.92 and "different" below 0.08; ties go to the higher same and the lower different.
  assert.deepEqual(best(records, LABEL_GRID, () => 0).thresholds, { same: 0.95, different: 0.05 });
});
