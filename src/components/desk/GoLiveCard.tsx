import { useState } from "react";

import { goLiveComplete, goLiveRows, type GoLiveRow } from "@/lib/go-live";

export function GoLiveCard({
  mode,
  agencyName,
  workerReady,
  onConnectExport,
  onAttachWorker,
  onSaveAgency,
}: {
  mode: "demo" | "live";
  agencyName: string;
  workerReady: boolean;
  onConnectExport: () => void;
  onAttachWorker?: () => void;
  onSaveAgency: (name: string) => void;
}) {
  const rows = goLiveRows({ mode, agencyName, workerReady });
  const [name, setName] = useState("");
  if (goLiveComplete(rows)) return null;

  return (
    <section className="mt-3 rounded-lg border border-line bg-sheet px-3.5 py-3" aria-label="Go live">
      <div className="text-[13px] font-medium text-ink">Go live</div>
      <p className="mt-0.5 text-[12px] text-ink-muted">Three steps. Desk already works on the sample book.</p>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <GoLiveRowView
            key={row.id}
            row={row}
            name={name}
            onName={setName}
            onConnectExport={onConnectExport}
            onAttachWorker={onAttachWorker}
            onSaveAgency={onSaveAgency}
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
  onSaveAgency,
}: {
  row: GoLiveRow;
  name: string;
  onName: (value: string) => void;
  onConnectExport: () => void;
  onAttachWorker?: () => void;
  onSaveAgency: (name: string) => void;
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
        {row.id === "agency" && row.state === "action" ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
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
          Open Book
        </button>
      ) : null}
      {row.state === "action" && row.id === "worker" && onAttachWorker ? (
        <button type="button" onClick={onAttachWorker} className="text-[12px] text-agency hover:underline">
          Open You
        </button>
      ) : null}
    </li>
  );
}
