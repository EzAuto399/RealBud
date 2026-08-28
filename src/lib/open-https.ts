/** Only https leaves this window. Never navigate RealBud itself. */
export function isHttpsUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (!url.startsWith("https://")) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function openHttpsUrl(url: string): boolean {
  if (!isHttpsUrl(url)) return false;
  if (typeof window !== "undefined" && typeof window.ogb?.openExternal === "function") {
    void window.ogb.openExternal(url);
    return true;
  }
  if (typeof window === "undefined" || typeof window.open !== "function") return false;
  return Boolean(window.open(url, "_blank", "noopener,noreferrer"));
}
