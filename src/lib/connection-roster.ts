import {
  CONNECTION_DISCOVERY_ITEMS,
  type ConnectionDiscoveryId,
} from "./connection-discovery";

export type ConnectionRosterTone = "ready" | "attention" | "off";

export interface ConnectionRosterRow {
  id: ConnectionDiscoveryId;
  label: string;
  common: boolean;
  status: string;
  tone: ConnectionRosterTone;
  href: string;
}

export interface ConnectionRosterInput {
  deskMode?: "demo" | "live" | null;
  deskRecovery?: boolean;
  sourceLabels?: ReadonlyArray<{ kind?: string; label?: string; stableKey?: string }>;
  pocketTelegram?: string;
  pocketWhatsapp?: string;
  computerUseAvailable?: boolean;
  remindersAvailable?: boolean;
  remindersOn?: boolean;
}

const ANCHORS: Record<ConnectionDiscoveryId, string> = {
  "property-book": "property-book",
  "inbound-mail-calendar": "inbound-mail-calendar",
  "advanced-work": "advanced-work",
  "computer-use": "computer-use-setup",
  "desktop-reminders": "desktop-reminders-setup",
  telegram: "telegram",
  "whatsapp-business": "whatsapp-business",
};

function pocketTone(state?: string): { status: string; tone: ConnectionRosterTone } {
  if (state === "ready") return { status: "Connected", tone: "ready" };
  if (state === "attention" || state === "connecting" || state === "setup-required") {
    return { status: state === "connecting" ? "Checking" : "Needs attention", tone: "attention" };
  }
  return { status: "Not connected", tone: "off" };
}

export function buildConnectionRoster(input: ConnectionRosterInput): ConnectionRosterRow[] {
  const recovery = Boolean(input.deskRecovery);
  const namedBook = input.sourceLabels?.find((source) => source.kind !== "mail" && source.label?.trim())?.label?.trim();
  const demoInbox = input.sourceLabels?.some((source) => source.kind === "mail" && source.stableKey === "demo:read-only-inbox");
  const book = recovery
    ? { status: "Recovery paused", tone: "attention" as const }
    : input.deskMode === "live"
      ? { status: namedBook ? `Connected · ${namedBook.slice(0, 40)}` : "Connected", tone: "ready" as const }
      : { status: "Practice · not live", tone: "off" as const };
  const inbox = demoInbox
    ? { status: "Demo only", tone: "off" as const }
    : { status: "Not connected", tone: "off" as const };
  const computer = input.computerUseAvailable
    ? { status: "Ready", tone: "ready" as const }
    : { status: "Not set up", tone: "off" as const };
  const reminders = !input.remindersAvailable
    ? { status: "Desktop app only", tone: "off" as const }
    : input.remindersOn
      ? { status: "On", tone: "ready" as const }
      : { status: "Off", tone: "off" as const };

  const statusById: Record<ConnectionDiscoveryId, { status: string; tone: ConnectionRosterTone }> = {
    "property-book": book,
    "inbound-mail-calendar": inbox,
    "advanced-work": { status: "Methods only", tone: "off" },
    "computer-use": computer,
    "desktop-reminders": reminders,
    telegram: pocketTone(input.pocketTelegram),
    "whatsapp-business": pocketTone(input.pocketWhatsapp),
  };

  return CONNECTION_DISCOVERY_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    common: Boolean(item.common),
    href: ANCHORS[item.id],
    ...statusById[item.id],
  }));
}

export function connectionRosterSummary(rows: readonly ConnectionRosterRow[]): {
  connected: number;
  attention: number;
  notYet: number;
} {
  return {
    connected: rows.filter((row) => row.tone === "ready").length,
    attention: rows.filter((row) => row.tone === "attention").length,
    notYet: rows.filter((row) => row.tone === "off").length,
  };
}

export function youConnectionsStatus(
  rows: readonly ConnectionRosterRow[],
  extras?: { linkedReady?: number },
): string {
  const linkedReady = extras?.linkedReady ?? 0;
  const common = rows.filter((row) => row.common);
  const connected = common.filter((row) => row.tone === "ready").length;
  if (connected === 0 && linkedReady === 0) {
    const book = common.find((row) => row.id === "property-book");
    return book?.status.startsWith("Practice") ? "Practice book" : "None connected";
  }
  if (connected === 0) {
    return linkedReady === 1 ? "1 linked tool" : `${linkedReady} linked tools`;
  }
  if (linkedReady > 0) {
    return `${connected} of ${common.length} common · ${linkedReady} linked`;
  }
  return `${connected} of ${common.length} common`;
}
