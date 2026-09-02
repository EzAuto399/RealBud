import { useEffect, useState } from "react";

import { goLiveActionCount, goLiveComplete, goLiveRows, type GoLiveRow } from "@/lib/go-live";

export function GoLiveCard({
  mode,
  agencyName,
  workerReady,
  compact = false,
  onConnectExport,
  onAttachWorker,
  attachWorkerLabel = "Open You",
  onSaveAgency,
  onNameAgency,
}: {
  mode: "demo" | "live";
  agencyName: string;
  workerReady: boolean;
  compact?: boolean;
  onConnectExport: () => void;
  onAttachWorker?: () => void;
  attachWorkerLabel?: string;
  onSaveAgency?: (name: string) => void;
  onNameAgency?: () => void;
}) {
  const rows = goLiveRows({ mode, agencyName, workerReady });
  const [name, setName] = useState("");
  const [open, setOpen] = useState(!compact);
  const left = goLiveActionCount(rows);

  useEffect(() => {
    if (compact) setOpen(false);
  }, [compact]);

  if (goLiveComplete(rows)) return null;

  if (compact && !open) {
    const waiting = rows
      .filter((row) => row.state === "action")
      .map((row) => (row.id === "agency" ? "agency name" : row.id === "worker" ? "Bud" : row.id));
    return (
      <section className="mt-3 border border-line bg-sheet px-3.5 py-2" aria-label="Go live">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-2 text-left text-[13px] text-ink"
        >
          <span>
            Go live · {left} left
            <span className="text-ink-muted"> · {waiting.join(", ") || "none"}. Desk already works.</span>
          </span>
          <span className="text-[12px] text-agency">Open</span>
        </button>
      </section>
    );
  }

  return (
    <section className="mt-3 rounded-lg border border-line bg-sheet px-3.5 py-3" aria-label="Go live">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-ink">Go live</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">Three steps when you are ready. The sample book already works on Desk.</p>
        </div>
        {compact ? (
          <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-muted hover:text-ink">
            Hide
          </button>
        ) : null}
      </div>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <GoLiveRowView
            key={row.id}
            row={row}
            name={name}
            onName={setName}
            onConnectExport={onConnectExport}
            onAttachWorker={onAttachWorker}
            attachWorkerLabel={attachWorkerLabel}
            onSaveAgency={onSaveAgency}
            onNameAgency={onNameAgency}
          />
        ))}
      </ul>
    </section>
  );
}

function GoLiveRowView({
  row,
  name,
  onName,
  onConnectExport,
  onAttachWorker,
  attachWorkerLabel,
  onSaveAgency,
  onNameAgency,
}: {
  row: GoLiveRow;
  name: string;
  onName: (value: string) => void;
  onConnectExport: () => void;
  onAttachWorker?: () => void;
  attachWorkerLabel: string;
  onSaveAgency?: (name: string) => void;
  onNameAgency?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 text-[12.5px]">
      <div className="min-w-0 flex-1">
        <div className="text-ink">
          <span className={row.state === "done" ? "text-agency" : "text-hold"}>{row.state === "done" ? "Done" : "Action"}</span>
          {" · "}
          {row.title}
        </div>
        <p className="text-ink-muted">{row.detail}</p>
        {row.id === "agency" && row.state === "action" && onNameAgency ? (
          <button type="button" onClick={onNameAgency} className="pm-control mt-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink">
            Name it on You
          </button>
        ) : null}
        {row.id === "agency" && row.state === "action" && !onNameAgency && onSaveAgency ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="go-live-agency">
              Agency name
            </label>
            <input
              id="go-live-agency"
              type="text"
              value={name}
              onChange={(event) => onName(event.target.value)}
              placeholder="Agency name"
              className="min-w-[12rem] flex-1 rounded border border-line bg-inset px-2 py-1.5 text-[13px] text-ink"
            />
            <button
              type="button"
              disabled={!name.trim()}
              onClick={() => onSaveAgency(name.trim())}
              className="rounded bg-agency px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        ) : null}
      </div>
      {row.state === "action" && row.id === "export" ? (
        <button type="button" onClick={onConnectExport} className="text-[12px] text-agency hover:underline">
          Open properties
        </button>
      ) : null}
      {row.state === "action" && row.id === "worker" && onAttachWorker ? (
        <button type="button" onClick={onAttachWorker} className="text-[12px] text-agency hover:underline">
          {attachWorkerLabel}
        </button>
      ) : null}
    </li>
  );
}
