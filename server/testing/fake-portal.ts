// Local fake building portal for the Stage 0 spike and E2E.
// Bud may read and prefill. The final POST /submit must stay zero unless
// a human (or test double) clicks it after handoff.
import { createServer, type Server } from "node:http";

export interface FakePortalLog {
  method: string;
  path: string;
  actor: "bud" | "human" | "unknown";
}

export interface FakePortal {
  url: string;
  submitCount: () => number;
  prefillCount: () => number;
  log: FakePortalLog[];
  close: () => Promise<void>;
  state: {
    ledger: { rentLanded: boolean; levyPaid: boolean };
    prefill: string | null;
    submitted: string | null;
    revoked: boolean;
  };
}

export function startFakePortal(port = 0): Promise<FakePortal> {
  const state = {
    ledger: { rentLanded: false, levyPaid: false },
    prefill: null as string | null,
    submitted: null as string | null,
    revoked: false,
  };
  const log: FakePortalLog[] = [];
  let submits = 0;
  let prefills = 0;

  const actorOf = (req: { headers: { [k: string]: string | string[] | undefined } }): FakePortalLog["actor"] => {
    const raw = req.headers["x-realbud-actor"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === "bud" || value === "human") return value;
    return "unknown";
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const actor = actorOf(req);
    log.push({ method: req.method ?? "GET", path: url.pathname, actor });

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/ledger") {
      return json(200, { ...state.ledger, prefill: state.prefill, submitted: state.submitted });
    }
    if (req.method === "POST" && url.pathname === "/prefill") {
      if (state.revoked && actor === "bud") return json(403, { error: "bud control revoked" });
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}") as { body?: string };
          state.prefill = String(parsed.body ?? "");
          prefills += 1;
          json(200, { ok: true, prefill: state.prefill });
        } catch {
          json(400, { error: "invalid JSON" });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      state.revoked = true;
      return json(200, { ok: true, revoked: true });
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      if (actor === "bud") return json(403, { error: "Bud must not submit" });
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.submitted = body || state.prefill;
        submits += 1;
        json(200, { ok: true, receipt: "reminder-queued" });
      });
      return;
    }
    json(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        submitCount: () => submits,
        prefillCount: () => prefills,
        log,
        state,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
