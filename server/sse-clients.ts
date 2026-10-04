import type { ServerResponse } from "node:http";

/** Unsent bytes after which a live-events client counts as stalled. */
export const SSE_CLIENT_BACKLOG_LIMIT = 8 * 2 ** 20;

/** Writes one frame to every client. A client that has stopped reading is
 * dropped and its connection closed, so its buffer cannot grow without bound;
 * the app reconnects and reloads (hello snapshot + full state). Other clients
 * are never held back by a slow one. */
export function sendToSseClients(clients: Set<ServerResponse>, frame: string): void {
  for (const res of [...clients]) {
    try {
      if (res.writableLength > SSE_CLIENT_BACKLOG_LIMIT) {
        clients.delete(res);
        res.destroy();
        continue;
      }
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}
