import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NotNoiseButton, sendNotNoise } from './MailWorkPanel';
import type { MailWorkItem } from '@shared/mail-ingestion';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn() }) }));
vi.mock('@/lib/workspace-tabs', () => ({ useWorkspaceTabs: () => ({ data: null }) }));

const item = (over: Partial<MailWorkItem> = {}): MailWorkItem => ({ id: 'm1', revision: 7, accountId: 'a', threadId: 't', subject: 'Fictional newsletter', sourceMessageIds: [], sourceDigest: 'd',
  sourceReceiptId: 'scan-1', disposition: 'noise', priority: 'low', owner: '', reason: 'Likely a newsletter or automated mail.', nextAction: 'No action needed', missingFacts: [], status: 'open',
  snoozedUntil: null, note: '', reviewed: false, newEvidence: false, firstSeenAt: 1, updatedAt: 1, lastMessageAt: 1, screenedBy: 'jev', ...over });
const button = (value: MailWorkItem) => renderToStaticMarkup(createElement(NotNoiseButton, { item: value, disabled: false, onClick: () => undefined }));

describe('MailWorkPanel Not noise', () => {
  it('shows Not noise only on open screened conversations', () => {
    expect(button(item())).toContain('aria-label="Not noise: Fictional newsletter"');
    expect(button(item({ screenedBy: undefined }))).toBe('');
    expect(button(item({ disposition: 'reference', screenedBy: undefined }))).toBe('');
    expect(button(item({ status: 'done' }))).toBe('');
  });

  it('sends the item revision with notNoise, then rereads the saved list', async () => {
    const request = vi.fn().mockResolvedValue({}), refresh = vi.fn().mockResolvedValue({});
    await sendNotNoise(request, item(), refresh);
    expect(request).toHaveBeenCalledWith('/api/mail-workspace/items/m1', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 7, notNoise: true }) });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  });

  it('a conflict refreshes the list and says it changed elsewhere', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('This conversation changed. Refresh it before saving.'), { status: 409 })), refresh = vi.fn().mockResolvedValue({});
    await expect(sendNotNoise(request, item(), refresh)).rejects.toThrow('This conversation changed elsewhere. The list was refreshed; check it again.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('other failures keep their own message and still reread the saved state', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Network down')), refresh = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(sendNotNoise(request, item(), refresh)).rejects.toThrow('Network down');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
