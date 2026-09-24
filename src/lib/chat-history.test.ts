import { describe, expect, it } from 'vitest';
import type { Message } from '@/state/store';
import { CHAT_HISTORY_PAGE, chatHistoryWindow, indexChatMessageVersions, pageChatHistory } from './chat-history';

const history = (length: number): Message[] => Array.from({ length }, (_, index) => ({
  id: `message-${index}`, role: index % 2 ? 'bot' : 'user', kind: 'text', at: index,
  text: `Fictional message ${index}`, parentId: index ? `message-${index - 1}` : null,
}));

describe('chat history pages', () => {
  it('renders a recent page without removing or changing any source messages', () => {
    const messages = history(10_000), before = JSON.stringify(messages);
    const page = pageChatHistory(messages, CHAT_HISTORY_PAGE);
    expect(page.messages).toEqual(messages.slice(-200));
    expect(page.hidden).toBe(9800);
    expect(JSON.stringify(messages)).toBe(before);
  });
  it('progressively exposes every earlier message exactly once', () => {
    const messages = history(501);
    expect(pageChatHistory(messages, 400).messages[0].id).toBe('message-101');
    const all = pageChatHistory(messages, 600);
    expect(all.messages).toEqual(messages); expect(all.hidden).toBe(0);
  });
  it('never hides unanswered decisions or errors, while old settled decisions can page out', () => {
    const messages = history(1000);
    messages[0] = { ...messages[0], kind: 'options', card: { title: 'Fictional approval', subtitle: '', options: ['Allow', 'Deny'], requestId: 'pending', tool: 'browser' } };
    messages[1] = { ...messages[0], id: 'answered', card: { ...messages[0].card!, answered: 'Deny' } };
    messages[2] = { ...messages[0], id: 'dismissed', card: { ...messages[0].card!, dismissed: true } };
    messages[3] = { ...messages[3], kind: 'activity', tool: { name: 'error: fictional failure', ok: false } };
    const page = pageChatHistory(messages, 200);
    expect(page.messages.map(message => message.id)).toEqual([messages[0].id, messages[3].id, ...messages.slice(-200).map(message => message.id)]);
    expect(page.hidden).toBe(798);
  });
  it('retains an old edit/version target and browser decision without revealing the intervening whole history', () => {
    const messages = history(10000);
    const page = pageChatHistory(messages, 200, new Set(['message-2', 'message-4', 'other-branch']));
    expect(page.messages).toHaveLength(202);
    expect(page.messages[0]).toBe(messages[2]); expect(page.messages[1]).toBe(messages[4]);
  });
  it('handles empty and short histories without invented rows', () => {
    expect(pageChatHistory([], 200)).toEqual({ messages: [], hidden: 0 });
    expect(pageChatHistory(history(5), 200).messages).toHaveLength(5);
  });
  it('keeps a bounded recent page when following new messages', () => {
    const initial = chatHistoryWindow(null, 'task-a', history(1000));
    expect(chatHistoryWindow(initial, 'task-a', history(1001)).count).toBe(200);
  });
  it('preserves the oldest revealed row when new messages arrive while reading or after loading earlier', () => {
    const initial = chatHistoryWindow(null, 'task-a', history(1000));
    const reading = chatHistoryWindow(initial, 'task-a', history(1001), true);
    expect(pageChatHistory(history(1001), reading.count).messages[0].id).toBe('message-800');
    const expanded = chatHistoryWindow({ ...initial, count: 400 }, 'task-a', history(1001));
    expect(pageChatHistory(history(1001), expanded.count).messages[0].id).toBe('message-600');
  });
  it('resets a task or divergent/shorter branch without dropping the requested branch focus', () => {
    const expanded = { ...chatHistoryWindow(null, 'task-a', history(1000)), count: 800 };
    expect(chatHistoryWindow(expanded, 'task-b', history(1000)).count).toBe(200);
    expect(chatHistoryWindow(expanded, 'task-a', history(600)).count).toBe(200);
    const branch = [...history(600), { ...history(1)[0], id: 'new-branch', parentId: 'message-599' }];
    const next = chatHistoryWindow(expanded, 'task-a', branch);
    expect(next.count).toBe(200);
    expect(pageChatHistory(branch, next.count, new Set(['message-4'])).messages[0].id).toBe('message-4');
  });
  it('does not expand the page when an initially empty task hydrates', () => {
    const empty = chatHistoryWindow(null, 'task-a', []);
    expect(chatHistoryWindow(empty, 'task-a', history(10_000), true).count).toBe(200);
  });
});

describe('indexed request versions', () => {
  it('keeps sibling versions chronologically ordered and independent of descendants or other parents', () => {
    const messages = history(5);
    const older = { ...messages[2], id: 'old-version', at: -1 };
    const index = indexChatMessageVersions([...messages, older]);
    expect(index.get(messages[2].id)).toEqual({ versions: [older, messages[2]], index: 1 });
    expect(index.get(older.id)).toEqual({ versions: [older, messages[2]], index: 0 });
    expect(index.get(messages[0].id)?.versions).toEqual([messages[0]]);
    expect(index.has(messages[1].id)).toBe(false);
    expect(messages[2].at).toBe(2);
  });
  it('shares one sibling array for legacy null-parent versions instead of rebuilding it per bubble', () => {
    const messages = history(1000).map(message => ({ ...message, parentId: undefined }));
    const index = indexChatMessageVersions(messages);
    expect(index.size).toBe(500);
    expect(index.get('message-0')?.versions).toBe(index.get('message-998')?.versions);
    expect(index.get('message-998')?.index).toBe(499);
  });
});
