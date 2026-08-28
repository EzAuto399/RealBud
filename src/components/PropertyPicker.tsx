import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import type { Property } from "@/lib/desk";
import { filterProperties } from "@/lib/property-search";
import { cn } from "@/lib/cn";

export function PropertyPicker({
  properties,
  value,
  onChange,
  disabled = false,
  dropUp = false,
}: {
  properties: readonly Property[];
  value: string;
  onChange: (propertyId: string) => void;
  disabled?: boolean;
  dropUp?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = properties.find((property) => property.id === value) ?? null;
  const matches = useMemo(() => filterProperties(properties, query), [properties, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = query ? -1 : matches.findIndex((property) => property.id === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, query, matches, value]);

  useEffect(() => {
    if (!open || !matches[activeIndex]) return;
    document.getElementById(`${listboxId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId, matches, open]);

  const openPicker = () => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const closePicker = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (property: Property) => {
    onChange(property.id);
    closePicker(true);
  };

  return (
    <div ref={rootRef} className="relative min-w-[16rem] flex-1">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`Choose property${selected ? `, current ${selected.address}` : ""}`}
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={(event) => {
          if (["ArrowDown", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            openPicker();
          }
        }}
        className="pm-control pm-tactile flex w-full items-center justify-between gap-2 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-left text-[13px] text-ink hover:border-hairline disabled:opacity-40"
      >
        <span className="truncate">{selected?.address ?? "Choose a property"}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-ink-muted transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          className={cn(
            "animate-pop-in absolute left-0 right-0 z-40 overflow-hidden rounded-lg border border-line bg-sheet shadow-xl",
            dropUp ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
          )}
        >
          <div className="relative border-b border-line p-2">
            <Search size={14} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              ref={searchRef}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={matches[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!matches.length) return;
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setActiveIndex((index) => (index + direction + matches.length) % matches.length);
                } else if (event.key === "Enter" && matches[activeIndex]) {
                  event.preventDefault();
                  choose(matches[activeIndex]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closePicker(true);
                } else if (event.key === "Tab") {
                  closePicker();
                }
              }}
              placeholder="Search address, tenant or property ID"
              aria-label="Search properties"
              className="pm-control w-full rounded-md border border-hairline/50 bg-inset py-1.5 pl-8 pr-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency"
            />
          </div>
          <div id={listboxId} role="listbox" aria-label="Properties" className="max-h-64 overflow-y-auto p-1">
            {matches.length ? (
              matches.map((property, index) => {
                const isSelected = property.id === value;
                const isActive = index === activeIndex;
                return (
                  <button
                    key={property.id}
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(property)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left",
                      isActive ? "bg-raised" : "hover:bg-raised/70",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{property.address}</span>
                      <span className="block truncate text-[12px] text-ink-muted">
                        {property.tenantName || property.id}
                      </span>
                    </span>
                    {isSelected ? <Check size={14} className="shrink-0 text-agency" /> : null}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-5 text-center text-[12px] text-ink-muted">No matching property</div>
            )}
          </div>
          <div className="border-t border-line px-3 py-1.5 text-[12px] text-ink-muted" aria-live="polite">
            {matches.length} of {properties.length} properties
          </div>
        </div>
      ) : null}
    </div>
  );
}
