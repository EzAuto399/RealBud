import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoopRun } from '../shared/contracts.ts';
import { createLoopChatCards, LOOP_CHAT_THREAD_TITLE } from './loop-chat-cards.ts';

function run(over: Partial<LoopRun> = {}): LoopRun {
  return { id: 'run-1', loopId: 'weekly-bills', loopName: 'Weekly bills', scheduledFor: 1, status: 'completed', manual: false, detail: '2 bills ready to review.', createdAt: 1, ...over } as LoopRun;
}

function harness(dataDir = mkdtempSync(join(tmpdir(), 'loop-chat-')), tasks = true) {
  const appended: Array<{ threadId: string; message: any }> = [];
  const created: string[] = [];
  const bud: any = { id: 'bud', threadId: 'thread-active', tasks: tasks ? [{ threadId: 'thread-active' }] : [] };
  const store: any = {
    productBud: () => bud,
    createTask: (_botId: string, title: string) => { created.push(title); bud.threadId = 'thread-new'; bud.tasks = [{ threadId: 'thread-new' }]; return { threadId: 'thread-new' }; },
    appendMessage: (threadId: string, m: any) => { const message = { ...m, id: `m${appended.length}`, at: 1 }; appended.push({ threadId, message }); return message; },
  };
  const broadcasts: any[] = [];
  const post = createLoopChatCards({ store, broadcast: (p) => broadcasts.push(p), dataDir });
  return { post, appended, created, broadcasts, dataDir };
}

describe('loop chat cards', () => {
  it('posts one Open card per new settled run to the active Ask thread', async () => {
    const h = harness();
    await h.post(run());
    await h.post(run());
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({ threadId: 'thread-active', message: { role: 'bot', kind: 'options', card: { title: 'Weekly bills', subtitle: '2 bills ready to review.', options: ['Open'], opens: 'desk' } } });
    expect(h.broadcasts).toEqual([{ kind: 'message', threadId: 'thread-active', message: h.appended[0].message }]);
  });

  it('posts the monthly inspection draft as one card', async () => {
    const h = harness();
    await h.post(run({ id: 'r-inspection', loopId: 'inspection-draft', loopName: 'Inspection draft', status: 'awaiting-approval', detail: 'New inspection draft ready to review: 4 to accept, 1 held. Nothing is booked.' }));
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].message.card).toMatchObject({ title: 'Inspection draft', options: ['Open'], opens: 'desk' });
  });

  it('stays quiet for seen, unsettled or other-loop runs', async () => {
    const h = harness();
    await h.post(run({ seenAt: 5 }));
    await h.post(run({ id: 'r2', status: 'running' }));
    await h.post(run({ id: 'r3', loopId: 'morning-arrears' as LoopRun['loopId'] }));
    await h.post(run({ id: 'r4', loopId: 'bank-references' as LoopRun['loopId'] }));
    expect(h.appended).toHaveLength(0);
  });

  it('posts a repeated identical hold once, and again after it changes', async () => {
    const h = harness();
    await h.post(run({ id: 'a', status: 'failed', detail: 'Gmail needs reconnecting.' }));
    await h.post(run({ id: 'b', status: 'failed', detail: 'Gmail needs reconnecting.' }));
    expect(h.appended).toHaveLength(1);
    await h.post(run({ id: 'c', status: 'completed' }));
    await h.post(run({ id: 'd', status: 'failed', detail: 'Gmail needs reconnecting.' }));
    expect(h.appended).toHaveLength(3);
  });

  it('does not repost after a restart with the same saved state', async () => {
    const first = harness();
    await first.post(run({ id: 'x' }));
    await first.post(run({ id: 'h', status: 'missed', detail: 'Computer was asleep.' }));
    const second = harness(first.dataDir);
    await second.post(run({ id: 'x' }));
    await second.post(run({ id: 'h2', status: 'missed', detail: 'Computer was asleep.' }));
    expect(second.appended).toHaveLength(0);
  });

  it('posts a run waiting at REI sign-in once, its midday reminder once, nothing for a restart, and its miss', async () => {
    const h = harness();
    const line = 'Sign in to REI Cloud so Bud can finish the bank import. (waiting until 6:00 pm on Tue, 6 Oct).';
    const reminder = 'Reminder: sign in to REI Cloud so Bud can finish the bank import. Bud waits until 6:00 pm on Tue, 6 Oct.';
    const bank = (over: Partial<LoopRun>) => run({ loopId: 'bank-references' as LoopRun['loopId'], loopName: 'Bank reference review', status: 'running', ...over });
    await h.post(bank({ id: 'w', detail: line }));
    await h.post(bank({ id: 'w', detail: line }));
    await h.post(bank({ id: 'w', detail: 'Reading REI. Nothing in REI changes.' }));
    await h.post(bank({ id: 'w', detail: reminder }));
    // After a restart the resumed run says the same reminder: quiet, from the saved state.
    const restarted = harness(h.dataDir);
    await restarted.post(bank({ id: 'w2', detail: reminder }));
    await restarted.post(bank({ id: 'w2', status: 'missed', detail: "Missed: REI Cloud wasn't signed in today, so the bank import is waiting." }));
    expect([...h.appended, ...restarted.appended].map(item => item.message.card.subtitle)).toEqual([line, reminder, "Missed: REI Cloud wasn't signed in today, so the bank import is waiting."]);
    // The supplier check's wait ends in its result, which still posts.
    await restarted.post(run({ id: 's', loopId: 'rei-supplier-check', status: 'running', detail: 'Sign in to REI Cloud so Bud can check the supplier list.' }));
    await restarted.post(run({ id: 's', loopId: 'rei-supplier-check', status: 'awaiting-approval', detail: 'Supplier list changed in REI: 1 added.' }));
    expect(restarted.appended.map(item => item.message.card.subtitle).slice(-2)).toEqual(['Sign in to REI Cloud so Bud can check the supplier list.', 'Supplier list changed in REI: 1 added.']);
  });

  it('creates a plainly named thread when Bud has none', async () => {
    const h = harness(undefined, false);
    await h.post(run());
    expect(h.created).toEqual([LOOP_CHAT_THREAD_TITLE]);
    expect(h.appended[0].threadId).toBe('thread-new');
  });
});
