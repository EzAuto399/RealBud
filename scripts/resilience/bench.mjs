#!/usr/bin/env node
// Resilience performance measurements (ASTRA-RESILIENCE section 2) on a marked
// disposable root. Prints one JSON result; measures, never asserts a target.
//
//   ~/.nvm/versions/node/v24.21.0/bin/node scripts/resilience/bench.mjs native-log [--events 50000]
//   ~/.nvm/versions/node/v24.21.0/bin/node scripts/resilience/bench.mjs app-discovery   (reports why it is skipped)
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { markedRoot, removeRoot, sleep } from "./lib.mjs";

const [mode, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? Number(rest[i + 1]) : fallback; };
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function nativeLog(events) {
  const root = markedRoot("realbud-bench-");
  try {
    process.env.REALBUD_DATA_DIR = join(root, "data");
    const { NATIVE_DIR } = await import("../../server/config.ts");
    mkdirSync(NATIVE_DIR, { recursive: true });
    const { appendNative } = await import("../../server/drivers/native.ts");
    const thread = "bench-thread";
    // A typical streamed ACP chunk, fictional text.
    const msg = { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fictional streamed words ".repeat(8) } } } };
    const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
    const calls = new Float64Array(events);
    const t = performance.now();
    // Yield every 100 events, as a live ACP stream would between socket reads,
    // so the loop-delay histogram sees the synchronous append blocking.
    for (let i = 0; i < events; i++) {
      const s = performance.now();
      appendNative(thread, { dir: i % 2 ? "in" : "out", source: "acp", msg });
      calls[i] = performance.now() - s;
      if (i % 100 === 99) await new Promise((r) => setImmediate(r));
    }
    const elapsedMs = performance.now() - t;
    await sleep(20); loop.disable();
    const sorted = Array.from(calls).sort((a, b) => a - b);
    return {
      mode: "native-log", events, elapsedMs: Math.round(elapsedMs), eventsPerSecond: Math.round(events / (elapsedMs / 1000)),
      appendMicros: { p50: Math.round(pct(sorted, 0.5) * 1000), p95: Math.round(pct(sorted, 0.95) * 1000), max: Math.round(sorted.at(-1) * 1000) },
      eventLoopDelayMs: { p95: +(loop.percentile(95) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2) },
      queueBytes: 0, queueNote: "appendFileSync per event; there is no queue to measure",
      retainedDiskBytes: statSync(join(NATIVE_DIR, `${thread}.ndjson`)).size, rotation: "none (file grows without bound)",
    };
  } finally { removeRoot(root); }
}

const modes = {
  "native-log": () => nativeLog(flag("--events", 50000)),
  "app-discovery": async () => ({ mode: "app-discovery", skipped: true, reason: "Cold discovery lives in ManagedConnectors.compositeTransport (managed-gateway/connectors.ts), a private method that needs a gateway device, entitlement, registry and app adapter fixture. Not cheap to drive in isolation; add a seam or a dedicated gateway fixture first." }),
};
if (!modes[mode]) { console.error(`usage: bench.mjs ${Object.keys(modes).join("|")} [--events N]`); process.exit(2); }
console.log(JSON.stringify(await modes[mode](), null, 2));
