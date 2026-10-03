import type { ConnectedService } from '../shared/office-sources.ts';

type AuthorizationReason = 'unavailable' | 'not-admitted' | 'setup' | 'invalid-app' | 'rejected' | 'owner-required' | 'unknown';
const MESSAGES: Record<AuthorizationReason, string> = {
  unavailable: 'That app is not available to connect. Check the app’s name, or ask service support whether it can be added.',
  'not-admitted': 'This connection service has not enabled sign-in for that app. Ask service support to enable it.',
  setup: 'Managed connections need service setup for this private workspace.',
  'invalid-app': 'Name the app to connect, for example “connect Xero”.',
  rejected: 'The connection service rejected sign-in setup. Ask service support to check the app configuration before trying again.',
  'owner-required': 'The office owner must connect this shared mailbox. Check access after the owner finishes setup.',
  unknown: 'The sign-in result needs review. Check the current connection before starting another sign-in.',
};

/** Local fixed copy only. Neither provider prose nor a URL belongs in an error. */
export class ConnectionAuthorizationError extends Error {
  readonly outcome: 'not-started' | 'unknown';
  readonly reason: AuthorizationReason;
  readonly status: number;
  constructor(outcome: 'not-started' | 'unknown', reason: AuthorizationReason, status = 502) {
    super(MESSAGES[reason]);
    this.name = 'ConnectionAuthorizationError';
    this.outcome = outcome; this.reason = reason; this.status = status;
  }
}

/** These exact gateway codes are emitted before a link exists, or after a
 * definitive refusal. HTTP status alone cannot prove no remote effect. */
export function managedAuthorizationFailure(status: number, code?: string): ConnectionAuthorizationError {
  if (status === 404 && ['connector_app_unavailable', 'connector_toolkit_unknown', 'not_found'].includes(code ?? '')) return new ConnectionAuthorizationError('not-started', 'unavailable', status);
  if (status === 403 && code === 'connector_app_not_admitted') return new ConnectionAuthorizationError('not-started', 'not-admitted', status);
  if (status === 403 && code === 'office_mailbox_owner_authorization_required') return new ConnectionAuthorizationError('not-started', 'owner-required', status);
  if (status === 400 && code === 'connector_auth_config_rejected' || status === 502 && code === 'connector_link_rejected') return new ConnectionAuthorizationError('not-started', 'rejected', status);
  return new ConnectionAuthorizationError('unknown', 'unknown', status >= 400 && status < 500 ? status : 502);
}

export function connectionFailureReply(label: string, error: unknown, authorizationRequested: boolean): string {
  if (error instanceof ConnectionAuthorizationError && error.outcome === 'not-started') {
    return `Sign-in for ${label} did not start. ${error.message} No sign-in link was opened. After setup is resolved, ask **Connect ${label}** again.`;
  }
  return authorizationRequested
    ? `I couldn't confirm whether ${label} sign-in was created. Open **Connections → Apps** and check access before trying again. If it is still unconfirmed, ask service support to reconcile the existing attempt; don't start another sign-in yet.`
    : `I couldn't verify the ${label} connection. No new sign-in was started. Open **Connections → Apps**, check access and resolve any setup issue before trying again.`;
}

export function connectionCheckReply(label: string, service?: ConnectedService): string {
  const pending = /^(?:INITIATED|INITIALIZING|PENDING)$/i.test(service?.status ?? '') || service?.accounts.some(account => /^(?:INITIATED|INITIALIZING|PENDING)$/i.test(account.status));
  return pending
    ? `${label} has a pending sign-in. If you have its sign-in window or saved link, finish there, then check access in **Connections → Apps**. If neither is available, ask service support to reconcile the pending attempt before starting another.`
    : `${label} is not connected yet. This check did not start sign-in. Ask **Connect ${label}** to check connection availability and request a sign-in link.`;
}
