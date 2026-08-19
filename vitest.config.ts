import { defineConfig } from "vitest/config";

// Coverage is opt-in (pnpm test:coverage) and measured over server/ only.
// server/index.ts and the modules it runs as child processes are exercised
// behaviorally by the spawned-server e2e tests (index/branching/comms) but
// cannot be measured in-process, so they are excluded from the thresholds.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["server/**"],
      exclude: [
        "server/**/*.test.ts",
        "server/testing/**",
        // child-process-only (measured by e2e behavior, not instrumentation)
        "server/index.ts",
        "server/composio.ts",
        "server/box.ts",
        "server/computer-proxy.ts",
        "server/container-mcp.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 60,
        branches: 45,
        functions: 60,
        lines: 62,
      },
    },
  },
});
