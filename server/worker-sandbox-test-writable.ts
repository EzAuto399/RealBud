/** Test-only: extra writable roots for the fakes' evidence files. Honoured
 * only under vitest; production never reads it. A leaf module, so the vitest
 * setup that fills it loads nothing else: a module the setup imports is
 * cached before a test file's vi.mock (node:child_process, node:path) applies. */
export const SANDBOX_TEST_WRITABLE: string[] = [];
