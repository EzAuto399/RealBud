// Receipts for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste becomes one row instead of
// flooding the composer; a file the PM chooses is staged, never scanned.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  attachmentsFromDroppedFiles,
  composerFileKind,
  formatSize,
  pasteSummary,
  type Attachment,
} from "@/lib/composer-attachments";

export type PendingComposerFile = {
  id: string;
  name: string;
  size: number;
  error?: string;
};

/** Electron 32 removed File.path — only the preload can name a file. */
function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

export function ComposerAttachments({
  items,
  pending = [],
  onAdd,
  onRemove,
  onBrowserFiles,
}: {
  items: Attachment[];
  pending?: readonly PendingComposerFile[];
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (id: string) => void;
  onBrowserFiles?: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    let active = true;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const { attachments, rejectedNames, browserFiles } = await attachmentsFromDroppedFiles(files, pathForFile);
      if (!active) return;
      if (attachments.length) onAdd(attachments);
      if (browserFiles.length) onBrowserFiles?.(browserFiles);
      setNotice(
        rejectedNames.length
          ? `${rejectedNames.join(", ")} — RealBud reviews a PDF, image, spreadsheet or text export you choose.`
          : null,
      );
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      active = false;
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAdd, onBrowserFiles]);

  const empty = items.length === 0 && pending.length === 0;

  return (
    <>
      {dragging && (
        <div className="pointer-events-none fixed inset-6 z-50 flex items-center justify-center">
          <div className="rounded-lg border border-dashed border-agency bg-sheet px-8 py-6 text-[14px] font-medium text-ink">
            Drop to attach — Bud reviews only what you choose
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-2 flex items-start gap-2 border border-hold/35 bg-hold/10 px-3 py-2 text-[12px] text-hold" role="status">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!empty && (
        <ul className="mb-2 divide-y divide-line border border-line bg-sheet" aria-label="Attached to this message">
          {pending.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-20 shrink-0 text-[12px] font-medium text-ink-muted">{composerFileKind(row.name)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.name}</span>
              <span className="shrink-0 text-[12px] text-ink-muted">
                {row.error ?? `Attaching · ${formatSize(row.size)}`}
              </span>
            </li>
          ))}
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-20 shrink-0 text-[12px] font-medium text-ink-muted">
                {item.kind === "paste" ? "Paste" : composerFileKind(item.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={item.kind === "file" ? item.path : undefined}>
                {item.kind === "paste" ? item.text.slice(0, 80).replace(/\s+/g, " ") : item.name}
              </span>
              <span className="shrink-0 text-[12px] text-ink-muted">
                {item.kind === "paste" ? pasteSummary(item) : formatSize(item.size)}
              </span>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="pm-control shrink-0 text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
