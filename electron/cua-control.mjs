import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Private parent-to-server control channel. Never mounted as an agent tool,
 * never exposed to the renderer, and all desktop operations are serialized. */
export async function startCuaControl({ release, verify, restore }) {
  const token = randomBytes(32).toString("hex");
  let queue = Promise.resolve();
  const serialize = fn => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    if (req.method !== "POST" || req.headers.origin || typeof auth !== "string" || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return reply(403, { error: "refused" });
    try {
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) return reply(413, { error: "too large" }); }
      const input = JSON.parse(body || "{}");
      if (req.url === "/release") { await serialize(release); return reply(200, { released: true }); }
      if (req.url === "/restore" && restore) { await serialize(restore); return reply(200, { restored: true }); }
      if (req.url === "/verify") {
        // The server supplies a previously saved binding; Continue bodies do
        // not control this endpoint. Still validate the native boundary.
        const b = input.binding;
        if (!b || b.version !== 1 || !Number.isSafeInteger(b.pid) || b.pid < 1 || !Number.isSafeInteger(b.windowId) || b.windowId < 1 || typeof b.origin !== "string" || new URL(b.origin).origin !== b.origin || !b.origin.startsWith("https://") || [b.accountMarker, b.readyMarker].some(s => typeof s !== "string" || s.length < 4 || s.length > 120) || typeof input.requestId !== "string" || !/^[\w:-]{1,180}$/.test(input.requestId)) return reply(400, { error: "invalid binding" });
        const verified = await serialize(() => verify(b, input.requestId));
        return reply(200, { verified: verified === true });
      }
      reply(404, { error: "unknown action" });
    } catch { reply(503, { error: "Computer control needs recovery." }); }
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  return { env: { REALBUD_CUA_CONTROL_URL: `http://127.0.0.1:${port}`, REALBUD_CUA_CONTROL_TOKEN: token }, close: () => new Promise(resolve => server.close(resolve)) };
}
