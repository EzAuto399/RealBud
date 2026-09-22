import { CopyButton } from "./CopyButton";

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-sheet p-4">
      {title && <h3 className="text-[15px] font-medium text-ink">{title}</h3>}
      {subtitle && <div className={title ? "mt-0.5 text-[13px] leading-relaxed text-ink-secondary" : "text-[13px] leading-relaxed text-ink-secondary"}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** A command with the same copy feedback as conversation and phone setup. */
export function CommandLine({ command }: { command: string }) {
  return <div className="flex flex-wrap items-center gap-2 rounded-lg bg-inset px-3 py-2">
    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">{command}</code>
    <CopyButton text={command} label="Copy command" />
  </div>;
}
