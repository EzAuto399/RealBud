/** Run an updater operation without allowing either a synchronous throw or a
 * rejected Electron promise to escape as an unhandled process rejection. */
export function runUpdaterAction(action, onError) {
  try {
    const pending = action();
    if (pending && typeof pending.then === "function") void Promise.resolve(pending).catch(onError);
  } catch (error) {
    onError(error);
  }
}
