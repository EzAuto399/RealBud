// Links leave the office window only as plain https, and the window itself stays
// on the office page main loaded. The renderer shows model output and quoted mail
// and web content, so every link it hands over is untrusted: a file:, smb: or
// custom-scheme link given to the OS opens a local file or another app, and an
// off-origin page in this window would be handed the window.ogb bridge.
// Pure, so tests import it without booting Electron.

/** The https URL the OS may open, or null when the link must stay in the app. */
export function externalHttpsUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.toString();
}

/** Hands an https link to the person's browser. Resolves true only when it did. */
export async function openExternalHttps(shell, raw) {
  const url = externalHttpsUrl(raw);
  if (!url) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

/** Whether `raw` is on the http(s) origin of `appUrl`. An opaque origin (data:,
 * file:, about:) never matches, not even another opaque one. */
export function onAppOrigin(raw, appUrl) {
  try {
    const app = new URL(String(appUrl));
    if (app.protocol !== "http:" && app.protocol !== "https:") return false;
    return new URL(String(raw)).origin === app.origin;
  } catch {
    return false;
  }
}

/** Whether an IPC `event` came from a window's own top-level page on the office
 * origin. A subframe, an embedded view or any page that navigated off-origin
 * gets nothing, even though the preload bridge may still be attached to it.
 * `windowContents(sender)` is the webContents of the BrowserWindow that hosts
 * `sender`, or null. */
export function trustedOfficeSender(event, appUrl, windowContents) {
  const sender = event?.sender, frame = event?.senderFrame;
  if (!sender || !frame || frame !== sender.mainFrame) return false;
  if (windowContents(sender) !== sender) return false;
  return onAppOrigin(frame.url, appUrl);
}

function scheme(raw) {
  try {
    return new URL(String(raw)).protocol;
  } catch {
    return "unreadable";
  }
}

/** Denies every popup and keeps main-frame navigation on `appUrl()`, read per
 * event because the office port can change under a live window. Anything else
 * goes to the https opener; the log names only the scheme, never the URL, since
 * links from mail can carry tokens. */
export function guardOfficeWindow(contents, { appUrl, shell, log = () => {} }) {
  const leave = (url) =>
    openExternalHttps(shell, url).then((opened) => {
      if (!opened) log(`kept a ${scheme(url)} link inside the desk`);
    });
  contents.setWindowOpenHandler(({ url }) => {
    void leave(url);
    return { action: "deny" };
  });
  // Electron 43 passes the details first and the deprecated url second.
  const stay = (event, legacyUrl) => {
    if (event?.isMainFrame === false) return;
    const url = event?.url ?? legacyUrl;
    if (onAppOrigin(url, appUrl())) return;
    event.preventDefault();
    void leave(url);
  };
  contents.on("will-navigate", stay);
  // A same-origin page answering with a redirect elsewhere is leaving too.
  contents.on("will-redirect", stay);
}
