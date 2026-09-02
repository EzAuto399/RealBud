// Auto-update popup — a small card floating bottom-left, driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge)
// and while idle/checking; appears only when actionable: an update to
// download, a download in progress, a restart to apply, or an error.
import { useState } from "react";
import { ArrowDownToLine, CircleAlert, RefreshCw, Sparkles, X } from "lucide-react";
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
  if (!s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  if (dismissed === key) return null;
  const updater = window.ogb!.updater!;

  const title =
    s.status === "available"
      ? `RealBud ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : s.status === "downloaded"
          ? `${s.version} is ready`
          : "Update check failed";
  const subtitle =
    s.status === "available"
      ? "A newer version is ready to download."
      : s.status === "downloading"
        ? `Downloading ${Math.round(s.percent ?? 0)}%`
        : s.status === "downloaded"
          ? "Restart to finish updating."
          : friendlyError(s.message);
  const StatusIcon =
    s.status === "available"
      ? Sparkles
      : s.status === "downloading"
        ? ArrowDownToLine
        : s.status === "downloaded"
          ? RefreshCw
          : CircleAlert;

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
          <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {s.status !== "downloading" && (
          <button
            type="button"
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Dismiss"
            aria-label="Dismiss update notice"
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${Math.min(100, Math.max(0, s.percent ?? 0))}%` }}
          />
        </div>
      )}

      {s.status !== "downloading" && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              type="button"
              onClick={() => void updater.download()}
              className="pm-control flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-3 text-[13px] font-medium text-white"
            >
              <ArrowDownToLine size={13} aria-hidden /> Download
            </button>
          )}
          {s.status === "downloaded" && (
            <button
              type="button"
              onClick={() => void updater.install()}
              className="pm-control flex flex-1 items-center justify-center gap-1.5 rounded bg-accent px-3 text-[13px] font-medium text-white"
            >
              <RefreshCw size={13} aria-hidden /> Restart to update
            </button>
          )}
          {s.status === "error" && (
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
      )}
    </div>
  );
}
