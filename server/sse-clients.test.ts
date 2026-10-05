import type { ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SSE_CLIENT_BACKLOG_LIMIT, sendToSseClients } from "./sse-clients.ts";

describe("sendToSseClients", () => {
  it("drops a client that stopped reading and keeps serving a healthy one", () => {
    const stalled = new Writable({ write() {} });
    const healthy = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const clients = new Set([stalled, healthy] as unknown as ServerResponse[]);
    const frame = `data: ${JSON.stringify({ kind: "message", text: "x".repeat(256 * 1024) })}\n\n`;
    for (let i = 0; i < 300; i++) sendToSseClients(clients, frame);
    expect(stalled.writableLength).toBeLessThanOrEqual(SSE_CLIENT_BACKLOG_LIMIT + frame.length);
    expect(clients.has(stalled as unknown as ServerResponse)).toBe(false);
    expect(stalled.destroyed).toBe(true);
    expect(clients.has(healthy as unknown as ServerResponse)).toBe(true);
    expect(healthy.destroyed).toBe(false);
  });
});
