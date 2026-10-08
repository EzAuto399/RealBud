import { describe, expect, it, vi } from 'vitest';
import { desktopStartBody, desktopWindowLabel, loadDesktopWindows } from './desktop-windows';

const mail = { appName: 'Mail', bundleId: 'com.apple.mail', pid: 501, windowId: 77, title: 'Inbox' };
const failing = (status?: number) => vi.fn().mockRejectedValue(Object.assign(new Error('nope'), status ? { status } : {}));

describe('desktop windows', () => {
  it('reads the open windows from the server and validates them', async () => {
    const request = vi.fn().mockResolvedValue({ windows: [mail] });
    expect(await loadDesktopWindows(request)).toEqual({ status: 'ready', windows: [mail] });
    expect(request).toHaveBeenCalledWith('/api/desktop/windows', undefined, { timeoutMs: 10_000 });
    expect(await loadDesktopWindows(vi.fn().mockResolvedValue({ windows: [] }))).toEqual({ status: 'ready', windows: [] });
  });

  it('reads a missing route or switched-off app access as unavailable, and anything else as an error', async () => {
    for (const status of [404, 501, 503]) expect(await loadDesktopWindows(failing(status))).toEqual({ status: 'unavailable' });
    expect(await loadDesktopWindows(failing(500))).toEqual({ status: 'error' });
    expect(await loadDesktopWindows(failing())).toEqual({ status: 'error' });
    expect(await loadDesktopWindows(vi.fn().mockResolvedValue({ windows: [{ ...mail, extra: 1 }] }))).toEqual({ status: 'error' });
  });

  it('names a window by app and title, and Start sends only the window it chose', () => {
    expect(desktopWindowLabel(mail)).toBe('Mail — Inbox');
    expect(desktopWindowLabel({ ...mail, title: ' ' })).toBe('Mail');
    expect(desktopStartBody(mail)).toEqual({ window: { pid: 501, windowId: 77 } });
  });
});
