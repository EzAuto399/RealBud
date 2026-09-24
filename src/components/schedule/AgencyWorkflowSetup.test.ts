import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { AgencyWorkflowSetup } from './AgencyWorkflowSetup';

describe('agency workflow setup steps', () => {
  const html = () => renderToStaticMarkup(createElement(AgencyWorkflowSetup, {}));

  it('numbers its tabs as the three steps of the one workspace setup path', () => {
    const markup = html();
    expect(markup).toContain('1. Agency details');
    expect(markup).toContain('2. Connect your accounts');
    // Property references and the workflow review are two tabs of one step.
    expect(markup).toContain('3. Property references');
    expect(markup).toContain('3. Review workflows');
    // The old seven-step numbering must not reappear beside a step name.
    expect(markup).not.toContain('3. Agency details');
    expect(markup).not.toContain('4. Private Gmail source');
    expect(markup).not.toContain('2. Private Gmail source');
    expect(markup).not.toContain('6. Review workflows');
  });

  it('says how the three steps run without claiming a schedule', () => {
    const markup = html();
    expect(markup).toContain('All three workspace setup steps happen here');
    expect(markup).toContain('turning the schedule on as a separate decision');
    expect(markup).toContain('aria-label="Agency setup steps"');
  });
});
