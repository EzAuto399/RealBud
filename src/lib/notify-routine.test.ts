import { afterEach, expect, it, vi } from 'vitest';
import type { LoopRun } from '@shared/contracts';
import { notifyRoutineRun } from './notify-routine';
afterEach(() => vi.unstubAllGlobals());
it('notifies only settled changed routine results and deduplicates a repeated event', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-run-notify', loopId: 'weekly-bills', loopName: 'Weekly bills review', status: 'running', detail: '2 bill candidates prepared.' } as LoopRun;
  notifyRoutineRun(run); expect(notices).toHaveLength(0);
  run.status = 'awaiting-approval'; notifyRoutineRun(run); notifyRoutineRun(run); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-unchanged', seenAt: 1 }); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-default', status: 'failed', detail: 'Gmail needs sign-in.' });
  notifyRoutineRun({ ...run, id: 'fictional-repeat-hold', status: 'failed', detail: 'Gmail needs sign-in.' }); expect(notices).toHaveLength(2);
  FakeNotification.permission = 'default'; notifyRoutineRun({ ...run, id: 'fictional-no-permission' }); expect(notices).toHaveLength(2);
});
it('notifies Sherry once for new maintenance findings and stays quiet on an unchanged rescan', () => {
  const notices: unknown[] = [];
  class FakeNotification { static permission = 'granted'; constructor(title: unknown, options: unknown) { notices.push({ title, options }); } }
  vi.stubGlobal('Notification', FakeNotification);
  const run = { id: 'fictional-maintenance', loopId: 'maintenance-review', loopName: 'Maintenance checks', status: 'completed', detail: '1 new finding.' } as LoopRun;
  notifyRoutineRun(run); notifyRoutineRun(run); expect(notices).toHaveLength(1);
  notifyRoutineRun({ ...run, id: 'fictional-maintenance-rescan', seenAt: 1 }); expect(notices).toHaveLength(1);
});
