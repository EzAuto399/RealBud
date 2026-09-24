import assert from 'node:assert/strict';

// Only for disposable fictional QA workspaces. This seeds a fixture; it is not
// evidence that a person completed the visible welcome screens.
export async function completeFictionalOnboarding(request) {
  let state = await request('/api/onboarding');
  assert.match(state.scope, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(state.revision));
  const scope = state.scope;
  for (const stage of ['office-rules', 'complete']) {
    if (state.stage === 'complete') break;
    const previousRevision = state.revision;
    const expectedRevision = previousRevision + (state.stage === stage ? 0 : 1);
    state = await request('/api/onboarding', 'PUT', {
      expectedScope: scope,
      expectedRevision: previousRevision,
      stage,
    });
    assert.equal(state.scope, scope);
    assert.equal(state.stage, stage);
    assert.equal(state.revision, expectedRevision);
  }
  assert.equal(state.stage, 'complete');
  assert.deepEqual(await request('/api/onboarding'), state);
  return state;
}
