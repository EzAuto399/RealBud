// Local bank portal fixture for read-only browser QA. It proves the login,
// bounded credit-list and forbidden-payment shape without touching a bank,
// network credential or personal browser profile.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_BODY_BYTES = 4 * 1024;
const SESSION_COOKIE = "fake_bank_session=read_only_fixture";

export const FAKE_BANK_LOGIN = { username: "pm-fixture", password: "not-a-secret" } as const;

export interface FakeBankCredit {
  bookedAt: number;
  amountCents: number;
  reference: string;
}

export interface FakeBankPortal {
  url: string;
  maskedAccount: string;
  credits: FakeBankCredit[];
  log: Array<{ method: string; path: string }>;
  transferAttempts: () => number;
  payeeAttempts: () => number;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage, res: ServerResponse, done: (body: string) => void): void {
  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    body += String(chunk);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) tooLarge = true;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request body is too large" }));
      return;
    }
    done(body);
  });
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2923; background: #edf1ed; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 18px 24px; color: white; background: #153f2c; }
    header h1, header p { margin: 0; }
    header p { margin-top: 3px; opacity: .78; }
    main { max-width: 900px; margin: 28px auto; padding: 0 20px; }
    .card { border: 1px solid #ccd5cd; border-radius: 9px; background: white; padding: 22px; box-shadow: 0 10px 24px rgba(21,63,44,.07); }
    label { display: block; margin-top: 12px; font-weight: 650; }
    input { width: 100%; min-height: 42px; margin-top: 5px; border: 1px solid #98a69b; border-radius: 5px; padding: 8px 10px; font: inherit; }
    button { min-height: 40px; border: 1px solid #2d6749; border-radius: 5px; padding: 0 14px; color: white; background: #2d6749; font: inherit; font-weight: 650; }
    button:disabled { border-color: #b5bdb7; color: #737d76; background: #e4e8e4; }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    .muted { color: #69736c; }
    table { width: 100%; margin-top: 16px; border-collapse: collapse; }
    th, td { border-top: 1px solid #d8ded9; padding: 11px 8px; text-align: left; }
    th:last-child, td:last-child { text-align: right; }
    #credit-list { margin-top: 18px; border: 1px solid #d8ded9; background: #f7f9f7; padding: 10px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header><h1>Fixture Bank</h1><p>Read-only RealBud test account</p></header>
  <main>${body}</main>
</body>
</html>`;
}

function loginPage(): string {
  return shell("Fixture Bank sign in", `
    <section class="card" aria-labelledby="login-heading">
      <h2 id="login-heading">Sign in to view account activity</h2>
      <p class="muted">In production, the PM completes sign-in and MFA in the isolated RealBud browser.</p>
      <label for="username">Customer ID</label><input id="username" autocomplete="username">
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password">
      <div class="actions"><button id="sign-in" type="button">Sign in</button></div>
      <p id="status" role="status" aria-live="polite"></p>
    </section>
    <script>
      document.querySelector("#sign-in").addEventListener("click", async () => {
        const status = document.querySelector("#status");
        const response = await fetch("/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: document.querySelector("#username").value,
            password: document.querySelector("#password").value,
          }),
        });
        if (!response.ok) { status.textContent = "Sign-in failed"; return; }
        location.assign("/activity");
      });
    </script>`);
}

function activityPage(maskedAccount: string, credits: FakeBankCredit[]): string {
  const rows = credits.map((credit) => `
    <tr><td>${new Date(credit.bookedAt).toISOString()}</td><td>${credit.reference}</td><td>$${(credit.amountCents / 100).toFixed(2)}</td></tr>`).join("");
  const machineRows = credits.map((credit) => `${new Date(credit.bookedAt).toISOString()}|${credit.amountCents}|${credit.reference}`).join("\n");
  return shell("Fixture Bank activity", `
    <section class="card" aria-labelledby="activity-heading">
      <p class="muted">Account ${maskedAccount}</p>
      <h2 id="activity-heading">Account activity</h2>
      <p>Credits from the last bounded observation window.</p>
      <table><thead><tr><th>Booked</th><th>Reference</th><th>Credit</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="actions" aria-label="Unavailable money controls">
        <button id="transfer-money" type="button" disabled aria-disabled="true">Transfer money</button>
        <button id="add-payee" type="button" disabled aria-disabled="true">Add payee</button>
      </div>
      <p class="muted">This RealBud session can observe this credit list only.</p>
      <pre id="credit-list" aria-label="Bounded credit observations">${machineRows}</pre>
    </section>`);
}

function authenticated(req: IncomingMessage): boolean {
  return String(req.headers.cookie ?? "").split(/;\s*/).includes(SESSION_COOKIE);
}

export function startFakeBankPortal(options: { port?: number; now?: number } = {}): Promise<FakeBankPortal> {
  const now = options.now ?? Date.now();
  const maskedAccount = "•••• 4821";
  const credits: FakeBankCredit[] = [
    { bookedAt: now - 5 * 60_000, amountCents: 62_000, reference: "PROP-OAK RENT" },
    { bookedAt: now - 8 * 60_000, amountCents: 77_700, reference: "UNMATCHED FIXTURE CREDIT" },
  ];
  const log: Array<{ method: string; path: string }> = [];
  let transfers = 0;
  let payees = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    log.push({ method, path: url.pathname });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; connect-src 'self'; form-action 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      res.end(loginPage());
      return;
    }
    if (method === "POST" && url.pathname === "/session") {
      readBody(req, res, (body) => {
        try {
          const value = JSON.parse(body || "{}") as { username?: unknown; password?: unknown };
          if (value.username !== FAKE_BANK_LOGIN.username || value.password !== FAKE_BANK_LOGIN.password) {
            return json(401, { error: "sign-in failed" });
          }
          res.writeHead(204, {
            "set-cookie": `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
            "cache-control": "no-store",
          });
          res.end();
        } catch {
          json(400, { error: "invalid JSON" });
        }
      });
      return;
    }
    if (method === "GET" && url.pathname === "/activity") {
      if (!authenticated(req)) return json(401, { error: "sign-in required" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; form-action 'none'; script-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      res.end(activityPage(maskedAccount, credits));
      return;
    }
    if (method === "POST" && url.pathname === "/transfer") {
      transfers += 1;
      return json(403, { error: "read-only session cannot transfer" });
    }
    if (method === "POST" && url.pathname === "/payees") {
      payees += 1;
      return json(403, { error: "read-only session cannot change payees" });
    }
    json(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        maskedAccount,
        credits,
        log,
        transferAttempts: () => transfers,
        payeeAttempts: () => payees,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
