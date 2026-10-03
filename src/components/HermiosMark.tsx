/** The official Hermios icon, copied unchanged from the Hermios brand assets
 *  into `public/brand/`. Its own brand colours stay inside the image; nothing
 *  around it uses them. The icon is decorative: either the wordmark beside it
 *  or the caller's own visible text carries the name. */
export const HERMIOS_ICON_SRC = "/brand/hermios-icon.svg";

export function HermiosMark({ size = 20, wordmark = false, className = "" }: { size?: number; wordmark?: boolean; className?: string }) {
  const icon = (
    <img
      src={HERMIOS_ICON_SRC}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none ${wordmark ? "" : className}`.trim()}
    />
  );
  if (!wordmark) return icon;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      {icon}
      <span className="font-semibold text-ink">Hermios</span>
    </span>
  );
}
