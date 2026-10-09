/** Electron suppresses renderer beforeunload dialogs. Honour that refusal with
 * an explicit native choice; preventDefault on this event permits the unload. */
export function registerUnsavedWorkPrompt(win, dialog) {
  win.webContents.on('will-prevent-unload', event => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', title: 'Keep your unsaved work',
      message: 'This window has unsaved work.',
      detail: 'Keep editing to save or explicitly discard your changes. Closing or reloading loses notes held only in this window.',
      buttons: ['Keep editing', 'Discard unsaved changes'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (choice === 1) event.preventDefault();
  });
}
