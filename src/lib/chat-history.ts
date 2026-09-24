import type { Message } from '@/state/store';

export const CHAT_HISTORY_PAGE = 200;
export interface ChatHistoryWindow { threadId: string; leafId: string | null; length: number; count: number }

/** A new tail is an append only if the old tail remains in this active branch.
 * A task change or a fork selects its own recent page, never another task's
 * expanded range. This changes presentation only, not the source transcript. */
export function chatHistoryWindow(previous: ChatHistoryWindow | null, threadId: string, messages: readonly Message[], readingEarlier = false): ChatHistoryWindow {
  const leafId = messages.at(-1)?.id ?? null;
  if (previous?.threadId === threadId && previous.leafId === leafId && previous.length === messages.length) return previous;
  const sameBranch = previous?.threadId === threadId && (previous.leafId === null || messages.some(message => message.id === previous.leafId));
  const appended = sameBranch && previous?.leafId ? Math.max(0, messages.length - previous.length) : 0;
  return { threadId, leafId, length: messages.length,
    count: sameBranch && previous ? previous.count + (readingEarlier || previous.count > CHAT_HISTORY_PAGE ? appended : 0) : CHAT_HISTORY_PAGE };
}

export function retainChatDecision(message: Message): boolean {
  return message.kind === 'options' && !!message.card && !message.card.answered && !message.card.dismissed ||
    message.kind === 'activity' && !!message.tool?.name.startsWith('error:');
}

export function pageChatHistory(messages: readonly Message[], count: number, retainedIds: ReadonlySet<string> = new Set()): { messages: Message[]; hidden: number } {
  const start = Math.max(0, messages.length - Math.max(CHAT_HISTORY_PAGE, count));
  const shown = messages.filter((message, index) => index >= start || retainedIds.has(message.id) || retainChatDecision(message));
  return { messages: shown, hidden: messages.length - shown.length };
}

export interface ChatMessageVersions { versions: Message[]; index: number }
/** Share each sorted sibling group. Per-message rendering is now a lookup,
 * including old flat transcripts whose user requests all share a null parent. */
export function indexChatMessageVersions(messages: readonly Message[]): Map<string, ChatMessageVersions> {
  const groups = new Map<string | null, Message[]>();
  for (const message of messages) {
    if (message.role !== 'user' || message.kind !== 'text') continue;
    const parent = message.parentId ?? null;
    const group = groups.get(parent);
    if (group) group.push(message); else groups.set(parent, [message]);
  }
  const result = new Map<string, ChatMessageVersions>();
  for (const versions of groups.values()) {
    versions.sort((a, b) => a.at - b.at);
    versions.forEach((message, index) => result.set(message.id, { versions, index }));
  }
  return result;
}
