import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Message } from '@/state/store';
import { HERMES_MEMORY_APPROVAL, type MemoryApprovalReview } from '@shared/approval-policy';
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals, scriptNetworkNote, spokenApproval, waitingLine, type Pending } from './PendingApproval';
import { BROWSER_ACCOUNT_CONFIRM_TOOL } from '@shared/browser-task';

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

describe('the account a browser task works in', () => {
  it('asks in plain words, answered Continue in this account or Stop, with nothing standing', () => {
    const account = pending({ tool: BROWSER_ACCOUNT_CONFIRM_TOOL, memoryReview: undefined, approvalPolicy: 'once',
      detail: 'Signed in to rei-mock.fictional.test as FICT1. Continue in this account? Bud remembers it, and asks again if a later task finds a different account.',
      fence: { surface: 'portal-read', origin: 'rei-mock.fictional.test', ruleOffer: null } });
    const panel = renderPanel(account);
    expect(panel).toContain('Check the account');
    expect(panel).toContain('Signed in to rei-mock.fictional.test as FICT1. Continue in this account?');
    expect(panel).not.toContain('Allow once approves this request only');
    const rendered = buttons(PendingApprovalActions(props(account)));
    expect(rendered.map(button => button.text)).toEqual(['Continue in this account', 'Stop', 'Stop this turn']);
    rendered[0]!.onClick(); expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow', scope: 'once' }));
    rendered[1]!.onClick(); expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'deny' }));
  });
});

// Security review of b7fceb50 (sensitive-data-exposure): speech is made off this computer, and a browser step's card
// can show the record it acts on, so a call announces such an approval without its details.
describe('an approval read aloud on a call', () => {
  it('names no page, record or detail for a fenced or browser approval', () => {
    const detail = 'Open portal.example/owners/jane.doe@example.com/OWN-2026-000048213/statement in this job\'s borrowed tab.';
    const fence = { surface: 'portal-read' as const, origin: 'portal.example', ruleOffer: null };
    for (const extra of [{ fence }, { browserApproval: null }]) {
      const spoken = spokenApproval(pending({ tool: 'browser_navigate', detail, ...extra }), 'Bud');
      expect(spoken).toBe('Approval needed in RealBud. Check the card on your screen, then say allow or deny.');
    }
    expect(spokenApproval(pending({ tool: 'Bash', detail: 'git status', approvalPolicy: undefined, memoryReview: undefined }), 'Bud')).toBe('Bud wants to Bash. git status. Should I allow it?');
  });
});

describe('approval settings on the card', () => {
  const exact = '{\n  "name": "GMAIL_FETCH_EMAILS",\n  "arguments": {\n    "query": "rent"\n  }\n}';
  const appCard = (card: Record<string, unknown>): Message => ({ id: 'app-message', role: 'bot', kind: 'options', at: 1, card: { title: 'Approval needed',
    subtitle: 'Bud wants to use Gmail.\nAccount: the account connected in Connected apps\nAction: Fetch emails (GMAIL_FETCH_EMAILS)\n  Query: rent', detail: exact,
    options: ['Allow', 'Deny'], requestId: 'request-app', tool: 'bud_connected_app_action', ...card } as Message['card'] });
  it('offers once, this task and always-reads on an eligible read, each sending its scope', () => {
    const value = pendingApprovals([appCard({ readOffer: { appLabel: 'Gmail', always: true, group: 'app:gmail' } })])[0]!;
    expect(value.readOffer).toEqual({ appLabel: 'Gmail', always: true });
    const rendered = buttons(PendingApprovalActions(props(value)));
    expect(rendered.map(button => button.text)).toEqual(['Allow once', 'Allow for this task', 'Always allow reading Gmail', 'Deny', 'Stop this turn']);
    for (const [index, scope] of [[0, 'once'], [1, 'task'], [2, 'always-reads']] as const) {
      rendered[index]!.onClick();
      expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'allow', scope, rule: undefined, alwaysAllow: undefined }));
    }
    expect(renderActions(value)).toContain('Change future approvals in Workspace → Approvals.');
    // Without `always` (not an editor, or not eligible) there is no standing offer.
    const once = pendingApprovals([appCard({ readOffer: { appLabel: 'Google Calendar', always: false, group: 'app:googlecalendar' } })])[0]!;
    expect(buttons(PendingApprovalActions(props(once))).map(button => button.text)).toEqual(['Allow once', 'Allow for this task', 'Deny', 'Stop this turn']);
  });
  it('ignores a malformed offer and never offers it on a once-only card', () => {
    for (const readOffer of [{ appLabel: 42 }, { app: 'gmail', always: true }, { label: 'Gmail', always: true }, 'Gmail']) {
      expect(pendingApprovals([appCard({ readOffer })])[0]!.readOffer, JSON.stringify(readOffer)).toBeUndefined();
    }
    const value = pending({ tool: 'bud_connected_app_action', approvalPolicy: 'once', memoryReview: undefined, readOffer: { appLabel: 'Gmail', always: true } });
    expect(renderActions(value)).not.toContain('Always allow reading');
  });
  it('points the site-rule footnote at Workspace → Approvals', () => {
    const value = pending({ tool: 'browser', approvalPolicy: undefined, memoryReview: undefined,
      fence: { surface: 'portal-read', origin: 'portal.fictional.test', ruleOffer: { surface: 'portal-read', origin: 'portal.fictional.test', label: 'portal.fictional.test' } } });
    const html = renderActions(value);
    expect(html).toContain('Change future approvals in Workspace → Approvals.');
    expect(html).not.toContain('Settings &amp; help');
  });
  it('collapses a card answered elsewhere to who answered it, with nothing left to press', () => {
    const at = Date.parse('2026-10-08T05:16:00Z');
    const value = pendingApprovals([appCard({ answeredBy: { name: 'Fictional Sam', via: 'telegram', at } })])[0]!;
    expect(renderPanel(value)).toMatch(/Allowed once by Fictional Sam via Telegram · \d{1,2}:16/);
    expect(renderActions(value)).toBe('');
    expect(pendingApprovals([appCard({ answeredBy: { name: 'Fictional Sam', via: 'pager' } })])[0]!.answeredBy).toBeUndefined();
  });
  it('shows the phone note as one muted line under the buttons, never as a hold', () => {
    for (const card of [{ readOffer: { appLabel: 'Gmail', always: false, group: 'app:gmail' } }, {}]) {
      const value = pendingApprovals([appCard({ ...card, phoneNote: 'Also on Telegram' })])[0]!;
      expect(value.phoneNote).toBe('Also on Telegram');
      const html = renderActions(value);
      expect(html).toMatch(/<\/button><\/div>(<p[^>]*>Change future approvals in Workspace → Approvals\.<\/p>)?<p class="text-\[12px\] text-ink-muted">Also on Telegram<\/p><\/div>$/);
      expect(renderPanel(value)).not.toContain('Also on Telegram');
    }
    // A real hold still shows in the card's hold style; no note, no line.
    const held = pendingApprovals([appCard({ held: 'This request needs your approval once. Saved rules do not apply.' })])[0]!;
    expect(renderPanel(held)).toContain('<div class="mt-2 text-[12px] text-hold">This request needs your approval once. Saved rules do not apply.</div>');
    expect(renderActions(held)).not.toContain('Also on');
    expect(pendingApprovals([appCard({ phoneNote: 42 })])[0]!.phoneNote).toBeUndefined();
  });
  it('shows plain lines first and the exact request collapsed under "Exact request"', () => {
    const value = pendingApprovals([appCard({})])[0]!;
    expect(value.exactRequest).toBe(exact);
    const html = renderPanel(value);
    expect(html.indexOf('Action: Fetch emails (GMAIL_FETCH_EMAILS)')).toBeLessThan(html.indexOf('<details'));
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Exact request<\/summary><pre[^>]*aria-label="Exact request"[^>]*>\{\n {2}&quot;name&quot;: &quot;GMAIL_FETCH_EMAILS&quot;/);
    expect(html).not.toContain('<details open');
    // A card without one shows no disclosure.
    expect(renderPanel(pendingApprovals([appCard({ detail: undefined })])[0]!)).not.toContain('Exact request');
  });
  it('names the app, action and time left for the side panel', () => {
    const now = Date.parse('2026-10-08T05:00:00Z');
    const value = pendingApprovals([appCard({ deadline: '2026-10-08T05:01:30Z' })])[0]!;
    expect(waitingLine(value, now)).toBe('Gmail · Fetch emails · 2 min left');
    expect(waitingLine(value, Date.parse('2026-10-08T05:01:00Z'))).toBe('Gmail · Fetch emails · under 1 min left');
    expect(waitingLine(pending({ tool: 'shell', detail: 'git status', approvalPolicy: undefined, memoryReview: undefined }), now)).not.toContain('left');
  });
});

describe('a script card on Windows', () => {
  it('says scripts can reach the internet on Windows only, and only for commands and scripts', () => {
    for (const tool of ['shell', 'Bash', 'terminal', 'execute_code']) expect(scriptNetworkNote(tool, 'win32')).toBe('On Windows, scripts Bud runs can reach the internet.');
    expect(scriptNetworkNote('shell', 'darwin')).toBeNull();
    expect(scriptNetworkNote('shell', undefined)).toBeNull();
    expect(scriptNetworkNote('read_page', 'win32')).toBeNull();
    expect(scriptNetworkNote(HERMES_MEMORY_APPROVAL, 'win32')).toBeNull();
  });
  it('renders the line on a Windows command card', () => {
    vi.stubGlobal('window', { ogb: { platform: 'win32' } });
    try {
      const html = renderPanel(pending({ tool: 'shell', detail: 'python3 totals.py', approvalPolicy: undefined, memoryReview: undefined }));
      expect(html).toContain('On Windows, scripts Bud runs can reach the internet.');
    } finally { vi.unstubAllGlobals(); }
    expect(renderPanel(pending({ tool: 'shell', detail: 'python3 totals.py', approvalPolicy: undefined, memoryReview: undefined }))).not.toContain('reach the internet');
  });
});
