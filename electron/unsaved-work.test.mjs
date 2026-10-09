import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerUnsavedWorkPrompt } from './unsaved-work.mjs';
function fixture(choice = 0, destroyed = false) {
  const contents = new EventEmitter(); contents.isDestroyed = () => destroyed;
  const win = { webContents: contents, isDestroyed: () => destroyed };
  const dialog = { showMessageBoxSync: vi.fn(() => choice) }, event = { preventDefault: vi.fn() };
  registerUnsavedWorkPrompt(win, dialog); contents.emit('will-prevent-unload', event); return { win, dialog, event };
}
describe('unsaved desktop work', () => {
  it('keeps the window and service running by default, on cancel, or an unexpected response', () => {
    for (const choice of [0, -1, 2]) {
      const f = fixture(choice); expect(f.event.preventDefault).not.toHaveBeenCalled();
      expect(f.dialog.showMessageBoxSync).toHaveBeenCalledWith(f.win, expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ['Keep editing', 'Discard unsaved changes'] }));
    }
  });
  it('allows unload only after explicit discard and ignores destroyed windows', () => {
    expect(fixture(1).event.preventDefault).toHaveBeenCalledOnce();
    const closed = fixture(1, true); expect(closed.dialog.showMessageBoxSync).not.toHaveBeenCalled(); expect(closed.event.preventDefault).not.toHaveBeenCalled();
  });
});
