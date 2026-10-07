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

  it('shows staff one pack path: no owner tools, Phase 1 or snapshots outside the collapsed owner section, and no built-in role packs inside it', () => {
    const html = renderToStaticMarkup(createElement(WorkflowPacksCard, {}));
    const more = html.indexOf('<details class="border-t border-line pt-3">');
    const staff = html.slice(0, more), owner = html.slice(more);
    expect(staff).toContain('aria-label="Packs from your office"');
    expect(staff).not.toMatch(/Phase 1|snapshot|aria-label="Agency workflow setup"|Company workflow templates|department starter|office core|Earlier Auston/i);
    expect(owner).not.toMatch(/Role packs built into RealBud|Preview built-in/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).not.toContain('Austin');
  });

  it('puts Agency workflow setup first, once, when Get started sends a workflow there', () => {
    const html = renderToStaticMarkup(createElement(WorkflowPacksCard, { agencyFirst: true }));
    expect(html.match(/aria-label="Agency workflow setup"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Agency workflow setup"')).toBeLessThan(html.indexOf('aria-label="Packs from your office"'));
  });
});
