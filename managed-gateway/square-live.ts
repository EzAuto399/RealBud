/** Square-backed draft invoice helpers for operator/sandbox wiring. */
import { SquareBilling, type SquareEnvironment } from "./square.ts";
import { digest, type UsageLedger } from "./ledger.ts";
import type { PortalPrincipal } from "./contracts.ts";

export function createSquareBilling(options: {
  ledger: UsageLedger;
  accessToken: string;
  notificationUrl: string;
  signatureKey: string;
  fetchImpl?: typeof fetch;
  /** Which Square host to talk to. Defaults to production; pass 'sandbox'
   * explicitly so a sandbox token can never be aimed at the real account. */
  environment?: SquareEnvironment;
}): SquareBilling {
  return new SquareBilling({
    ledger: options.ledger,
    fetch: options.fetchImpl ?? fetch,
    secret: async () => options.accessToken,
    notificationUrl: options.notificationUrl,
    signatureKey: async () => options.signatureKey,
    environment: options.environment,
  });
}

/** Close a month, accept statement (owner), create Square DRAFT invoice. */
export async function squareDraftForPeriod(
  square: SquareBilling,
  actor: PortalPrincipal,
  period: string,
  careAgreementRef: string | null,
  dueDate: string,
) {
  const statement = square.closeStatement(
    actor.companyId,
    period,
    careAgreementRef,
  );
  square.accept(actor, statement.id, digest(statement));
  return square.createDraft(actor, statement.id, dueDate);
}
