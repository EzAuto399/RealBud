// Auto-update card, floating bottom-left and driven by the preload's updater
// bridge. Checking and downloading happen silently in the background, so it
// appears only when there is something to know or do: an update waiting for a
// safe moment, the restart countdown, a failed install, a finished update, or
// an error. One primary action per state (docs/UPDATES-2026-10-10.md).
import { useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Loader2, RefreshCw, X, type LucideIcon } from "lucide-react";
import { countdownAt, updateReadyLine, useSecondsLeft, useUpdaterState } from "@/lib/updater";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

const DOWNLOAD_URL = "https://realbud.app/download";
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The release page for a version main reported; null for anything that isn't one. */
export function releaseNotesUrl(version: string): string | null {
  return RELEASE_VERSION.test(version) ? `https://github.com/EzAuto399/RealBud/releases/tag/v${version}` : null;
}

const primary = "pm-control flex grow items-center justify-center gap-1.5 whitespace-nowrap rounded bg-accent px-3 text-[13px] font-medium text-white";
const quiet = "pm-control rounded px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink";
const link = "pm-control inline-flex items-center whitespace-nowrap rounded px-2 text-[13px] text-agency underline hover:bg-raised";

function Card({ icon: Icon, title, line, countdown, docked, onDismiss, children }: {
  icon: LucideIcon; title: string; line?: ReactNode;
  /** Set while the countdown runs: the ticking title stays out of the live region, which announces the start once. */
  countdown?: string;
  docked?: boolean;
  onDismiss?: () => void; children?: ReactNode;
}) {
  // Floating, rb-toast-stack lifts the card above the phone navigation and the status bar.
  // Docked, it takes its own place below the screen, so it never covers the screen's buttons.
  return (
    <div
      {...(countdown ? { role: "group", "aria-label": "Restarting to update" } : { role: "status" })}
      data-update-card=""
      className={`${docked ? "mx-4 mb-4 shrink-0" : "rb-toast-stack fixed bottom-4 left-4 z-50"} animate-panel-in w-[300px] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-sheet p-3.5 shadow-lg`}
    >
      {countdown ? <span role="status" className="sr-only">{countdown}</span> : null}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Icon size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink tabular-nums">{title}</div>
          {line ? <div className="mt-0.5 text-[12.5px] text-ink-secondary">{line}</div> : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Dismiss"
            aria-label="Dismiss update notice"
          >
            <X size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      {children ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** `docked`: on a screen with no shell (first run, the office link, Bud's first setup) the card
 * sits below the screen instead of floating over it. */
export function UpdateBanner({ docked = false }: { docked?: boolean }) {
  const s = useUpdaterState();
  // Dismissal is per state key, so the card returns for the next update, a
  // finished download, a reason main gives, or the update becoming required.
  // Not for the restart's mode: that flips each time the person leaves and returns.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [noteDismissed, setNoteDismissed] = useState<string | null>(null);
  const seconds = useSecondsLeft(countdownAt(s));
  if (!s) return null;
  const updater = window.ogb!.updater!;
  const restart = s.restart;
  const version = s.version ?? "The update";
  const installNow = () => void updater.install();
  // Main refuses Later for a required update or nothing on disk, and the card then
  // stays; an older bridge without later() only hides it, as before.
  const holdLater = async (key: string) => {
    let held = true;
    try { held = (await updater.later?.()) !== false; } catch { held = false; }
    if (held) setDismissed(key);
  };

  // The countdown always shows: it is about to close the window.
  if (restart?.mode === "countdown") {
    return (
      <Card
        docked={docked}
        icon={RefreshCw}
        title={seconds === null ? "Restarting to update" : seconds === 0 ? "Restarting to update…" : `Restarting to update in ${seconds} s`}
        // A required update no longer waits for an approval card, so only promise what it keeps.
        line={restart.required ? "Open drafts and running work are kept." : "Your work is kept."}
        countdown="RealBud is about to restart to update. Choose Not now to keep working."
      >
        <button type="button" onClick={installNow} className={primary}>
          <RefreshCw size={13} aria-hidden /> Restart now
        </button>
        <button type="button" onClick={() => void updater.cancelCountdown?.()} className={quiet}>
          Not now
        </button>
      </Card>
    );
  }

  const dismissNote = (key: string) => { void updater.dismissNote?.(); setNoteDismissed(key); };
  const failed = s.installFailed;
  const fetching = s.status === "checking" || s.status === "available" || s.status === "downloading";
  if (failed && noteDismissed !== `failed:${failed.version}`) {
    return (
      <Card docked={docked} icon={CircleAlert} title={`${failed.version} didn’t install`} line="RealBud reopened on the version you had." onDismiss={() => dismissNote(`failed:${failed.version}`)}>
        {/* Main checks, downloads and installs by itself; while it fetches, say so instead of a dead button. */}
        {fetching ? (
          <span className="flex min-h-11 flex-1 items-center gap-1.5 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" aria-hidden /> Getting {s.version ?? failed.version}…
            {typeof s.percent === "number" ? <span className="tabular-nums" aria-hidden>{Math.round(s.percent)}%</span> : null}
          </span>
        ) : (
          <button type="button" onClick={installNow} className={primary}>
            <RefreshCw size={13} aria-hidden /> Try again
          </button>
        )}
        <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className={link}>Download from realbud.app</a>
      </Card>
    );
  }

  const key = [s.status, s.version ?? "", s.deferred ?? "", restart?.required ? "required" : ""].join(":");
  if (s.status === "downloaded" && dismissed !== key) {
    return (
      <Card docked={docked} icon={RefreshCw} title={`${version} is ready`} line={updateReadyLine(s)} onDismiss={() => setDismissed(key)}>
        <button type="button" onClick={installNow} className={primary}>
          <RefreshCw size={13} aria-hidden /> Restart now
        </button>
        {restart?.required ? null : (
          <button type="button" onClick={() => void holdLater(key)} className={quiet}>
            Later
          </button>
        )}
      </Card>
    );
  }
  if (s.status === "error" && dismissed !== key) {
    return (
      <Card docked={docked} icon={CircleAlert} title="Update failed" line={friendlyError(s.message)} onDismiss={() => setDismissed(key)}>
        <button type="button" onClick={() => void updater.check()} className={primary}>
          <RefreshCw size={13} aria-hidden /> Try again
        </button>
      </Card>
    );
  }

  const updated = s.updatedFrom;
  if (updated && noteDismissed !== `updated:${updated.to}`) {
    const notes = releaseNotesUrl(updated.to);
    return (
      <Card
        docked={docked}
        icon={CircleCheck}
        title={`Updated to ${updated.to}`}
        line={notes ? <a href={notes} target="_blank" rel="noreferrer" className="text-agency underline">What’s new</a> : undefined}
        onDismiss={() => dismissNote(`updated:${updated.to}`)}
      />
    );
  }
  return null;
}
