/** Public settings links must reveal their containing disclosures before scrolling. */
export function youHashTarget(hash: string): string | null {
  switch (hash.replace(/^#/, "")) {
    case "you-worker":
    case "attach-model": return "you-worker";
    case "you-recovery": return "you-recovery";
    case "you-private-backup": return "you-private-backup";
    case "you-packs": return "you-packs";
    case "you-jobs": return "you-jobs";
    case "connected-apps":
    case "you-connected-apps": return "you-connected-apps";
    case "you-phone": return "you-phone";
    case "you-office": return "you-office";
    case "you-website": return "you-website";
    case "you-browser": return "you-browser";
    case "you-profile": return "you-profile";
    case "you-advanced": return "you-advanced";
    case "you-service-admin": return "you-service-admin";
    default: return null;
  }
}

export type YouRecoveryTarget = 'you-recovery' | 'you-private-backup';

/** Saved recovery reopens keys unless the operator explicitly chose backup restore. */
export function youRecoveryTarget(hash: string): YouRecoveryTarget {
  return youHashTarget(hash) === 'you-private-backup' ? 'you-private-backup' : 'you-recovery';
}

export function revealSettingsTarget(target: HTMLElement): void {
  let element: HTMLElement | null = target;
  while (element) {
    if (element.tagName === "DETAILS") (element as HTMLDetailsElement).open = true;
    element = element.parentElement;
  }
}

/** Scroll a You-page section into view, opening any parent disclosures first. */
export function scrollYouTarget(id: string): void {
  const target = document.getElementById(id);
  const scroller = document.querySelector<HTMLElement>("[data-you-scroll]");
  if (!target || !scroller) return;
  revealSettingsTarget(target);
  const scrollerTop = scroller.getBoundingClientRect().top;
  const navigation = scroller.querySelector<HTMLElement>('[aria-label="Jump to a settings group"]');
  const stickyHeight = navigation ? Math.max(0, navigation.getBoundingClientRect().bottom - scrollerTop) : 0;
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scrollerTop - stickyHeight - 8;
  scroller.scrollTo({
    top: Math.max(0, top),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  if (id === "you-website" || id === "you-private-backup") target.focus({ preventScroll: true });
}
