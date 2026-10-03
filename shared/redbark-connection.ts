/** The Redbark bank feed preset for the generic connector layer
 * (`shared/mcp-connector.ts`). Bud can only read accounts and transactions
 * through it. */

export const REDBARK_CONNECTOR_ID = 'redbark';
export const REDBARK_LABEL = 'Bank feed (Redbark)';
export const REDBARK_MCP_URL = 'https://mcp.redbark.com/mcp';
/** Redbark's authorization server, as its protected-resource metadata names it. */
export const REDBARK_AUTH_ORIGIN = 'https://app.redbark.com';

/** Read-only scopes requested from Redbark. Redbark's API v2 OpenAPI marks
 * `/accounts`, `/transactions` and `/accounts/{account}/balance` as
 * `x-redbark-scope: data:read`; `mcp:read` is the MCP server's own read scope.
 * No `*:write`, connection, sync, rule or category scope is ever requested. */
export const REDBARK_SCOPES = ['mcp:read', 'data:read'] as const;
