import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedHermesSnapshot, observedFixtureRef } from './hermes-browser-observation.mjs';

test('uses the textbox reference when its visible label precedes it', () => {
  const text = normalizedHermesSnapshot('- form\n  - LabelText\n    - StaticText "Search"\n    - textbox "Search" [ref=e9]');
  assert.equal(observedFixtureRef(text, 'Search'), '@e9');
  assert.match(text, /    @e9 textbox/);
});
test('preserves role, state and value when ref is not the first attribute', () => {
  const text = normalizedHermesSnapshot('- combobox "Status" [expanded=false, ref=e8]: Active\n  - option "Active" [selected, ref=e10]');
  assert.equal(observedFixtureRef(text, 'Status'), '@e8');
  assert.match(text, /expanded=false/); assert.match(text, /: Active/); assert.match(text, /  @e10 option "Active" \[selected/);
});
test('rejects absent and ambiguous controls rather than guessing', () => {
  assert.throws(() => observedFixtureRef('- StaticText "Search"', 'Search'), /found 0/);
  assert.throws(() => observedFixtureRef('@e1 button "Search"\n@e2 button "Search"', 'Search'), /found 2/);
});
test('does not confuse an exact control name with another name or value', () => {
  assert.equal(observedFixtureRef('@e1 textbox "Search"\n@e2 button "Search records"\n@e3 textbox "Notes": "Search"', 'Search'), '@e1');
});
