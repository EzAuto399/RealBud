/** You first-paint rules. A practice book that is already on Desk is the job,
 * not a Verify-book shout. Live balances still wait on a PMS export. */

export function youShowsVerifyHero(input: {
  workerReady: boolean;
  recoveryAttention: boolean;
  deskMode?: string | null;
  propertyCount: number;
}): boolean {
  if (input.recoveryAttention) return true;
  if (!input.workerReady) return true;
  if (input.deskMode === "live") return false;
  return input.propertyCount === 0;
}

export function youShowsConnections(input: {
  essentialsReady: boolean;
  linkedReady: number;
  peek?: string | null;
  workerReady: boolean;
  recoveryAttention: boolean;
  propertyCount: number;
}): boolean {
  if (input.essentialsReady || input.linkedReady > 0) return true;
  if (input.peek === "connections" || input.peek === "desktop-reminders" || input.peek === "composio-account" || input.peek === "computer-use") {
    return true;
  }
  return input.workerReady && !input.recoveryAttention && input.propertyCount > 0;
}

export function youLeadCopy(input: {
  workerReady: boolean;
  recoveryAttention: boolean;
  deskMode?: string | null;
  propertyCount: number;
}): string {
  if (input.recoveryAttention) return "Recovery owns the next step. Desk stays readable.";
  if (!input.workerReady) return "Finish setup first. The rest of You waits.";
  if (input.deskMode === "live") return "Agency, connections and recovery.";
  if (input.propertyCount > 0) {
    return "Practice book is on Desk. Import a current PMS export when you want live balances.";
  }
  return "Import a current PMS export to put the live book on Desk.";
}
