import { useState } from "react";
import { Cable, Check, ChevronDown } from "lucide-react";

import type { AskConnectionChoice } from "@shared/ask-actions";
import { COMMON_ASK_CONNECTION_IDS } from "@shared/ask-connections";
import { cn } from "@/lib/cn";
import { staggerMs } from "@/lib/motion";

function ConnectionOptionGrid({
  options,
  selectedId,
  disabled,
  startIndex,
  onChoose,
}: {
  options: readonly AskConnectionChoice[];
  selectedId?: string;
  disabled?: boolean;
  startIndex: number;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {options.map((option, index) => {
        const selected = option.id === selectedId;
        return (
          <button
            key={option.id}
            type="button"
            disabled={disabled || Boolean(selectedId)}
            onClick={() => onChoose(option.id)}
            className={cn(
              "animate-msg-in pm-tactile min-h-[4.5rem] border px-3 py-2.5 text-left",
              selected
                ? "border-agency bg-selected/55"
                : "border-line bg-sheet hover:border-agency/55 hover:bg-selected/35",
            )}
            style={{ animationDelay: `${staggerMs(startIndex + index)}ms` }}
          >
            <span className="flex items-start gap-2">
              <span className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded",
                selected ? "bg-agency text-white" : "bg-raised text-agency",
              )}>
                {selected ? <Check size={13} aria-hidden="true" /> : <Cable size={13} aria-hidden="true" />}
              </span>
              <span>
                <span className="block text-[12.5px] font-semibold text-ink">{option.label}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-muted">{option.detail}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AskConnectionPicker({
  options,
  selectedId,
  disabled,
  collapseMore = false,
  onChoose,
}: {
  options: readonly AskConnectionChoice[];
  selectedId?: string;
  disabled?: boolean;
  collapseMore?: boolean;
  onChoose: (id: string) => void;
}) {
  const common = options.filter((option) => COMMON_ASK_CONNECTION_IDS.has(option.id));
  const more = options.filter((option) => !COMMON_ASK_CONNECTION_IDS.has(option.id));
  const grouped = common.length > 0 && more.length > 0;
  const [moreOpen, setMoreOpen] = useState(!collapseMore);

  return (
    <div className="mt-3" role="group" aria-label="Office connections">
      {grouped ? (
        <>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Common for this office</p>
          <ConnectionOptionGrid
            options={common}
            selectedId={selectedId}
            disabled={disabled}
            startIndex={0}
            onChoose={onChoose}
          />
          {moreOpen ? (
            <>
              <p className="mt-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">More setup</p>
              <ConnectionOptionGrid
                options={more}
                selectedId={selectedId}
                disabled={disabled}
                startIndex={common.length}
                onChoose={onChoose}
              />
            </>
          ) : (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              className="pm-control pm-tactile mt-3 inline-flex min-h-10 items-center gap-1 text-[12.5px] font-medium text-agency hover:underline"
            >
              More office sources <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Pick one to open</p>
          <ConnectionOptionGrid
            options={options}
            selectedId={selectedId}
            disabled={disabled}
            startIndex={0}
            onChoose={onChoose}
          />
        </>
      )}
    </div>
  );
}
