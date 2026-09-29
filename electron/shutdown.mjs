/** Keep services alive if a window cancels closing (for example, unsaved work).
 * Only will-quit confirms all windows have accepted shutdown.
 *
 * Completion uses `app.exit(0)`, never a second `app.quit()`. Electron (43.x)
 * silently ignores a quit requested after `will-quit` was prevented: no second
 * `before-quit`, no `will-quit`, the process just stays up with its windows gone
 * and its helpers (the service watchdog among them) already stopped. `exit` skips
 * only `before-quit`/`will-quit`, which have both run by now, and still emits `quit`. */
export function registerDesktopShutdown(app, { stopServer, stopSpeech, closeControl, stopComputer, timeoutMs = 2500 }) {
  let completed = false;
  let pending = false;
  app.on("will-quit", event => {
    if (completed) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
    const cleanup = Promise.allSettled(
      [stopServer, stopSpeech, closeControl, stopComputer].map(stop => Promise.resolve().then(stop)),
    );
    void Promise.race([cleanup, deadline]).then(() => {
      clearTimeout(timer);
      completed = true;
      app.exit(0);
    });
  });
}
