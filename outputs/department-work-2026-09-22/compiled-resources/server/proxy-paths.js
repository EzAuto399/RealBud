// Where the server's own files live at runtime, and the one place a spawned
// proxy's path is worked out.
//
// Must not be resolved relative to the module that happens to need it.
// esbuild inlines modules into an entry bundle, so a `".."` written inside
// drivers/claude.ts starts climbing from the bundle directory. That shipped
// into OpenMausBot 0.1.24 and broke permission prompting + computer use
// while /api/health stayed green.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** server/ in dev, Resources/server in the packaged app. */
export const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));
/** .ts in dev, where node strips types; the compiled sibling once packaged. */
export function resolveProxy(relative) {
    const source = join(SERVER_ROOT, `${relative}.ts`);
    return existsSync(source) ? source : join(SERVER_ROOT, `${relative}.js`);
}
/** Every file this tree actually spawns as its own process. */
export const SPAWNED_PROXIES = {
    computer: resolveProxy("computer-proxy"),
    permission: resolveProxy("permission-proxy"),
    containerMcp: resolveProxy("container-mcp"),
    agents: resolveProxy("drivers/agents-proxy"),
};
