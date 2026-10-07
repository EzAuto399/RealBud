import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { WorkflowPacksCard } from './WorkflowPacksCard';

describe('workflow setup drawer', () => {
  it('shows office packs first and folds the agency form, templates and Phase 1 into the one owner section', () => {
    const html = renderToStaticMarkup(createElement(WorkflowPacksCard, {}));
    const more = html.indexOf('More setup options (office owner)');
    expect(html.match(/More setup options \(office owner\)/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Packs from your office"')).toBeLessThan(more);
    for (const owner of ['aria-label="Agency workflow setup"', 'aria-label="Company workflow templates"', 'Auston Phase 1 examples and older pack snapshots', 'Import Auston Phase 1 packs', 'Restore snapshot']) expect(html.indexOf(owner)).toBeGreaterThan(more);
  });

  it('puts Agency workflow setup first, once, when Get started sends a workflow there', () => {
    const html = renderToStaticMarkup(createElement(WorkflowPacksCard, { agencyFirst: true }));
    expect(html.match(/aria-label="Agency workflow setup"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Agency workflow setup"')).toBeLessThan(html.indexOf('aria-label="Packs from your office"'));
  });
});
