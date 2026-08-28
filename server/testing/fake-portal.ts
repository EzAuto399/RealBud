// Local fake building portal for the Stage 0 spike and E2E.
// Bud may read and prefill. The final POST /submit must stay zero unless
// a human (or test double) clicks it after handoff.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 16 * 1024;

function readBoundedBody(req: IncomingMessage, res: ServerResponse, done: (body: string) => void): void {
  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += String(chunk);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) tooLarge = true;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "request body is too large" }));
      return;
    }
    done(body);
  });
}

function portalPage(actor: "bud" | "human", variant: string): string {
  const reordered = variant === "reordered";
  const delayed = variant === "delayed";
  const evidence = `
    <section class="panel" aria-labelledby="ledger-heading">
      <p class="eyebrow">Property</p>
      <h2 id="ledger-heading">12 Oak St, Dickson ACT</h2>
      <dl>
        <div><dt>Rent received</dt><dd id="rent-landed">Checking…</dd></div>
        <div><dt>Levy paid</dt><dd id="levy-paid">Checking…</dd></div>
      </dl>
    </section>`;
  const action = `
    <section class="panel" aria-labelledby="courtesy-heading">
      <p class="eyebrow">Approved case wording</p>
      <h2 id="courtesy-heading">Prepare courtesy reminder</h2>
      <label for="courtesy-body">Courtesy reminder</label>
      <textarea id="courtesy-body" rows="7" autocomplete="off"></textarea>
      <div class="actions">
        <button id="save-draft" type="button"${actor === "human" ? " disabled aria-disabled=\"true\"" : ""}>Save draft</button>
        <button id="submit-reminder" class="primary" type="button"${actor === "bud" ? " disabled aria-disabled=\"true\"" : ""}>Submit reminder</button>
      </div>
      <p id="portal-status" role="status" aria-live="polite">Loading portal state…</p>
    </section>`;
  const body = reordered
    ? `<aside class="notice">Portal update: navigation moved, but the task labels are unchanged.</aside>${action}${evidence}`
    : `${evidence}${action}`;
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fake Building Portal</title>
  <style>
    :root { color-scheme: light; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #25231f; background: #eeeae0; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 18px 24px; color: white; background: #315f91; }
    header p, h1, h2 { margin: 0; }
    header p { margin-top: 3px; opacity: .82; }
    main { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(360px, 1.2fr); gap: 16px; max-width: 980px; margin: 24px auto; padding: 0 20px; }
    .panel, .notice { border: 1px solid #d4ccbb; border-radius: 8px; background: #fffaf0; padding: 20px; }
    .notice { grid-column: 1 / -1; color: #514b42; }
    .eyebrow { margin: 0 0 5px; color: #6f695e; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em; }
    h1 { font-size: 22px; }
    h2 { font-size: 18px; }
    dl { margin: 18px 0 0; }
    dl div { display: flex; justify-content: space-between; border-top: 1px solid #d4ccbb; padding: 10px 0; }
    dd { margin: 0; font-weight: 650; }
    label { display: block; margin-top: 16px; font-weight: 650; }
    textarea { width: 100%; margin-top: 6px; border: 1px solid #a9a08f; border-radius: 4px; padding: 10px; color: inherit; background: white; font: inherit; resize: vertical; }
    textarea:focus, button:focus { outline: 3px solid rgba(49, 95, 145, .3); outline-offset: 2px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    button { min-height: 40px; border: 1px solid #a9a08f; border-radius: 4px; padding: 0 14px; color: #25231f; background: white; font: inherit; font-weight: 650; }
    button.primary { border-color: #315f91; color: white; background: #315f91; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    #portal-status { min-height: 22px; margin: 10px 0 0; color: #514b42; }
    @media (max-width: 720px) { main { grid-template-columns: 1fr; margin-top: 16px; } }
  </style>
</head>
<body>
  <header>
    <h1>Fake Building Portal</h1>
    <p>${actor === "bud" ? "Bud preparation session — Submit is locked" : "PM handoff — review before Submit"}</p>
  </header>
  <main id="portal-main" aria-busy="${delayed ? "true" : "false"}">${delayed ? "" : body}</main>
  <template id="delayed-content">${body}</template>
  <script>
    const actor = ${JSON.stringify(actor)};
    const delayed = ${JSON.stringify(delayed)};
    const main = document.querySelector("#portal-main");

    async function request(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { "content-type": "application/json", "x-realbud-actor": actor, ...(options.headers || {}) },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Portal request failed");
      return data;
    }

    async function bindPortal() {
      const field = document.querySelector("#courtesy-body");
      const save = document.querySelector("#save-draft");
      const submit = document.querySelector("#submit-reminder");
      const status = document.querySelector("#portal-status");
      try {
        const state = await request("/ledger", { method: "GET" });
        document.querySelector("#rent-landed").textContent = state.rentLanded ? "Yes" : "No";
        document.querySelector("#levy-paid").textContent = state.levyPaid ? "Yes" : "No";
        field.value = typeof state.prefill === "string" ? state.prefill : "";
        save.disabled = actor !== "bud" || state.revoked;
        submit.disabled = actor !== "human" || Boolean(state.submitted);
        status.textContent = state.submitted
          ? "Already submitted by the PM."
          : state.revoked && actor === "bud"
            ? "Preparation handed back to the PM. Bud can no longer edit or Submit."
            : actor === "bud"
              ? "Bud may save approved wording. Submit stays locked."
              : "Review the prefilled wording, then Submit yourself.";
      } catch (error) {
        status.textContent = error.message;
      }

      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await request("/prefill", { method: "POST", body: JSON.stringify({ body: field.value }) });
          status.textContent = "Draft saved. Submit is still yours.";
        } catch (error) {
          status.textContent = error.message;
        } finally {
          if (actor === "bud") save.disabled = false;
        }
      });

      submit.addEventListener("click", async () => {
        submit.disabled = true;
        try {
          await request("/submit", { method: "POST", body: JSON.stringify({ body: field.value }) });
          status.textContent = "Reminder queued by the portal.";
        } catch (error) {
          status.textContent = error.message;
          if (actor === "human") submit.disabled = false;
        }
      });
    }

    if (delayed) {
      setTimeout(() => {
        main.append(document.querySelector("#delayed-content").content.cloneNode(true));
        main.setAttribute("aria-busy", "false");
        bindPortal();
      }, 350);
    } else {
      bindPortal();
    }
  </script>
</body>
</html>`;
}

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

    if (req.method === "GET" && url.pathname === "/") {
      const pageActor = url.searchParams.get("actor") === "human" ? "human" : "bud";
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; connect-src 'self'; form-action 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      res.end(portalPage(pageActor, url.searchParams.get("variant") ?? "default"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/ledger") {
      return json(200, { ...state.ledger, prefill: state.prefill, submitted: state.submitted, revoked: state.revoked });
    }
    if (req.method === "POST" && url.pathname === "/prefill") {
      if (actor !== "bud") return json(403, { error: "only Bud may prepare this draft" });
      if (state.revoked) return json(403, { error: "bud control revoked" });
      readBoundedBody(req, res, (body) => {
        try {
          const parsed = JSON.parse(body || "{}") as { body?: string };
          const next = String(parsed.body ?? "");
          if (next.length > 4_000) return json(400, { error: "draft is too long" });
          state.prefill = next;
          prefills += 1;
          json(200, { ok: true, prefill: state.prefill });
        } catch {
          json(400, { error: "invalid JSON" });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      if (actor !== "human") return json(403, { error: "only the PM may take back control" });
      state.revoked = true;
      return json(200, { ok: true, revoked: true });
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      if (actor !== "human") return json(403, { error: "Bud must not submit" });
      if (state.submitted !== null) return json(409, { error: "reminder already submitted" });
      readBoundedBody(req, res, (body) => {
        try {
          const parsed = JSON.parse(body || "{}") as { body?: unknown };
          const submitted = typeof parsed.body === "string" ? parsed.body : state.prefill;
          if (!submitted) return json(400, { error: "nothing is ready to submit" });
          if (submitted.length > 4_000) return json(400, { error: "draft is too long" });
          state.submitted = submitted;
          submits += 1;
          json(200, { ok: true, receipt: "reminder-queued" });
        } catch {
          json(400, { error: "invalid JSON" });
        }
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
