// Receives only a port already verified against this installation's identity.
// Keep recovery separate from normal desk navigation and the user's Stop.
function officeOnOtherPort(raw, port) {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && Number(url.port) !== port;
  } catch { return false; }
}

export function createServiceWindowRecovery({ window, fallbackUrls, blocked, beforeLoad, loadFailed }) {
  let loading = false;
  return (port) => {
    if (loading || blocked() || window.isDestroyed()) return false;
    // A desk still open on the previous port's origin is moved too: its old
    // origin no longer reaches the service, and native IPC answers only the
    // current office origin.
    const current = window.webContents.getURL();
    if (!fallbackUrls.includes(current) && !officeOnOtherPort(current, port)) return false;
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
