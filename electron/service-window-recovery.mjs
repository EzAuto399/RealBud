// Receives only a port already verified against this installation's identity.
// Keep recovery separate from normal desk navigation and the user's Stop.
export function createServiceWindowRecovery({ window, fallbackUrls, blocked, beforeLoad, loadFailed }) {
  let loading = false;
  return (port) => {
    if (loading || blocked() || window.isDestroyed() || !fallbackUrls.includes(window.webContents.getURL())) return false;
    loading = true;
    beforeLoad(port);
    try {
      Promise.resolve(window.loadURL(`http://127.0.0.1:${port}`)).catch(loadFailed).finally(() => { loading = false; });
    } catch (error) {
      loading = false;
      loadFailed(error);
    }
    return true;
  };
}
