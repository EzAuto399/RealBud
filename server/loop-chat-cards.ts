// A settled loop result with something new for the person becomes one card in
// Bud's Ask thread, like a colleague dropping a note. Same rules as the
// desktop notification (src/lib/notify-routine.ts); the delivered set is saved
// so a restart or reconnect never posts the same run twice.
import { join } from 'node:path';
import type { LoopRun } from '../shared/contracts.ts';
import { reiWaitNotice } from '../shared/rei-sign-in-wait.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import type { Message, OptionCardData, Store } from './store.ts';
import { evaluatorForLoop } from '../shared/workflow-catalog.ts';

const SETTLED = ['completed', 'awaiting-approval', 'partial', 'failed', 'missed', 'interrupted'];
const HOLDS = ['failed', 'missed', 'interrupted'];
const KEEP = 200;
export const LOOP_CHAT_THREAD_TITLE = 'Updates from Bud';

export interface LoopChatState { delivered: string[]; holds: Record<string, string> }

/** Pure: whether this run earns a card, and the state to save if it does. */
export function loopChatCardDecision(run: LoopRun, state: LoopChatState): LoopChatState | null {
  // A run waiting at REI sign-in posts while it runs, as a hold (shared/rei-sign-in-wait.ts).
  const rei = reiWaitNotice(run), waiting = rei === 'waiting';
  if (!(evaluatorForLoop(run.loopId)?.notify && SETTLED.includes(run.status) || rei) || run.seenAt || state.delivered.includes(run.id)) return null;
  const hold = waiting || HOLDS.includes(run.status), signature = `${run.status}:${run.detail ?? ''}`;
  if (hold && state.holds[run.loopId] === signature) return null;
  const holds = { ...state.holds };
  if (hold) holds[run.loopId] = signature; else delete holds[run.loopId];
  // A waiting run is not delivered yet: its reminder and its result still post.
  return { delivered: waiting ? state.delivered : [...state.delivered, run.id].slice(-KEEP), holds };
}

function savedState(raw: unknown): LoopChatState {
  if (raw === undefined) return { delivered: [], holds: {} };
  const r = raw as Partial<LoopChatState> | null;
  if (!r || !Array.isArray(r.delivered) || !r.delivered.every((id) => typeof id === 'string') ||
    !r.holds || typeof r.holds !== 'object' || !Object.values(r.holds).every((v) => typeof v === 'string')) {
    throw new Error('Loop chat card state needs recovery.');
  }
  return { delivered: r.delivered, holds: r.holds };
}

export function createLoopChatCards(deps: {
  store: Pick<Store, 'productBud' | 'createTask' | 'appendMessage'>;
  broadcast: (payload: { kind: 'message'; threadId: string; message: Message }) => void;
  dataDir: string;
}): (run: LoopRun) => Promise<Message | null> {
  const file = join(deps.dataDir, 'loop-chat-cards.json');
  let state: LoopChatState | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const post = async (run: LoopRun): Promise<Message | null> => {
    // Damaged state throws here and posts nothing: a missed card beats a repeat.
    state ??= savedState(await readPrivateJson(file));
    const next = loopChatCardDecision(run, state);
    if (!next) return null;
    const bud = deps.store.productBud();
    if (!bud) return null;
    // Save first: a crash between save and append loses one card (the result
    // still waits on Desk) instead of reposting it on every restart.
    await writePrivateJson(file, next);
    state = next;
    const threadId = bud.tasks?.length ? bud.threadId : deps.store.createTask(bud.id, LOOP_CHAT_THREAD_TITLE)?.threadId;
    if (!threadId) return null;
    const card: OptionCardData & { opens: 'desk' } = {
      title: run.loopName,
      subtitle: run.detail || 'The saved result is on Desk.',
      options: ['Open'],
      opens: 'desk',
    };
    const message = deps.store.appendMessage(threadId, { role: 'bot', kind: 'options', card });
    deps.broadcast({ kind: 'message', threadId, message });
    return message;
  };
  return (run) => {
    const result = queue.then(() => post(run));
    queue = result.catch(() => {});
    return result;
  };
}
