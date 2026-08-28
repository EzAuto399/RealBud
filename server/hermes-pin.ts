// Hermes is a pinned worker, not a floating latest and not our product name.
// Bump this object when we choose to take an upstream release. Do not track main.
export const HERMES_PIN = {
  product: "0.20.3",
  tag: "v2026.8.16.2",
  commit: "7339f5f160db5c96657a3bab60151227cc61f66c",
  released: "2026-08-17",
  repo: "https://github.com/NousResearch/hermes-agent",
  /** Isolated from the user's personal Hermes profile. */
  profile: "property",
} as const;

export function hermesInstallCommand(platform: NodeJS.Platform): string | null {
  if (platform === "win32") return null;
  return (
    // Fetch the installer from the same immutable checkout as the engine.
    // A floating bootstrap script could otherwise change host behaviour even
    // though the repository is checked out at our commit afterwards.
    `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_PIN.commit}/scripts/install.sh | bash -s -- ` +
    `--commit ${HERMES_PIN.commit} --force-commit ` +
    // RealBud owns onboarding, the bounded Cua/browser authority and the
    // property skill pack. Upstream's browser bootstrap can hang on a large
    // Chromium extraction, and its Cua bootstrap writes to /Applications;
    // neither may decide host state behind RealBud's UI.
    `--skip-setup --skip-browser --skip-computer-use --no-skills`
  );
}

/** `hermes --version` prints e.g. "Hermes Agent v0.20.3 (2026.8.16.2)". */
export function parseHermesVersion(text: string): { product?: string; calendar?: string } {
  const product = text.match(/\bv(\d+\.\d+\.\d+)\b/)?.[1];
  const calendar = text.match(/\((\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?)\)/)?.[1];
  return { product, calendar };
}

export function hermesMatchesPin(versionText: string): boolean {
  const parsed = parseHermesVersion(versionText);
  return parsed.product === HERMES_PIN.product || parsed.calendar === HERMES_PIN.tag.slice(1);
}
