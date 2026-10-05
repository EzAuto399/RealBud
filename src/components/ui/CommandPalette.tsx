import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";
import { cn } from "@/lib/cn";

/** Fixed display order; a group with no matches is not rendered. */
export const PALETTE_GROUPS = ["Desk tasks", "Properties", "Saved views", "Work threads", "Actions"] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** Kinds that move money, bind the office or reach someone outside it. */
export const GUARDED_KINDS = ["pay", "sign", "send", "notice"] as const;
export type GuardedKind = (typeof GUARDED_KINDS)[number];

type PaletteBase = { id: string; group: PaletteGroup; label: string; hint?: string; keywords?: string };

/**
 * A palette entry. Pay/sign/send/notice entries can never run from here: their
 * type has no `onSelect`, only `onOpenCase`, which must open the case where the
 * per-instance approval (actual recipient, amount or content) and Stop live.
 * The palette is a way to find things, never a shortcut past approval.
 */
export type PaletteItem =
  | (PaletteBase & { kind?: "go"; onSelect: () => void; onOpenCase?: never })
  | (PaletteBase & { kind: GuardedKind; onOpenCase: () => void; onSelect?: never });

export function isGuarded(item: PaletteItem): item is Extract<PaletteItem, { kind: GuardedKind }> {
  return (GUARDED_KINDS as readonly string[]).includes(item.kind ?? "");
}

/** Runs the item's only permitted effect: open for guarded kinds, select otherwise. */
export function activatePaletteItem(item: PaletteItem) {
  if (isGuarded(item)) item.onOpenCase();
  else item.onSelect();
}

/** Case-insensitive match on every word, returned grouped in PALETTE_GROUPS order. */
export function filterPaletteItems(items: readonly PaletteItem[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = items.filter(item => {
    const text = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""} ${item.group}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
  return PALETTE_GROUPS.map(group => ({ group, items: hits.filter(item => item.group === group) })).filter(section => section.items.length > 0);
}

/** Arrow/Home/End movement over a flat list, wrapping at the ends. */
export function movePaletteIndex(current: number, key: string, length: number) {
  if (length === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % length;
  if (key === "ArrowUp") return current < 0 ? length - 1 : (current - 1 + length) % length;
  return current;
}

export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: readonly PaletteItem[] }) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} items={items} />;
}

function PaletteDialog({ onClose, items }: { onClose: () => void; items: readonly PaletteItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useDialogKeyboard(ref, onClose);
  const sections = useMemo(() => filterPaletteItems(items, query), [items, query]);
  const flat = sections.flatMap(section => section.items);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const listId = `${baseId}-list`;

  const choose = (item: PaletteItem) => { onClose(); activatePaletteItem(item); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(movePaletteIndex(activeIndex, event.key, flat.length));
    } else if (event.key === "Enter" && flat[activeIndex]) {
      event.preventDefault();
      choose(flat[activeIndex]);
    }
  };

  let index = -1;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 px-4 pt-[12vh] transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Find or do"
        tabIndex={-1}
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-lg transition-[opacity,transform] duration-150 starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 shrink-0 text-ink-muted" aria-hidden />
          <input
            data-dialog-autofocus
            role="combobox"
            aria-label="Find or do"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Find a task, property, view or thread"
            className="pm-control min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-muted"
            value={query}
            onChange={event => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
          />
          <button type="button" aria-label="Close" className="pm-control flex min-w-11 items-center justify-center rounded-md text-ink-muted hover:bg-raised" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto p-1.5">
          {sections.map(section => (
            <div key={section.group} role="group" aria-labelledby={`${baseId}-${section.group}`}>
              <div id={`${baseId}-${section.group}`} className="px-2.5 pb-1 pt-2 text-[12px] font-medium text-ink-muted">{section.group}</div>
              {section.items.map(item => {
                index += 1;
                const at = index, selected = at === activeIndex, guarded = isGuarded(item);
                return (
                  <div
                    key={item.id}
                    id={optionId(at)}
                    role="option"
                    aria-selected={selected}
                    className={cn("pm-control flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 text-[14px] text-ink", selected && "bg-selected")}
                    onMouseDown={event => event.preventDefault()}
                    onMouseMove={() => { if (!selected) setActive(at); }}
                    onClick={() => choose(item)}
                  >
                    <span className="min-w-0 truncate">{item.label}</span>
                    {(item.hint || guarded) && <span className="shrink-0 text-[12px] text-ink-muted">{guarded ? "Open case to review" : item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <p role="status" className="px-2.5 py-6 text-center text-[14px] text-ink-muted">Nothing matches “{query}”.</p>}
        </div>
      </div>
    </div>
  );
}
