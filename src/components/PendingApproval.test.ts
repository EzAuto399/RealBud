import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Message } from '@/state/store';
import { HERMES_MEMORY_APPROVAL, type MemoryApprovalReview } from '@shared/approval-policy';
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals, type Pending } from './PendingApproval';

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: { desk: { properties: [] } }, dispatch: fixture.dispatch }) }));
const review: MemoryApprovalReview = { description: 'Save to memory: add to memory', content: 'git is our preferred change tracker', complete: true };
const bot = (id = 'bud'): Bot => ({ id, name: id === 'bud' ? 'Bud' : 'Other worker' } as Bot);
const pending = (extra: Partial<Pending> = {}): Pending => ({ message: { id: 'memory-message', role: 'bot', kind: 'options', at: 1 },
  requestId: 'request-memory', tool: HERMES_MEMORY_APPROVAL, detail: 'Native memory change', approvalPolicy: 'once', memoryReview: review, ...extra });
const renderPanel = (value: Pending) => renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: value, count: 1, index: 0, productAsk: true }));
const props = (value: Pending, productAsk = true, worker = bot()) => ({ pending: value, threadId: 'thread-1', bot: worker, productAsk, onCancelTurn: vi.fn() });
const renderActions = (value: Pending, productAsk = true, worker = bot()) => renderToStaticMarkup(createElement(PendingApprovalActions, props(value, productAsk, worker)));
function buttons(node: ReactNode): { text: string; disabled?: boolean; onClick: () => void }[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement(child)) return [];
    const childProps = child.props as { children?: ReactNode; disabled?: boolean; onClick: () => void };
    return child.type === 'button' ? [{ text: Children.toArray(childProps.children).join(''), disabled: childProps.disabled, onClick: childProps.onClick }] : buttons(childProps.children);
  });
}
beforeEach(() => fixture.dispatch.mockClear());

describe('native memory permission review', () => {
  it('carries the explicit policy and full review from the server card', () => {
    const message: Message = { id: 'm', role: 'bot', kind: 'options', at: 1, card: { title: 'Memory change', subtitle: 'Short operation label', options: ['Allow', 'Deny'], requestId: 'r', tool: HERMES_MEMORY_APPROVAL, approvalPolicy: 'once', memoryReview: review } };
    expect(pendingApprovals([message])[0]).toMatchObject({ approvalPolicy: 'once', memoryReview: review, detail: 'Short operation label' });
    expect(pendingApprovals([{ ...message, card: { ...message.card!, answered: 'Deny' } }])).toEqual([]);
  });
  it('renders complete literal contents beyond the summary limit with keyboard scroll access', () => {
    const content = 'git is our preferred change tracker\n' + 'Retain this exact memory line.\n'.repeat(80) + '<script>Never execute this text</script>\nFINAL MEMORY LINE';
    const html = renderPanel(pending({ detail: 'Misleading short shell summary', memoryReview: { ...review, content } }));
    expect(html).toContain('Review a memory change'); expect(html).toContain('future conversations');
    expect(html).toContain('Save to memory: add to memory'); expect(html).toContain('FINAL MEMORY LINE');
    expect(html).toContain('&lt;script&gt;Never execute this text&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('aria-label="Complete proposed memory change"'); expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('Misleading short shell summary'); expect(html).not.toContain('Running a command');
  });
  it.each([true, false])('offers only one-time memory approval for productAsk=%s even with a forged reusable grant', productAsk => {
    const value = pending({ approvalPolicy: undefined, allowKey: 'Bash:git', fence: { surface: 'portal-submit', origin: 'https://example.test', ruleOffer: { surface: 'portal-read', origin: 'https://example.test', label: 'Read this site' } } });
    const html = renderActions(value, productAsk, bot(productAsk ? 'bud' : 'other'));
    expect(html).toContain('Allow this memory change once'); expect(html).toContain('Deny'); expect(html).toContain('Stop this turn');
    expect(html).not.toContain('Allow for this task'); expect(html).not.toContain('Always allow'); expect(html).not.toContain('standing rule'); expect(html).not.toContain('Allow this Submit');
  });
  it.each(['Save to memory: add to memory', 'Save to memory: add to user profile'])('allows the complete native single-add request: %s', description => {
    const value = pending({ memoryReview: { ...review, description } });
    expect(renderPanel(value)).toContain(description);
    const allow = buttons(PendingApprovalActions(props(value))).find(button => button.text === 'Allow this memory change once')!;
    expect(allow.disabled).toBe(false); allow.onClick();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow', scope: 'once', rule: undefined, alwaysAllow: undefined }));
  });
  it.each(['replace in memory', 'replace in user profile', 'remove from memory', 'remove from user profile', 'apply 2 op(s) to memory', 'apply 12 op(s) to user profile'])('holds native %s even when the card incorrectly claims completeness', operation => {
    const value = pending({ memoryReview: { description: `Save to memory: ${operation}`, content: 'short matching substring', complete: true } });
    expect(renderPanel(value)).toContain('The complete memory change is unavailable');
    const allow = buttons(PendingApprovalActions(props(value))).find(button => button.text === 'Allow this memory change once')!;
    expect(allow.disabled).toBe(true); allow.onClick(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('dispatches an exact one-time memory decision without a reusable rule', () => {
    const value = pending({ allowKey: 'Bash:git' });
    buttons(PendingApprovalActions(props(value))).find(button => button.text === 'Allow this memory change once')!.onClick();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'decideRequest', threadId: 'thread-1', requestId: 'request-memory', behavior: 'allow', message: undefined, scope: 'once', rule: undefined, alwaysAllow: undefined });
  });
  it.each([
    { name: 'missing review', malformed: undefined }, { name: 'incomplete review', malformed: { ...review, complete: false } },
    { name: 'empty content', malformed: { ...review, content: '' } }, { name: 'oversized UTF-8 content', malformed: { ...review, content: '界'.repeat(22_000) } },
    { name: 'nontext content', malformed: { ...review, content: 12 } }, { name: 'oversized description', malformed: { ...review, description: 'x'.repeat(1025) } },
  ])('holds $name instead of approving its summary', ({ malformed }) => {
    const value = pending({ memoryReview: malformed as MemoryApprovalReview | undefined, detail: 'git is our preferred change tracker' });
    expect(renderPanel(value)).toContain('The complete memory change is unavailable');
    const options = props(value), rendered = buttons(PendingApprovalActions(options));
    const allow = rendered.find(button => button.text === 'Allow this memory change once')!;
    expect(allow.disabled).toBe(true); allow.onClick(); expect(fixture.dispatch).not.toHaveBeenCalled();
    rendered.find(button => button.text === 'Deny')!.onClick(); expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'deny' }));
    rendered.find(button => button.text === 'Stop this turn')!.onClick(); expect(options.onCancelTurn).toHaveBeenCalledOnce();
  });
  it.each(['once', 'provider-once'] as const)('suppresses reusable permissions for an unrefined %s policy', approvalPolicy => {
    const offeredFence: Pending['fence'] = { surface: 'portal-read', origin: 'https://example.test', ruleOffer: { surface: 'portal-read', origin: 'https://example.test', label: 'Read this site' } };
    for (const fence of [undefined, offeredFence]) {
      const value = pending({ tool: 'browser', approvalPolicy, memoryReview: undefined, allowKey: 'Bash:git', fence });
      for (const productAsk of [true, false]) {
        const worker = bot(productAsk ? 'bud' : 'other');
        const html = renderActions(value, productAsk, worker);
        expect(html).toContain('Allow once'); expect(html).not.toContain('disabled=""');
        expect(html).not.toContain('Allow for this task'); expect(html).not.toContain('Always allow'); expect(html).not.toContain('standing rule');
        buttons(PendingApprovalActions(props(value, productAsk, worker))).find(button => button.text === 'Allow once')!.onClick();
        expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'allow', scope: 'once', rule: undefined, alwaysAllow: undefined }));
      }
    }
  });
  it('preserves existing ordinary-command permission controls', () => {
    const value = pending({ tool: 'shell', approvalPolicy: undefined, memoryReview: undefined, allowKey: 'Bash:git' });
    expect(renderActions(value)).toContain('Allow for this task');
    expect(renderActions(value, false, bot('other'))).toContain('Always allow');
  });
});
