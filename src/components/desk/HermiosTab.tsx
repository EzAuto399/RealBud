import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, LogOut, RotateCw } from "lucide-react";
import { HermiosMark } from "@/components/HermiosMark";
import {
  HERMIOS_STATE_UNREADABLE,
  useHermiosConnection,
  type HermiosConnectionApi,
  type HermiosConnectionControls,
} from "@/lib/hermios-connection-api";

/** Where a person signs in to Hermios. Each organisation then lives on its own
 *  `<org>.hermios.app` address. */
export const HERMIOS_SIGN_IN_URL = "https://app.hermios.app/";

/** Bud's connection is not the person's own Hermios sign-in in this tab. */
export const HERMIOS_SEPARATE = "Your Hermios window and Bud's connection are separate.";
export const HERMIOS_CONNECT_LINE =
  "Connecting confirms your Hermios account and workspace for Bud, using your own Hermios access. Any change Bud prepares still needs your approval.";

/** The Hermios page is a native view drawn above this page, so nothing in HTML
 *  can sit on top of it. Whatever must be seen instead hides it: an open dialog
 *  or modal sheet, a popover (the workspace overview), the Desk "More" menu, and
 *  the app-wide error notice at the bottom of the window. */
export const COVERS_HERMIOS = 'dialog[open], [aria-modal="true"], details.desk-more[open], .workspace-notice';

export function hermiosCovered(doc: Pick<Document, "querySelector" | "visibilityState">): boolean {
  if (doc.visibilityState === "hidden") return true;
  if (doc.querySelector(COVERS_HERMIOS)) return true;
  try {
    return doc.querySelector(":popover-open") !== null;
  } catch {
    // An engine without popovers has none open.
    return false;
  }
}

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of the placeholder inside the window, in CSS pixels; null when
 *  less than a pixel of it is on screen. */
export function visibleRect(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  viewport: { width: number; height: number },
): ViewRect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const width = Math.min(viewport.width, rect.right) - left;
  const height = Math.min(viewport.height, rect.bottom) - top;
  if (!(width >= 1 && height >= 1)) return null;
  return { x: left, y: top, width, height };
}

/** What placement needs from the browser; tests pass stand-ins. */
export interface PlacementEnv {
  document: Pick<Document, "querySelector" | "visibilityState" | "body" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "innerWidth" | "innerHeight" | "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame">;
  ResizeObserver: typeof ResizeObserver;
  MutationObserver: typeof MutationObserver;
}

const DOCUMENT_EVENTS = ["visibilitychange", "toggle", "animationend", "transitionend"] as const;

/** Keep the native view over `node` until the returned cleanup runs, then hide
 *  it. Anything covering hides it at once; placing waits for the next frame, so
 *  a window resize sends at most one rectangle per frame, and an unchanged
 *  rectangle is never sent twice. `onPlaced` hears whether a show worked. */
export function followPlaceholder(
  bridge: Pick<HermiosViewBridge, "show" | "hide">,
  node: Element,
  onPlaced: (ok: boolean) => void,
  env: PlacementEnv = { document, window, ResizeObserver, MutationObserver },
): () => void {
  const { document: doc, window: win } = env;
  let frame = 0;
  let sent = "";
  let disposed = false;
  const hide = () => {
    if (sent === "hidden") return;
    sent = "hidden";
    void bridge.hide().catch(() => {});
  };
  const place = () => {
    frame = 0;
    if (disposed) return;
    if (hermiosCovered(doc)) return hide();
    const rect = visibleRect(node.getBoundingClientRect(), { width: win.innerWidth, height: win.innerHeight });
    if (!rect) return hide();
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (key === sent) return;
    sent = key;
    void bridge.show(rect).then(
      (ok) => { if (!disposed) onPlaced(ok); },
      () => { if (!disposed) onPlaced(false); },
    );
  };
  const update = () => {
    if (disposed) return;
    if (hermiosCovered(doc)) {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      hide();
      return;
    }
    if (!frame) frame = win.requestAnimationFrame(place);
  };
  const resize = new env.ResizeObserver(update);
  resize.observe(node);
  const mutations = new env.MutationObserver(update);
  mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "aria-modal"] });
  win.addEventListener("resize", update);
  for (const type of DOCUMENT_EVENTS) doc.addEventListener(type, update, true);
  update();
  return () => {
    disposed = true;
    if (frame) win.cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    win.removeEventListener("resize", update);
    for (const type of DOCUMENT_EVENTS) doc.removeEventListener(type, update, true);
    void bridge.hide().catch(() => {});
  };
}

function desktopBridge(): HermiosViewBridge | null {
  return typeof window === "undefined" ? null : window.ogb?.hermiosView ?? null;
}

/** Hermios, the office CRM, with the person's own sign-in. In the desktop app
 *  it is a native view placed over this tab; anywhere else it is a link. */
export function HermiosTab({ bridge, connection }: { bridge?: HermiosViewBridge | null; connection?: HermiosConnectionApi }) {
  // Resolved once: placement follows this one bridge for the tab's lifetime.
  const [view] = useState(() => (bridge === undefined ? desktopBridge() : bridge));
  const controls = useHermiosConnection(connection);
  return view ? <HermiosDesktop bridge={view} controls={controls} /> : <HermiosLink controls={controls} />;
}

const actionClass =
  "pm-control rounded border border-line bg-sheet px-3 text-ink hover:bg-raised disabled:opacity-50";
const primaryClass =
  "pm-control rounded bg-agency px-3.5 font-medium text-white hover:bg-agency-hover disabled:opacity-50";

type StripControls = Pick<HermiosConnectionControls, "view" | "connect" | "check" | "disconnect" | "refresh">;

/** Bud's own Hermios connection, driven only by what the service reports. */
export function HermiosConnectionStrip({ controls }: { controls: StripControls }) {
  const { view, connect, check, disconnect, refresh } = controls;
  const { state, loading, readError, busy, notice } = view;
  const [confirming, setConfirming] = useState(false);
  const disabled = busy !== null;
  const connectButton = (label: string) => (
    <button type="button" className={primaryClass} disabled={disabled} aria-busy={busy === "connect"} onClick={() => void connect()}>
      {busy === "connect" ? "Opening Hermios sign-in…" : label}
    </button>
  );
  const checkButton = (
    <button type="button" className={actionClass} disabled={disabled} aria-busy={busy === "check"} onClick={() => void (state ? check() : refresh())}>
      {busy === "check" ? "Checking…" : "Check again"}
    </button>
  );

  let line: string;
  let actions: React.ReactNode = null;
  if (!state) {
    line = loading ? "Checking Bud's Hermios connection…" : readError ?? HERMIOS_STATE_UNREADABLE;
    actions = loading ? null : checkButton;
  } else if (state.status === "not_connected") {
    line = HERMIOS_CONNECT_LINE;
    actions = connectButton("Connect Bud to your Hermios");
  } else if (state.status === "connecting") {
    line = "Finish signing in to Hermios in your browser.";
    actions = checkButton;
  } else if (state.status === "connected" && state.account) {
    line = `Bud is connected as ${state.account.displayName} · ${state.account.workspaceLabel}`;
    actions = (
      <>
        <button type="button" className={actionClass} disabled={disabled} aria-busy={busy === "check"} onClick={() => void check()}>
          {busy === "check" ? "Checking…" : "Check"}<span className="sr-only"> Bud's Hermios connection</span>
        </button>
        <button
          type="button"
          className={actionClass}
          disabled={disabled}
          aria-expanded={confirming}
          aria-controls="hermios-disconnect"
          onClick={() => setConfirming((value) => !value)}
        >
          Disconnect<span className="sr-only"> Bud from Hermios</span>
        </button>
      </>
    );
  } else {
    line = state.reason ?? (state.status === "needs_reconnect"
      ? "Bud's Hermios connection needs you to sign in again."
      : "Bud's Hermios connection isn't available right now.");
    actions = connectButton("Connect again");
  }

  return (
    <div role="group" aria-label="Bud's Hermios connection" className="border-b border-line bg-sheet px-5 py-2 max-[719px]:px-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p role="status" className="break-words text-[13px] text-ink">{line}</p>
          <p className="text-[12px] text-ink-muted">{HERMIOS_SEPARATE}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {confirming && state?.status === "connected" ? (
        <div id="hermios-disconnect" role="group" aria-label="Confirm disconnecting Bud from Hermios" className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[13px] text-ink">
          <p className="min-w-0 flex-1">
            Disconnect Bud from Hermios? Bud stops using your Hermios access. Your Hermios records and your own Hermios sign-in stay as they are.
          </p>
          <button
            type="button"
            className="pm-control rounded bg-danger px-3.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={disabled}
            aria-busy={busy === "disconnect"}
            onClick={() => void disconnect().finally(() => setConfirming(false))}
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect Bud"}
          </button>
          <button type="button" className={actionClass} disabled={disabled} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {notice || (readError && state) ? (
        <p role={notice && !notice.problem ? "status" : "alert"} className={`mt-1 text-[12.5px] ${notice && !notice.problem ? "text-ink-secondary" : "text-hold"}`}>
          {notice?.text ?? readError}
        </p>
      ) : null}
    </div>
  );
}

function HermiosHeader({ controls, children }: { controls: StripControls; children?: React.ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2 max-[719px]:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <HermiosMark size={28} />
          <div className="min-w-0">
            <h2 id="hermios-title" className="text-[15px] font-semibold text-ink">Hermios</h2>
            <p className="text-[12px] text-ink-muted">Your own Hermios sign-in</p>
          </div>
        </div>
        {children}
      </div>
      <HermiosConnectionStrip controls={controls} />
    </>
  );
}

function HermiosLink({ controls }: { controls: StripControls }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-paper" aria-labelledby="hermios-title">
      <HermiosHeader controls={controls} />
      <div className="max-w-[40rem] space-y-3 px-5 py-5 text-[14px] text-ink max-[719px]:px-3">
        <p>Hermios opens inside the RealBud desktop app. Here, open it in its own browser tab and sign in there.</p>
        <a
          href={HERMIOS_SIGN_IN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="pm-control inline-flex rounded bg-agency px-3.5 font-medium text-white hover:bg-agency-hover"
        >
          <ExternalLink size={16} aria-hidden />
          Open Hermios
        </a>
      </div>
    </section>
  );
}

function HermiosDesktop({ bridge, controls }: { bridge: HermiosViewBridge; controls: StripControls }) {
  const area = useRef<HTMLDivElement | null>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<{ text: string; problem: boolean } | null>(null);
  const [placeFailed, setPlaceFailed] = useState(false);
  const signOutButton = useRef<HTMLButtonElement | null>(null);

  // Keep the native view exactly over the placeholder, and out of the way of
  // anything RealBud shows above it.
  useEffect(() => {
    const node = area.current;
    return node ? followPlaceholder(bridge, node, (ok) => setPlaceFailed(!ok)) : undefined;
  }, [bridge]);

  // Back and Reload quietly do nothing when there is nowhere to go; only a
  // failure the person has to act on is reported.
  const act = (action: () => Promise<boolean>, failure?: string) => {
    setNotice(null);
    const fail = () => { if (failure) setNotice({ text: failure, problem: true }); };
    void action().then((ok) => { if (!ok) fail(); }, fail);
  };

  const signOut = async () => {
    const failed = { text: "Sign-out didn't finish. Try again, or sign out inside Hermios.", problem: true };
    setSigningOut(true);
    setNotice(null);
    try {
      setNotice((await bridge.signOut()) ? { text: "Signed out of Hermios on this computer.", problem: false } : failed);
    } catch {
      setNotice(failed);
    } finally {
      setSigningOut(false);
      setConfirmingSignOut(false);
      signOutButton.current?.focus();
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper" aria-labelledby="hermios-title">
      <HermiosHeader controls={controls}>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Hermios page">
          <button type="button" className={actionClass} onClick={() => act(() => bridge.back())}>
            <ArrowLeft size={16} aria-hidden />
            Back<span className="sr-only"> in Hermios</span>
          </button>
          <button type="button" className={actionClass} onClick={() => act(() => bridge.reload())}>
            <RotateCw size={16} aria-hidden />
            Reload<span className="sr-only"> Hermios</span>
          </button>
          <button
            type="button"
            className={actionClass}
            onClick={() => act(() => bridge.openExternal(), "Your browser didn't open. Hermios is at app.hermios.app.")}
          >
            <ExternalLink size={16} aria-hidden />
            Open in browser
          </button>
          <button
            ref={signOutButton}
            type="button"
            className={actionClass}
            aria-expanded={confirmingSignOut}
            aria-controls="hermios-sign-out"
            disabled={signingOut}
            onClick={() => { setNotice(null); setConfirmingSignOut((value) => !value); }}
          >
            <LogOut size={16} aria-hidden />
            Sign out here
          </button>
        </div>
      </HermiosHeader>
      {confirmingSignOut ? (
        <div
          id="hermios-sign-out"
          role="group"
          aria-label="Confirm Hermios sign-out"
          className="flex flex-wrap items-center gap-2 border-b border-line bg-sheet px-5 py-2 text-[13px] text-ink max-[719px]:px-3"
        >
          <p className="min-w-0 flex-1">
            Sign out of Hermios on this computer? This clears only Hermios&rsquo; saved sign-in here. Your Hermios account and records don&rsquo;t change.
          </p>
          <button
            type="button"
            className="pm-control rounded bg-agency px-3.5 font-medium text-white hover:bg-agency-hover disabled:opacity-50"
            disabled={signingOut}
            aria-busy={signingOut}
            onClick={() => void signOut()}
          >
            Sign out of Hermios
          </button>
          <button type="button" className={actionClass} disabled={signingOut} onClick={() => setConfirmingSignOut(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {notice || placeFailed ? (
        <p
          role="status"
          className={`border-b border-line px-5 py-2 text-[13px] max-[719px]:px-3 ${notice && !notice.problem ? "text-ink-secondary" : "text-hold"}`}
        >
          {notice?.text ?? "Hermios couldn't open here. Use Open in browser instead."}
        </p>
      ) : null}
      {/* The native view covers this area; its text shows only while Hermios
          is loading, blank or hidden. */}
      <div ref={area} className="flex min-h-0 flex-1 items-center justify-center bg-sheet px-5 text-center text-[13px] text-ink-muted">
        <p>Hermios shows here. If it stays blank, use Reload or Open in browser.</p>
      </div>
    </section>
  );
}
