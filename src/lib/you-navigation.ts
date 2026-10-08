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
    case "you-rules":
    case "you-approvals": return "you-approvals";
    case "you-phone": return "you-phone";
    case "you-office": return "you-office";
    case "you-website": return "you-website";
    // The link-code field itself, inside its disclosure (WebsiteLinkCard).
    case "you-website-code": return "you-website-code";
    case "you-browser": return "you-browser";
    case "you-profile": return "you-profile";
    case "you-advanced": return "you-advanced";
    case "you-service-admin": return "you-service-admin";
    case "you-memory": return "you-memory";
    case "you-settings": return "you-settings";
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

/** Scroll a Workspace section into view, opening any parent disclosures first. */
export function scrollYouTarget(id: string): void {
  // A linked or waiting computer shows no link-code field: land on its card instead.
  const target = document.getElementById(id) ?? (id === "you-website-code" ? document.getElementById("you-website") : null);
  const scroller = document.querySelector<HTMLElement>("[data-you-scroll]");
  if (!target || !scroller) return;
  revealSettingsTarget(target);
  const scrollerTop = scroller.getBoundingClientRect().top;
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scrollerTop - 8;
  scroller.scrollTo({
    top: Math.max(0, top),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  if (id === "you-website" || id === "you-website-code" || id === "you-private-backup") target.focus({ preventScroll: true });
}
