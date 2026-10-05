// Loopback fakes for the chaos harness: a fictional Modelvia chat endpoint
// with scripted faults, and a TCP proxy that can sever the path to it.
// Every value here is fictional; nothing reaches a hosted service.
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";

export const FICTIONAL_MODELVIA_KEY = "fictional-chaos-office-key";

/**
 * Fake Modelvia. `mode` picks the next answers: ok | 429 | 401 | 503 | slow | stall.
 * Every request is counted with its auth and idempotency key so a case can
 * prove at most one upstream effect per worker request and no foreign key.
 */
export async function fakeModelvia() {
  const seen = [];
  const open = new Set();
  const state = { mode: "ok" };
  const server = createServer(async (req, res) => {
    open.add(res); res.once("close", () => open.delete(res));
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* counted as-is */ }
    seen.push({ at: Date.now(), method: req.method, path: req.url, auth: req.headers.authorization ?? null, idem: req.headers["idempotency-key"] ?? null, mode: state.mode, stream: body.stream === true });
    const json = (status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${FICTIONAL_MODELVIA_KEY}`) return json(401, { error: { code: "invalid_key" } });
    const frame = (text, done = false) => `data: ${JSON.stringify({ id: "fictional-chaos", model: body.model, choices: [{ index: 0, delta: done ? {} : { content: text }, finish_reason: done ? "stop" : null }] })}\n\n`;
    switch (state.mode) {
      case "429": return json(429, { error: { code: "rate_limited", message: "fictional throttle" } }, { "retry-after": "7" });
      case "401": return json(401, { error: { code: "invalid_key", message: "fictional rejected key" } });
      case "503": return json(503, { error: { code: "upstream_unavailable", message: "fictional outage" } });
      case "slow": case "stall": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame("first"));
        if (state.mode === "stall") return; // headers and one frame, then nothing until the client leaves
        for (const word of ["slow", "but", "steady"]) { await new Promise((r) => setTimeout(r, 800)); if (res.destroyed) return; res.write(frame(word)); }
        res.end(frame("", true) + "data: [DONE]\n\n");
        return;
      }
      default:
        if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(frame("OK") + frame("", true) + "data: [DONE]\n\n"); }
        return json(200, { id: "fictional-chaos", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return {
    port: server.address().port, seen, state,
    async close() { for (const r of open) r.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}

/** TCP proxy on loopback. `sever()` destroys live sockets and drops new ones; `restore()` heals. */
export async function severProxy(targetPort) {
  const sockets = new Set();
  let severed = false, dropped = 0;
  const server = net.createServer((client) => {
    if (severed) { dropped++; client.destroy(); return; }
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) { sockets.add(s); s.once("close", () => sockets.delete(s)); s.on("error", () => {}); }
    client.pipe(upstream); upstream.pipe(client);
    client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return {
    port: server.address().port,
    get dropped() { return dropped; },
    sever() { severed = true; for (const s of sockets) s.destroy(); },
    restore() { severed = false; },
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}
