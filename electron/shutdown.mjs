/** Keep services alive if a window cancels closing (for example, unsaved work).
 * Only will-quit confirms all windows have accepted shutdown. */
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
      app.quit();
    });
  });
}
