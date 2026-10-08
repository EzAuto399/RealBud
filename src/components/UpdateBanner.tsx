// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Checking and downloading happen silently in the
// background, so it appears only when actionable: a restart to apply, or an
// error.
import { useState } from "react";
import { CircleAlert, RefreshCw, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";

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

export function UpdateBanner() {
  const s = useUpdaterState();
  // dismissal is per status+version, so the popup returns for the next
  // update (and when an available one finishes downloading)
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!s || (s.status !== "downloaded" && s.status !== "error")) return null;
  const key = `${s.status}:${s.version ?? ""}:${s.deferred ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  const ready = s.status === "downloaded";
  const title = ready ? `${s.version} is ready` : "Update failed";
  const subtitle = ready
    ? s.deferred && s.message ? s.message : "Restart to finish updating."
    : friendlyError(s.message);
  const StatusIcon = ready ? RefreshCw : CircleAlert;

  return (
    <div
      role="status"
      className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-lg border border-line bg-sheet p-3.5 shadow-lg"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <StatusIcon size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className={`mt-0.5 text-[12.5px] text-ink-secondary ${s.deferred ? "" : "truncate"}`} title={subtitle}>
            {subtitle}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Dismiss"
          aria-label="Dismiss update notice"
        >
          <X size={14} aria-hidden />
        </button>
      </div>

      <div className="mt-2.5 flex gap-2">
        {ready && (
          <button
            type="button"
            onClick={() => void updater.install()}
            className="pm-control flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-3 text-[13px] font-medium text-white"
          >
            <RefreshCw size={13} aria-hidden /> Restart to update
          </button>
        )}
        {!ready && (
          <button
            type="button"
            onClick={() => void updater.check()}
            className="pm-control flex flex-1 items-center justify-center gap-1.5 rounded bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover"
          >
            <RefreshCw size={13} aria-hidden /> Try again
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="pm-control rounded px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Later
        </button>
      </div>
    </div>
  );
}
