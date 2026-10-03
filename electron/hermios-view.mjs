// Hermios, the office CRM, shown inside a RealBud window and signed in by the
// person themselves.
//
// The page runs in its own persistent partition, sandboxed, with context
// isolation and web security on and no preload: it never sees the window bridge,
// RealBud never reads its cookies or content, Bud has no handle on it, and
// nothing here opens a debugging port. The person types their own password (or
// uses their organisation's Google or Microsoft sign-in) into Hermios; no
// credential passes through RealBud.
//
// The decisions are pure functions so they are tested without Electron, and the
// controller takes Electron's modules as arguments for the same reason.

export const HERMIOS_PARTITION = "persist:hermios";
export const HERMIOS_HOME_URL = "https://app.hermios.app/";

const HERMIOS_DOMAIN = "hermios.app";
const MAX_URL_LENGTH = 8192;
// Sign-in providers a Hermios organisation may enable. Navigation only: these
// hosts get no permission, popup or download beyond what any page gets here.
const SIGN_IN_PROVIDER_HOSTS = new Set(["accounts.google.com", "login.microsoftonline.com", "login.live.com"]);
// Everything else a page can ask for (camera, microphone, location,
// notifications, devices, clipboard reads, screen capture...) is refused.
const GRANTED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);
// A page that keeps navigating off-site must not be able to flood the default
// browser with tabs.
const EXTERNAL_OPEN_INTERVAL_MS = 1_000;

/** An https URL with no embedded credentials, or null. */
function parseHttps(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url;
}

/** `hermios.app` or a subdomain of it, every label non-empty. */
export function isHermiosHost(hostname) {
  if (typeof hostname !== "string" || !hostname.split(".").every(Boolean)) return false;
  return hostname === HERMIOS_DOMAIN || hostname.endsWith(`.${HERMIOS_DOMAIN}`);
}

/** A Hermios page on the default https port. */
export function isHermiosUrl(raw) {
  const url = parseHttps(raw);
  return Boolean(url && !url.port && isHermiosHost(url.hostname));
}

/** Whether the Hermios view may itself show this URL. */
export function isAllowedHermiosNavigation(raw) {
  const url = parseHttps(raw);
  if (!url || url.port) return false;
  return isHermiosHost(url.hostname) || SIGN_IN_PROVIDER_HOSTS.has(url.hostname);
}

/** "allow" stays in the view, "external" goes to the default browser, "ignore"
 * is dropped (anything that is not plain https: http, javascript, file, data,
 * custom schemes, URLs carrying credentials). */
export function hermiosNavigationAction(raw) {
  if (isAllowedHermiosNavigation(raw)) return "allow";
  return parseHttps(raw) ? "external" : "ignore";
}

export function isGrantedHermiosPermission(permission) {
  return GRANTED_PERMISSIONS.has(permission);
}

/** `{x, y, width, height}` of finite non-negative numbers, or null. */
export function parseViewBounds(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const value = payload[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    bounds[key] = value;
  }
  return bounds;
}

/** Renderer CSS pixels to whole window-content pixels, kept inside the window.
 * The renderer measures in CSS pixels; the view is placed in content DIPs, which
 * differ by the window's page zoom. */
export function clampViewBounds(bounds, content, zoomFactor = 1) {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const maxWidth = Math.max(0, Math.floor(Number(content?.width) || 0));
  const maxHeight = Math.max(0, Math.floor(Number(content?.height) || 0));
  const x = Math.min(Math.round(bounds.x * zoom), maxWidth);
  const y = Math.min(Math.round(bounds.y * zoom), maxHeight);
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width * zoom), maxWidth - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height * zoom), maxHeight - y)),
  };
}

/** Only the top frame of the RealBud window itself may move or drive the view:
 * never the Hermios view, another window's view, or an embedded frame. */
export function isWindowRenderer(event, win) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  const frame = event?.senderFrame;
  return Boolean(event) && event.sender === win.webContents && Boolean(frame) && frame.parent === null;
}

/** Wire the view and its IPC. `electron` carries ipcMain, BrowserWindow,
 * WebContentsView, session and shell, passed in by main.mjs. */
export function registerHermiosView(electron, { log = () => {} } = {}) {
  const { ipcMain, BrowserWindow, WebContentsView, session, shell } = electron;
  const views = new Map();
  let partitionReady = false;

  function hermiosSession() {
    const ses = session.fromPartition(HERMIOS_PARTITION);
    if (!partitionReady) {
      partitionReady = true;
      ses.setPermissionRequestHandler((_contents, permission, callback) => callback(isGrantedHermiosPermission(permission)));
      ses.setPermissionCheckHandler((_contents, permission) => isGrantedHermiosPermission(permission));
      ses.setDevicePermissionHandler?.(() => false);
      // Downloads keep Electron's default: the normal save dialog, where the
      // person chooses the place. No path is set here.
    }
    return ses;
  }

  function openExternal(entry, url) {
    const now = Date.now();
    if (now - entry.lastExternalAt < EXTERNAL_OPEN_INTERVAL_MS) return;
    entry.lastExternalAt = now;
    void Promise.resolve(shell.openExternal(url)).catch(() => {});
  }

  function load(entry, url) {
    void Promise.resolve(entry.view.webContents.loadURL(url)).catch((error) => {
      // Never log the URL: a sign-in redirect can carry one-time codes.
      if (error?.code !== "ERR_ABORTED") log(`hermios view load failed: ${error?.code ?? "unknown"}`);
    });
  }

  function hide(win) {
    const entry = views.get(win);
    if (!entry) return;
    const contents = entry.view.webContents;
    const hadFocus = !contents.isDestroyed() && contents.isFocused();
    entry.view.setVisible(false);
    if (hadFocus && !win.isDestroyed()) win.webContents.focus();
  }

  function ensure(win) {
    const existing = views.get(win);
    if (existing) return existing;
    hermiosSession();
    const view = new WebContentsView({
      webPreferences: {
        partition: HERMIOS_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
      },
    });
    const entry = { view, loaded: false, lastExternalAt: 0 };
    const contents = view.webContents;
    // Main-frame navigation and server redirects. Embedded frames (a sign-in
    // challenge, for instance) stay inside their frame and are left alone.
    const guard = (event, legacyUrl) => {
      if (event.isMainFrame === false) return;
      const url = typeof event.url === "string" ? event.url : legacyUrl;
      const action = hermiosNavigationAction(url);
      if (action === "allow") return;
      event.preventDefault();
      if (action === "external") openExternal(entry, url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    // No popups, ever: an allowed page opens in the view, any other https page
    // in the default browser.
    contents.setWindowOpenHandler(({ url }) => {
      const action = hermiosNavigationAction(url);
      if (action === "allow") load(entry, url);
      else if (action === "external") openExternal(entry, url);
      return { action: "deny" };
    });
    view.setVisible(false);
    win.contentView.addChildView(view);
    // The view is drawn above the window's page. A page that goes away without
    // hiding it (a reload, a crash, the service recovery page) must not leave
    // Hermios painted over whatever loads next.
    win.webContents.on("did-start-navigation", (details) => {
      if (details?.isMainFrame !== false && !details?.isSameDocument) hide(win);
    });
    win.webContents.on("render-process-gone", () => hide(win));
    win.once("closed", () => {
      views.delete(win);
      if (!contents.isDestroyed()) contents.close();
    });
    views.set(win, entry);
    return entry;
  }

  function show(win, bounds) {
    const content = win.getContentSize();
    const rect = clampViewBounds(bounds, { width: content[0], height: content[1] }, win.webContents.getZoomFactor());
    if (rect.width === 0 || rect.height === 0) {
      hide(win);
      return false;
    }
    const entry = ensure(win);
    entry.view.setBounds(rect);
    entry.view.setVisible(true);
    // First show only: afterwards the page stays where the person left it,
    // so switching tabs never reloads it.
    if (!entry.loaded) {
      entry.loaded = true;
      load(entry, HERMIOS_HOME_URL);
    }
    return true;
  }

  const handle = (channel, action) => {
    ipcMain.handle(channel, (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!isWindowRenderer(event, win)) return false;
      return action(win, payload);
    });
  };
  const noPayload = (action) => (win, payload) => (payload === undefined ? action(win) : false);
  const loadedContents = (win) => {
    const entry = views.get(win);
    return entry?.loaded && !entry.view.webContents.isDestroyed() ? entry.view.webContents : null;
  };

  handle("hermios-view:show", (win, payload) => {
    const bounds = parseViewBounds(payload);
    return bounds ? show(win, bounds) : false;
  });
  handle("hermios-view:hide", noPayload((win) => {
    hide(win);
    return true;
  }));
  handle("hermios-view:back", noPayload((win) => {
    const contents = loadedContents(win);
    if (!contents?.navigationHistory.canGoBack()) return false;
    contents.navigationHistory.goBack();
    return true;
  }));
  handle("hermios-view:reload", noPayload((win) => {
    const contents = loadedContents(win);
    if (!contents) return false;
    contents.reload();
    return true;
  }));
  // Signs out of Hermios on this computer only: clears the Hermios partition
  // (cookies, storage, cache) and nothing else, then shows the sign-in page.
  handle("hermios-view:sign-out", noPayload(async (win) => {
    const ses = hermiosSession();
    await ses.clearStorageData();
    await ses.clearCache();
    const entry = views.get(win);
    if (entry?.loaded && !entry.view.webContents.isDestroyed()) {
      entry.view.webContents.navigationHistory.clear();
      load(entry, HERMIOS_HOME_URL);
    }
    return true;
  }));
  handle("hermios-view:open-external", noPayload(async (win) => {
    const current = loadedContents(win)?.getURL();
    const url = isHermiosUrl(current) ? current : HERMIOS_HOME_URL;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  }));
}
